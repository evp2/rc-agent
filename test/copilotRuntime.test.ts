import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chooseRuntime, sdkSessionConfig } from "../src/engine/copilot/runtime.ts";

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
