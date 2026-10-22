import type { ArchiveFileOutcome, EngineFile, OpenOptions } from "./types";

// What every Engine's `archive_file` tool says and returns, so the model sees
// the same tool whichever Engine runs the session.

export const ARCHIVE_FILE_DESCRIPTION =
  "Hand the human a file from this machine -- a build output, a report, an export. It is kept permanently " +
  "and appears in their transcript on their phone, where they can download it. Use it only when the human " +
  "asks to have, keep, download or be sent a file; never on your own initiative. One file per call: to hand " +
  "over a directory, zip or tar it first and archive the result.";

export const ARCHIVE_FILE_PATH_DESCRIPTION = "Path to the file. Absolute, or relative to the working directory.";

/** The tool's whole result when the file was archived. */
export function archivedText(filename: string, byteLength: number): string {
  return `Archived ${filename} (${formatBytes(byteLength)}); the human can download it from their transcript.`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Hands one call to `onArchiveFile`. A throw is a failure like any other, its message the reason. */
export async function forwardArchiveFile(
  onArchiveFile: NonNullable<OpenOptions["onArchiveFile"]>,
  file: EngineFile,
  signal: AbortSignal,
): Promise<ArchiveFileOutcome> {
  try {
    return await onArchiveFile(file, signal);
  } catch (e) {
    return { archived: false, reason: (e as Error).message };
  }
}
