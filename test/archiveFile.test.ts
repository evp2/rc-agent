import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ArchiveFileOutcome, EngineFile } from "../src/engine/types.ts";
import { runTurn } from "../src/session/turn.ts";
import { cmd, makeTurnHarness, until, type FakeRelay, type TurnHarness } from "./doubles.ts";

/**
 * Runs one Turn whose body archives `file` and reports what `archive_file`
 * returned to the Engine. `arrange` sets the fake relay up first, for the
 * cases where the relay or S3 misbehaves.
 */
async function archiveInTurn(
  file: EngineFile,
  arrange: (relay: FakeRelay) => void = () => {},
  withHarness: (h: TurnHarness) => void = () => {},
): Promise<{ h: TurnHarness; outcome: ArchiveFileOutcome }> {
  let outcome: ArchiveFileOutcome | undefined;
  const h = await makeTurnHarness({
    handlerFor: () => async (turn) => {
      outcome = await turn.archiveFile(file);
    },
  });
  arrange(h.relay);
  withHarness(h);
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

function archivedEvents(h: TurnHarness) {
  return h.relay.posted.filter((e) => e.type === "archived_file");
}

/** Archives `path` in a Turn and asserts it failed with nothing signed and no Event. */
async function assertTurnedAwayBeforeSigning(path: string, reason: RegExp): Promise<void> {
  const { h, outcome } = await archiveInTurn({ toolUseId: "toolu_file", path });
  assert.equal(outcome.archived, false);
  assert.match((outcome as { reason: string }).reason, reason);
  assert.deepEqual(h.relay.signedFiles, []);
  assert.deepEqual(archivedEvents(h), []);
  await h.close();
}

test("a path with no file behind it tells the Engine to check the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  try {
    const missing = join(dir, "nope.exe");
    await assertTurnedAwayBeforeSigning(missing, new RegExp(`^no file at ${missing}; check the path$`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file this process can't read says it couldn't read it", { skip: process.getuid?.() === 0 }, async () => {
  const build = withBuild("secret.bin", "x");
  try {
    chmodSync(build.path, 0o000);
    await assertTurnedAwayBeforeSigning(build.path, new RegExp(`^couldn't read ${build.path}`));
  } finally {
    build.cleanup();
  }
});

test("a directory is turned away with advice to zip or tar it and archive the result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  try {
    await assertTurnedAwayBeforeSigning(dir, /zip or tar it first and archive the result/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anything else that isn't a regular file is turned away the same way", async () => {
  await assertTurnedAwayBeforeSigning("/dev/null", /zip or tar it first and archive the result/);
});

test("a symlink to a regular file is followed and the file behind it archived", async () => {
  const build = withBuild("app.exe", "MZ1234");
  try {
    const link = join(build.path, "..", "latest.exe");
    symlinkSync(build.path, link);
    const { h, outcome } = await archiveInTurn({ toolUseId: "toolu_file", path: link });

    assert.deepEqual(outcome, { archived: true, filename: "latest.exe", byteLength: 6 });
    assert.equal(archivedEvents(h).length, 1);
    await h.close();
  } finally {
    build.cleanup();
  }
});

test("a file over 500MB is turned away before any upload, with advice to split or compress it", async () => {
  const build = withBuild("huge.iso", "");
  try {
    truncateSync(build.path, 500 * 1024 * 1024 + 1);
    await assertTurnedAwayBeforeSigning(build.path, /split or compress it/);
  } finally {
    build.cleanup();
  }
});

test("an empty file archives", async () => {
  const build = withBuild(".keep", "");
  try {
    const { h, outcome } = await archiveInTurn({ toolUseId: "toolu_file", path: build.path });

    assert.deepEqual(outcome, { archived: true, filename: ".keep", byteLength: 0 });
    assert.equal(archivedEvents(h)[0]?.byte_length, 0);
    await h.close();
  } finally {
    build.cleanup();
  }
});

test("a file whose size changes during the upload fails with advice to retry, and emits no Event", async () => {
  const build = withBuild("app.log", "line 1\n");
  try {
    const { h, outcome } = await archiveInTurn({ toolUseId: "toolu_file", path: build.path }, (relay) => {
      relay.duringFileUpload = async (path) => appendFileSync(path, "line 2\n");
    });

    assert.deepEqual(outcome, {
      archived: false,
      reason: `${build.path} changed while it was being uploaded; try again once it's finished writing`,
    });
    assert.deepEqual(archivedEvents(h), []);
    await h.close();
  } finally {
    build.cleanup();
  }
});

for (const [label, arrange, reason] of [
  [
    "a refused signing request",
    (relay: FakeRelay) => (relay.failNextSign = new Error("HTTP 400 too big")),
    /^the relay didn't sign the upload: HTTP 400 too big$/,
  ],
  [
    "a failed upload",
    (relay: FakeRelay) => {
      relay.duringFileUpload = async () => {
        throw new Error("HTTP 400 EntityTooLarge");
      };
    },
    /^the upload to storage failed: HTTP 400 EntityTooLarge$/,
  ],
  [
    "a rejected Event",
    (relay: FakeRelay) => (relay.rejectArchivedFileEvents = new Error("HTTP 400 unknown file_id")),
    /^the relay didn't accept the archived_file Event: HTTP 400 unknown file_id$/,
  ],
] as const) {
  test(`${label} returns an error and emits no Event`, async () => {
    const build = withBuild("app.exe", "MZ");
    try {
      const { h, outcome } = await archiveInTurn({ toolUseId: "toolu_file", path: build.path }, arrange);

      assert.equal(outcome.archived, false);
      assert.match((outcome as { reason: string }).reason, reason);
      assert.deepEqual(archivedEvents(h), []);
      await h.close();
    } finally {
      build.cleanup();
    }
  });
}

test("interrupting the Turn aborts the upload in progress, and no Event follows", async () => {
  const build = withBuild("app.exe", "MZ");
  try {
    let uploadSignal: AbortSignal | undefined;
    let h: TurnHarness | undefined;
    const result = await archiveInTurn({ toolUseId: "toolu_file", path: build.path }, (relay) => {
      relay.duringFileUpload = async (_path, signal) => {
        uploadSignal = signal;
        h!.ctx.currentTurn!.abortController.abort();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw signal.reason;
      };
    }, (harness) => (h = harness));

    assert.equal(uploadSignal?.aborted, true);
    assert.equal(result.outcome.archived, false);
    assert.deepEqual(archivedEvents(result.h), []);
    await result.h.close();
  } finally {
    build.cleanup();
  }
});

test("an Interrupt landing just as the upload finishes still emits no Event", async () => {
  const build = withBuild("app.exe", "MZ");
  try {
    let h: TurnHarness | undefined;
    const result = await archiveInTurn({ toolUseId: "toolu_file", path: build.path }, (relay) => {
      relay.duringFileUpload = async (_path, signal) => {
        h!.ctx.currentTurn!.abortController.abort();
        await until(() => signal.aborted);
      };
    }, (harness) => (h = harness));

    assert.equal(result.outcome.archived, false);
    assert.deepEqual(archivedEvents(result.h), []);
    await result.h.close();
  } finally {
    build.cleanup();
  }
});
