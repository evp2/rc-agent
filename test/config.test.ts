import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { engineKindFor, loadConfig } from "../src/config.ts";
import { createEngine } from "../src/engine/create.ts";

function writeConfig(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-config-"));
  const path = join(dir, "connector.config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const base = {
  relayBaseUrl: "https://relay.test",
  connectorCredential: "testCred0001",
  provider: { type: "anthropic" },
};

test("inactivityCompact is absent by default, leaving the feature off", () => {
  const config = loadConfig(writeConfig(base));
  assert.equal(config.inactivityCompact, undefined);
});

test("a valid inactivityCompact.afterMinutes is accepted", () => {
  const config = loadConfig(writeConfig({ ...base, inactivityCompact: { afterMinutes: 30 } }));
  assert.deepEqual(config.inactivityCompact, { afterMinutes: 30 });
});

test("afterMinutes below the 5-minute floor is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, inactivityCompact: { afterMinutes: 4 } })),
    /afterMinutes.*>= 5/,
  );
});

test("a non-numeric afterMinutes is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, inactivityCompact: { afterMinutes: "30" } })),
    /afterMinutes/,
  );
});

test("a non-object inactivityCompact is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, inactivityCompact: "30m" })),
    /inactivityCompact.*object/,
  );
});

test("contextWarningThresholdPercent is absent by default, leaving the 70% default in force", () => {
  const config = loadConfig(writeConfig(base));
  assert.equal(config.contextWarningThresholdPercent, undefined);
});

test("a valid contextWarningThresholdPercent is accepted", () => {
  const config = loadConfig(writeConfig({ ...base, contextWarningThresholdPercent: 55 }));
  assert.equal(config.contextWarningThresholdPercent, 55);
});

test("a contextWarningThresholdPercent of 100 is accepted", () => {
  const config = loadConfig(writeConfig({ ...base, contextWarningThresholdPercent: 100 }));
  assert.equal(config.contextWarningThresholdPercent, 100);
});

test("a contextWarningThresholdPercent of 0 is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, contextWarningThresholdPercent: 0 })),
    /contextWarningThresholdPercent.*between 1 and 100/,
  );
});

test("a contextWarningThresholdPercent above 100 is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, contextWarningThresholdPercent: 101 })),
    /contextWarningThresholdPercent.*between 1 and 100/,
  );
});

test("a non-numeric contextWarningThresholdPercent is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, contextWarningThresholdPercent: "70" })),
    /contextWarningThresholdPercent/,
  );
});

test("an anthropic provider means the Claude Engine", () => {
  assert.equal(engineKindFor(loadConfig(writeConfig(base))), "claude");
});

test("a bedrock provider means the Claude Engine", () => {
  const config = loadConfig(writeConfig({ ...base, provider: { type: "bedrock", region: "us-east-1" } }));
  assert.equal(engineKindFor(config), "claude");
});

test("a copilot provider defaults its model to auto and its CLI to the one on the PATH, and runs on Copilot", () => {
  const config = loadConfig(writeConfig({ ...base, provider: { type: "copilot" } }));
  assert.deepEqual(config.provider, { type: "copilot", model: "auto", cliPath: undefined });
  assert.equal(engineKindFor(config), "copilot");
});

test("a copilot provider keeps a configured model and CLI path", () => {
  const config = loadConfig(
    writeConfig({ ...base, provider: { type: "copilot", model: "gpt-5.6-luna", cliPath: "/opt/copilot/bin/copilot" } }),
  );
  assert.deepEqual(config.provider, { type: "copilot", model: "gpt-5.6-luna", cliPath: "/opt/copilot/bin/copilot" });
});

test("a config without an engine leaves it absent", () => {
  assert.equal(loadConfig(writeConfig(base)).engine, undefined);
});

test("an explicit engine is kept and decides the Engine", () => {
  const claude = loadConfig(writeConfig({ ...base, engine: "claude", provider: { type: "bedrock" } }));
  assert.equal(claude.engine, "claude");
  assert.equal(engineKindFor(claude), "claude");

  const copilot = loadConfig(writeConfig({ ...base, engine: "copilot", provider: { type: "copilot" } }));
  assert.equal(copilot.engine, "copilot");
  assert.equal(engineKindFor(copilot), "copilot");
});

test("an unknown engine is rejected, naming the ones allowed", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, engine: "made_up" })),
    { message: "'engine' must be one of: claude, copilot, pi (got \"made_up\")" },
  );
});

test("an engine that cannot run on the configured provider is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, engine: "copilot", provider: { type: "anthropic" } })),
    { message: "'engine' is \"copilot\", which cannot run on provider.type 'anthropic'; use provider.type 'copilot'" },
  );
  assert.throws(
    () => loadConfig(writeConfig({ ...base, engine: "claude", provider: { type: "copilot" } })),
    { message: "'engine' is \"claude\", which cannot run on provider.type 'copilot'; use provider.type 'anthropic' or 'bedrock'" },
  );
});

