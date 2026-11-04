import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { subagentGuardrailExtension } from "../src/engine/pi/guardrailExtension.ts";
import { guardrailExtensionPath, installedPi } from "../src/engine/pi/subagent.ts";

type Handler = (event: { type: string; payload?: unknown }) => unknown;

class Refused extends Error {}

function loaded(flags: Record<string, string | boolean | undefined>) {
  const registered = new Map<string, { type: string }>();
  const handlers = new Map<string, Handler>();
  const refusals: string[] = [];
  const pi = {
    registerFlag: (name: string, options: { type: string }) => registered.set(name, options),
    getFlag: (name: string) => (registered.has(name) ? flags[name] : undefined),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  };
  subagentGuardrailExtension((message) => {
    refusals.push(message);
    throw new Refused(message);
  })(pi as never);
  const fire = (event: string, payload?: unknown) => handlers.get(event)?.({ type: event, payload });
  return { registered, refusals, fire };
}

const VALID = { "bedrock-guardrail-id": "gr-abc123", "bedrock-guardrail-version": "DRAFT" };
const CONVERSE_REQUEST = { modelId: "anthropic.claude", messages: [] };

test("guardrail extension: registers its two flags as strings", () => {
  const { registered } = loaded(VALID);
  assert.equal(registered.get("bedrock-guardrail-id")?.type, "string");
  assert.equal(registered.get("bedrock-guardrail-version")?.type, "string");
});

test("guardrail extension: with both flags set, a Bedrock request carries the guardrail", () => {
  const { fire, refusals } = loaded(VALID);
  fire("session_start");
  assert.deepEqual(fire("before_provider_request", CONVERSE_REQUEST), {
    ...CONVERSE_REQUEST,
    guardrailConfig: { guardrailIdentifier: "gr-abc123", guardrailVersion: "DRAFT" },
  });
  assert.deepEqual(refusals, []);
});

for (const [what, flags] of [
  ["the identifier is missing", { "bedrock-guardrail-version": "DRAFT" }],
  ["the version is missing", { "bedrock-guardrail-id": "gr-abc123" }],
  ["the identifier is empty", { ...VALID, "bedrock-guardrail-id": "" }],
  ["the version is empty", { ...VALID, "bedrock-guardrail-version": "" }],
  ["a flag has no value", { ...VALID, "bedrock-guardrail-id": true }],
] as const) {
  test(`guardrail extension: when ${what}, the process is ended at session start and before any request`, () => {
    const { fire, refusals } = loaded(flags);
    assert.throws(() => fire("session_start"), Refused);
    assert.throws(() => fire("before_provider_request", CONVERSE_REQUEST), Refused);
    assert.equal(refusals.length, 2);
    assert.match(refusals[0], /bedrock-guardrail-(id|version)/);
  });
}

function runRealPi(guardFlags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const recorder = join(dir, "recorder.mjs");
  const sent = join(dir, "sent.json");
  writeFileSync(
    recorder,
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_provider_request", (event) => {
    writeFileSync(${JSON.stringify(sent)}, JSON.stringify(event.payload));
    process.exit(0);
  });
}
`,
  );
  const pi = installedPi();
  const child = spawnSync(
    pi.command,
    [
      ...pi.args,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--model",
      "amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "-e",
      guardrailExtensionPath()!,
      ...guardFlags,
      "-e",
      recorder,
    ],
    {
      cwd: dir,
      input: "hello",
      encoding: "utf8",
      timeout: 25_000,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "pi-agent-")),
        AWS_ACCESS_KEY_ID: "AKIATESTONLY",
        AWS_SECRET_ACCESS_KEY: "test-only",
        AWS_REGION: "us-east-1",
      },
    },
  );
  return { status: child.status, stderr: child.stderr, sent: existsSync(sent) ? JSON.parse(readFileSync(sent, "utf8")) : undefined };
}

test("guardrail extension: a real pi child with extensions disabled still loads it and sends the guardrail", { timeout: 30_000 }, () => {
  const run = runRealPi(["--bedrock-guardrail-id=gr-abc123", "--bedrock-guardrail-version=DRAFT"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.sent?.guardrailConfig, { guardrailIdentifier: "gr-abc123", guardrailVersion: "DRAFT" });
});

test("guardrail extension: a real pi child given an empty version exits non-zero without building a request", { timeout: 30_000 }, () => {
  const run = runRealPi(["--bedrock-guardrail-id=gr-abc123", "--bedrock-guardrail-version="]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /bedrock-guardrail-version/);
  assert.equal(run.sent, undefined);
});

test("guardrail extension: a real pi child given no guardrail flags exits non-zero without building a request", { timeout: 30_000 }, () => {
  const run = runRealPi([]);
  assert.notEqual(run.status, 0);
  assert.equal(run.sent, undefined);
});

test("guardrail extension: the source path resolves to this repo's entry when run from source", () => {
  assert.equal(guardrailExtensionPath(), fileURLToPath(new URL("../src/engine/pi/guardrailExtension.ts", import.meta.url)));
});
