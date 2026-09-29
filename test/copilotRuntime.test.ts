import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chooseRuntime, resolveModelSettings, sdkSessionConfig } from "../src/engine/copilot/runtime.ts";

function binDirWithCopilot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-copilot-bin-"));
  const path = join(dir, "copilot");
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return dir;
}

test("with no token, the connector runs the installed copilot CLI found on the PATH", () => {
  const bin = binDirWithCopilot();
  assert.deepEqual(chooseRuntime({ type: "copilot", model: "auto" }, { PATH: `/nowhere:${bin}` }), {
    kind: "installed",
    path: join(bin, "copilot"),
  });
});

test("a configured cliPath is used instead of the PATH", () => {
  assert.deepEqual(
    chooseRuntime({ type: "copilot", model: "auto", cliPath: "/opt/copilot/bin/copilot" }, { PATH: "" }),
    { kind: "installed", path: "/opt/copilot/bin/copilot" },
  );
});

test("with COPILOT_GITHUB_TOKEN set, the connector runs the bundled runtime on that token", () => {
  assert.deepEqual(
    chooseRuntime({ type: "copilot", model: "auto" }, { PATH: "", COPILOT_GITHUB_TOKEN: "github_pat_x" }),
    { kind: "bundled", token: "github_pat_x" },
  );
});

test("with no token and no copilot on the PATH, startup says how to fix it", () => {
  assert.throws(
    () => chooseRuntime({ type: "copilot", model: "auto" }, { PATH: "/nowhere" }),
    /Can't find the 'copilot' executable.*provider\.cliPath/s,
  );
});

test("a session asks its questions as a single question with choices, and declines JSON-schema forms", async () => {
  const config = sdkSessionConfig({
    model: "auto",
    workingDirectory: "/p",
    onPermissionRequest: () => ({ kind: "approve-once" }),
    onUserInputRequest: async () => ({ answer: "x", wasFreeform: false }),
  });
  assert.equal(config.askUserVariant, "legacy");
  assert.equal(typeof config.onUserInputRequest, "function");
  assert.deepEqual(await config.onElicitationRequest(), { action: "decline" });
  assert.equal(config.enableConfigDiscovery, true, "the project's Skills load");
});

test("a session hands Copilot the connector's own tools, and none when there are none", () => {
  const base = {
    model: "auto",
    workingDirectory: "/p",
    onPermissionRequest: () => ({ kind: "approve-once" as const }),
    onUserInputRequest: async () => ({ answer: "x", wasFreeform: false }),
  };
  const tools = [{ name: "show_image", handler: () => "ok" }];
  assert.deepEqual(sdkSessionConfig({ ...base, tools }).tools, tools);
  assert.equal("tools" in sdkSessionConfig(base), false);
});

test("saved effort is passed only when the model lists that level", () => {
  const model = { supportedReasoningEfforts: ["low", "high"] as ("low" | "high")[] };
  assert.deepEqual(resolveModelSettings({ effortLevel: "high" }, model), { reasoningEffort: "high" });
  assert.deepEqual(resolveModelSettings({ effortLevel: "max" }, model), {});
  assert.deepEqual(resolveModelSettings({ effortLevel: "high" }, {}), {}, "auto lists none, and refuses one");
  assert.deepEqual(resolveModelSettings({ effortLevel: "high" }, undefined), {});
  assert.deepEqual(resolveModelSettings({ effortLevel: null }, model), {}, "unset settings come back null");
});

test("a saved context tier is passed when it is one Copilot knows", () => {
  assert.deepEqual(resolveModelSettings({ contextTier: "long_context" }, undefined), { contextTier: "long_context" });
  assert.deepEqual(resolveModelSettings({ contextTier: "huge" }, undefined), {});
  assert.deepEqual(resolveModelSettings({ contextTier: null }, undefined), {});
});

test("a session config carries effort and tier only when there are some", () => {
  const base = {
    model: "m",
    workingDirectory: "/p",
    onPermissionRequest: () => ({ kind: "approve-once" as const }),
    onUserInputRequest: async () => ({ answer: "x", wasFreeform: false }),
  };
  const config = sdkSessionConfig({ ...base, reasoningEffort: "low", contextTier: "long_context" });
  assert.equal(config.reasoningEffort, "low");
  assert.equal(config.contextTier, "long_context");
  assert.equal("reasoningEffort" in sdkSessionConfig(base), false);
  assert.equal("contextTier" in sdkSessionConfig(base), false);
});