test("the Engine factory builds the adapter the explicit engine names", () => {
  const config = loadConfig(writeConfig({ ...base, engine: "copilot", provider: { type: "copilot" } }));
  assert.equal(createEngine(config).kind, "copilot");
});

test("a pi engine runs on any of the three providers, and without a model leaves the choice to Pi", () => {
  for (const type of ["anthropic", "bedrock", "copilot"]) {
    const config = loadConfig(writeConfig({ ...base, engine: "pi", provider: { type } }));
    assert.deepEqual(config.provider, { type });
    assert.equal(engineKindFor(config), "pi");
    assert.equal(createEngine(config).kind, "pi");
  }
});

test("a pi engine keeps a configured model and thinking level", () => {
  const config = loadConfig(
    writeConfig({
      ...base,
      engine: "pi",
      provider: { type: "copilot", model: "claude-sonnet-4.5", thinkingLevel: "high" },
    }),
  );
  assert.deepEqual(config.provider, { type: "copilot", model: "claude-sonnet-4.5", thinkingLevel: "high" });
});

test("a pi engine rejects a thinking level Pi doesn't have, naming the ones it does", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, engine: "pi", provider: { type: "anthropic", thinkingLevel: "extreme" } })),
    { message: "'provider.thinkingLevel' must be one of: off, minimal, low, medium, high, xhigh, max (got \"extreme\")" },
  );
});

test("the Engine factory falls back to the provider when no engine is configured", () => {
  assert.equal(createEngine(loadConfig(writeConfig(base))).kind, "claude");
  assert.equal(createEngine(loadConfig(writeConfig({ ...base, provider: { type: "copilot" } }))).kind, "copilot");
});

test("a missing connectorCredential is rejected with how to obtain one", () => {
  const { connectorCredential: _, ...withoutCredential } = base;
  assert.throws(
    () => loadConfig(writeConfig(withoutCredential)),
    /connectorCredential.*missing.*mint-credential/s,
  );
});

test("a connectorCredential that is not a minted credential is rejected", () => {
  for (const connectorCredential of ["YOUR_CONNECTOR_CREDENTIAL", " Xk3mQ9pRtL7b", "Xk3mQ9pRtL7", "Xk3mQ9-RtL7b"]) {
    assert.throws(
      () => loadConfig(writeConfig({ ...base, connectorCredential })),
      /connectorCredential.*12 letters and digits/s,
      connectorCredential,
    );
  }
});

test("a plain-http relayBaseUrl is rejected so the credential never crosses the network unencrypted", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, relayBaseUrl: "http://relay.example.com/test" })),
    /relayBaseUrl.*https:\/\//s,
  );
});

test("a plain-http relayBaseUrl on loopback is accepted for a locally run relay", () => {
  for (const relayBaseUrl of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
    assert.equal(loadConfig(writeConfig({ ...base, relayBaseUrl })).relayBaseUrl, relayBaseUrl);
  }
});

test("relayBaseUrl may be omitted, leaving the relay to be looked up", () => {
  const { relayBaseUrl: _omitted, ...withoutRelay } = base;
  const config = loadConfig(writeConfig(withoutRelay));
  assert.equal(config.relayBaseUrl, undefined);
  assert.equal(config.relayLookupUrl, undefined);
});

test("relayLookupUrl is accepted and normalised like relayBaseUrl", () => {
  const config = loadConfig(writeConfig({ ...base, relayLookupUrl: "https://lookup.test/api/" }));
  assert.equal(config.relayLookupUrl, "https://lookup.test/api");
});

test("a plain-http relayLookupUrl for a non-local host is rejected", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, relayLookupUrl: "http://lookup.example.com/api" })),
    /relayLookupUrl.*https/,
  );
});

