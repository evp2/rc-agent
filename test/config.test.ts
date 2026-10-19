import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { engineKindFor, loadConfig } from "../src/config.ts";

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
  assert.equal(engineKindFor(loadConfig(writeConfig(base)).provider), "claude");
});

test("a bedrock provider means the Claude Engine", () => {
  const config = loadConfig(writeConfig({ ...base, provider: { type: "bedrock", region: "us-east-1" } }));
  assert.equal(engineKindFor(config.provider), "claude");
});

test("a copilot provider defaults its model to auto and its CLI to the one on the PATH, and runs on Copilot", () => {
  const config = loadConfig(writeConfig({ ...base, provider: { type: "copilot" } }));
  assert.deepEqual(config.provider, { type: "copilot", model: "auto", cliPath: undefined });
  assert.equal(engineKindFor(config.provider), "copilot");
});

test("a copilot provider keeps a configured model and CLI path", () => {
  const config = loadConfig(
    writeConfig({ ...base, provider: { type: "copilot", model: "gpt-5.6-luna", cliPath: "/opt/copilot/bin/copilot" } }),
  );
  assert.deepEqual(config.provider, { type: "copilot", model: "gpt-5.6-luna", cliPath: "/opt/copilot/bin/copilot" });
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
