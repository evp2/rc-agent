import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ArchiveFileOutcome, EngineFile } from "../engine/types";
import type { SessionContext } from "./context";
import { postAfterBuffered } from "./events";

/** The same cap S3's signed policy enforces; checking it here first spares a doomed upload. */
const MAX_ARCHIVED_FILE_MB = 500;
const MAX_ARCHIVED_FILE_BYTES = MAX_ARCHIVED_FILE_MB * 1024 * 1024;

/**
 * Stats the file behind an `archive_file` call, following symlinks, and
 * checks it is a readable regular file within the cap. Never opens it, so a
 * FIFO can't block the call.
 */
async function checkFile(path: string): Promise<{ byteLength: number } | { reason: string }> {
  let stats;
  try {
    stats = await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { reason: `no file at ${path}; check the path` };
    return { reason: `couldn't read ${path}: ${(e as Error).message}` };
  }
  if (!stats.isFile()) {
    const what = stats.isDirectory() ? "is a directory" : "isn't a regular file";
    return { reason: `${path} ${what}; zip or tar it first and archive the result` };
  }
  if (stats.size > MAX_ARCHIVED_FILE_BYTES) {
    const mb = (stats.size / (1024 * 1024)).toFixed(1);
    return { reason: `${path} is ${mb}MB, over the ${MAX_ARCHIVED_FILE_MB}MB limit for an archived file; split or compress it` };
  }
  try {
    await access(path, constants.R_OK);
  } catch (e) {
    return { reason: `couldn't read ${path}: ${(e as Error).message}` };
  }
  return { byteLength: stats.size };
}

/** Whether the file's size no longer matches what was signed, as when it is still being written. */
async function sizeChanged(path: string, byteLength: number): Promise<boolean> {
  try {
    return (await stat(path)).size !== byteLength;
  } catch {
    return true;
  }
}

/**
 * Carries out one `archive_file` call: has the relay sign an upload under
 * the file's own name, streams the file straight to S3, and only then
 * reports the `archived_file` Event. Any failure along the way comes back as
 * a reason the Engine can act on, and emits no Event.
 *
 * Any path this process can read is allowed, for the same reason as
 * `show_image`: permissions are always bypassed, so a restriction would
 * protect nothing.
 */
export async function archiveFile(
  ctx: SessionContext,
  file: EngineFile,
  signal: AbortSignal,
): Promise<ArchiveFileOutcome> {
  const path = resolve(ctx.config.projectDir, file.path);
  const filename = basename(path);

  const checked = await checkFile(path);
  if ("reason" in checked) return { archived: false, reason: checked.reason };
  const { byteLength } = checked;

  const failed = (stage: string, e: unknown): ArchiveFileOutcome => ({
    archived: false,
    reason: `${stage}: ${(e as Error).message}`,
  });

  let upload;
  try {
    upload = await ctx.client.signFileUpload(filename, byteLength);
  } catch (e) {
    return failed("the relay didn't sign the upload", e);
  }
  const changed: ArchiveFileOutcome = {
    archived: false,
    reason: `${path} changed while it was being uploaded; try again once it's finished writing`,
  };
  const stopped: ArchiveFileOutcome = { archived: false, reason: "stopped before the file was archived" };
  try {
    await ctx.client.uploadFile(upload, path, signal);
  } catch (e) {
    if (signal.aborted) return stopped;
    // A Blob read from a file that changed underneath it fails the upload with a bare read error.
    if (await sizeChanged(path, byteLength)) return changed;
    return failed("the upload to storage failed", e);
  }
  if (signal.aborted) return stopped;
  if (await sizeChanged(path, byteLength)) return changed;
  try {
    await postAfterBuffered(ctx, {
      type: "archived_file",
      file_id: upload.fileId,
      tool_use_id: file.toolUseId,
      filename,
      byte_length: byteLength,
    });
  } catch (e) {
    return failed("the relay didn't accept the archived_file Event", e);
  }
  return { archived: true, filename, byteLength };
}
