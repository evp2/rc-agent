import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ArchiveFileOutcome, EngineFile } from "../engine/types";
import type { SessionContext } from "./context";
import { postAfterBuffered } from "./events";

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

  let byteLength: number;
  try {
    byteLength = (await stat(path)).size;
  } catch (e) {
    return { archived: false, reason: `couldn't read ${path}: ${(e as Error).message}` };
  }

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
  try {
    await ctx.client.uploadFile(upload, path, signal);
  } catch (e) {
    return failed("the upload to storage failed", e);
  }
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