test("a pi engine keeps subagent profiles: a default and named ones", () => {
  const subagents = {
    default: { model: "anthropic/claude-haiku-5-5", thinkingLevel: "low" },
    profiles: { review: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high", description: "Careful code review" } },
  };
  const config = loadConfig(writeConfig({ ...base, engine: "pi", provider: { type: "anthropic", subagents } }));
  assert.deepEqual(config.provider, { type: "anthropic", subagents });
});

test("subagent profiles reject a misspelt key, naming it and where it was", () => {
  assert.throws(
    () =>
      loadConfig(
        writeConfig({ ...base, engine: "pi", provider: { type: "anthropic", subagents: { profiles: { fast: { modle: "x" } } } } }),
      ),
    { message: "'provider.subagents.profiles.fast' has unknown key: modle" },
  );
});

test("a subagent profile rejects a thinking level Pi doesn't have, naming the profile", () => {
  assert.throws(
    () =>
      loadConfig(
        writeConfig({
          ...base,
          engine: "pi",
          provider: { type: "anthropic", subagents: { default: { thinkingLevel: "extreme" } } },
        }),
      ),
    {
      message:
        "'provider.subagents.default.thinkingLevel' must be one of: off, minimal, low, medium, high, xhigh, max (got \"extreme\")",
    },
  );
});

test("subagent profiles are rejected on an engine that isn't pi", () => {
  assert.throws(
    () => loadConfig(writeConfig({ ...base, provider: { type: "anthropic", subagents: { default: { model: "x" } } } })),
    { message: "'provider.subagents' is only supported by the pi engine" },
  );
});

test("a subagent profile can't be named default, since that name is the profile used when none is named", () => {
  assert.throws(
    () =>
      loadConfig(
        writeConfig({ ...base, engine: "pi", provider: { type: "anthropic", subagents: { profiles: { default: {} } } } }),
      ),
    { message: "'provider.subagents.profiles' can't have a profile named 'default'; set 'provider.subagents.default' instead" },
  );
});

test("the Claude Engine keeps a configured Claude executable, on either of its providers", () => {
  for (const type of ["anthropic", "bedrock"]) {
    const config = loadConfig(writeConfig({ ...base, provider: { type, claudeExecutable: "/opt/claude/bin/claude" } }));
    assert.equal((config.provider as { claudeExecutable?: string }).claudeExecutable, "/opt/claude/bin/claude");
  }
});

test("a Claude executable is absent unless configured", () => {
  assert.equal("claudeExecutable" in loadConfig(writeConfig(base)).provider, false);
});

test("a Claude executable is rejected on an engine that isn't claude, naming where it is allowed", () => {
  for (const config of [
    { ...base, engine: "pi", provider: { type: "anthropic", claudeExecutable: "/opt/claude" } },
    { ...base, provider: { type: "copilot", claudeExecutable: "/opt/claude" } },
  ]) {
    assert.throws(() => loadConfig(writeConfig(config)), {
      message: "'provider.claudeExecutable' is only supported by the claude engine",
    });
  }
});

test("an empty or non-string Claude executable is rejected, naming the field", () => {
  for (const claudeExecutable of ["", 42, ["/opt/claude"]]) {
    assert.throws(
      () => loadConfig(writeConfig({ ...base, provider: { type: "anthropic", claudeExecutable } })),
      { message: "'provider.claudeExecutable' must be a non-empty string" },
      JSON.stringify(claudeExecutable),
    );
  }
});
const GUARDRAIL_PLACEMENT = "'provider.guardrail' is only supported by the pi engine with provider.type 'bedrock'";

test("a pi engine on bedrock keeps a guardrail, with a DRAFT or numbered version", () => {
  for (const version of ["DRAFT", "3"]) {
    const guardrail = { identifier: "gr-abc123", version };
    const config = loadConfig(writeConfig({ ...base, engine: "pi", provider: { type: "bedrock", guardrail } }));
    assert.deepEqual(config.provider, { type: "bedrock", guardrail });
  }
});

test("a guardrail is rejected anywhere but the pi engine on bedrock, saying where it is allowed", () => {
  const guardrail = { identifier: "gr-abc123", version: "1" };
  const elsewhere = [
    { provider: { type: "bedrock", guardrail } },
    { engine: "claude", provider: { type: "anthropic", guardrail } },
    { engine: "copilot", provider: { type: "copilot", guardrail } },
    { engine: "pi", provider: { type: "anthropic", guardrail } },
    { engine: "pi", provider: { type: "copilot", guardrail } },
  ];
  for (const config of elsewhere) {
    assert.throws(() => loadConfig(writeConfig({ ...base, ...config })), { message: GUARDRAIL_PLACEMENT });
  }
});

test("a guardrail with an empty or missing identifier or version is rejected, naming the field", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ identifier: "", version: "1" }, "identifier"],
    [{ version: "1" }, "identifier"],
    [{ identifier: "gr-abc123", version: "" }, "version"],
    [{ identifier: "gr-abc123" }, "version"],
    [{ identifier: "gr-abc123", version: 1 }, "version"],
  ];
  for (const [guardrail, field] of cases) {
    assert.throws(
      () => loadConfig(writeConfig({ ...base, engine: "pi", provider: { type: "bedrock", guardrail } })),
      { message: `'provider.guardrail.${field}' is required and must be a non-empty string` },
    );
  }
});

test("a guardrail that isn't an object, or has a misspelt key, is rejected", () => {
  const pi = (guardrail: unknown) => () =>
    loadConfig(writeConfig({ ...base, engine: "pi", provider: { type: "bedrock", guardrail } }));
  assert.throws(pi("gr-abc123"), { message: "'provider.guardrail' must be an object" });
  assert.throws(pi({ identifier: "gr-abc123", version: "1", verison: "2" }), {
    message: "'provider.guardrail' has unknown key: verison",
  });
});
