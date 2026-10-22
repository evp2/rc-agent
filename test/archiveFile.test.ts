import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ArchiveFileOutcome, EngineFile } from "../src/engine/types.ts";
import { runTurn } from "../src/session/turn.ts";
import { cmd, makeTurnHarness, type FakeRelay, type TurnHarness } from "./doubles.ts";

/**
 * Runs one Turn whose body archives `file` and reports what `archive_file`
 * returned to the Engine. `arrange` sets the fake relay up first, for the
 * cases where the relay or S3 misbehaves.
 */
async function archiveInTurn(
  file: EngineFile,
  arrange: (relay: FakeRelay) => void = () => {},
): Promise<{ h: TurnHarness; outcome: ArchiveFileOutcome }> {
  let outcome: ArchiveFileOutcome | undefined;
  const h = await makeTurnHarness({
    handlerFor: () => async (turn) => {
      outcome = await turn.archiveFile(file);
    },
  });
  arrange(h.relay);
  await runTurn(h.ctx, cmd("archive the build"));
  return { h, outcome: outcome! };
}

function withBuild(name: string, contents: string): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("archiving a file signs an upload under its own name, sends the file to S3, and emits exactly one archived_file Event", async () => {
  const build = withBuild("app.exe", "MZ not really a program");
  try {
    const { h, outcome } = await archiveInTurn({ toolUseId: "toolu_file", path: build.path });

    assert.deepEqual(outcome, { archived: true, filename: "app.exe", byteLength: 23 });
    assert.deepEqual(h.relay.signedFiles, [{ filename: "app.exe", byteLength: 23 }]);
    assert.deepEqual(h.relay.uploadedFiles, [{ fileId: "file-1", path: build.path }]);
    assert.deepEqual(
      h.relay.posted.filter((e) => e.type === "archived_file"),
      [
        {
          type: "archived_file",
          file_id: "file-1",
          tool_use_id: "toolu_file",
          filename: "app.exe",
          byte_length: 23,
        },
      ],
    );
    await h.close();
  } finally {
    build.cleanup();
  }
});

test("a path relative to the working directory is archived from there", async () => {
  const build = withBuild("report.csv", "a,b\n");
  try {
    let outcome: ArchiveFileOutcome | undefined;
    const h = await makeTurnHarness({
      handlerFor: () => async (turn) => {
        outcome = await turn.archiveFile({ toolUseId: "toolu_file", path: "report.csv" });
      },
      projectDir: join(build.path, ".."),
    });
    await runTurn(h.ctx, cmd("archive the report"));

    assert.deepEqual(outcome, { archived: true, filename: "report.csv", byteLength: 4 });
    assert.deepEqual(h.relay.uploadedFiles, [{ fileId: "file-1", path: build.path }]);
    await h.close();
  } finally {
    build.cleanup();
  }
});

test("the archived_file Event reaches the relay after the archive_file call it belongs to", async () => {
  const build = withBuild("app.exe", "MZ");
  try {
    const { h } = await archiveInTurn({ toolUseId: "toolu_file", path: build.path });

    const toolUse = h.relay.posted.findIndex((e) => e.type === "tool_use" && e.tool_use_id === "toolu_file");
    const archived = h.relay.posted.findIndex((e) => e.type === "archived_file");
    assert.ok(toolUse >= 0, "the tool_use was posted");
    assert.ok(archived > toolUse, "the archived_file Event follows its tool_use");
    await h.close();
  } finally {
    build.cleanup();
  }
});
