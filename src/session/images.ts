import { open } from "node:fs/promises";
import { resolve } from "node:path";

import type { EngineImage, ShowImageOutcome } from "../engine/types";
import type { SessionContext } from "./context";
import { postAfterBuffered } from "./events";

/** The same cap S3's signed policy enforces; checking it here first spares a doomed upload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The only types an Image can be, each recognised by its leading bytes and
 * never by the file's extension, so a renamed file can't pass as an Image.
 * SVG is deliberately absent: it can carry script to the phone.
 */
const SIGNATURES: { contentType: string; matches: (b: Uint8Array) => boolean }[] = [
  { contentType: "image/png", matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { contentType: "image/gif", matches: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")) },
  // RIFF, then a four-byte length, then the WEBP form type.
  { contentType: "image/webp", matches: (b) => startsWith(b, ascii("RIFF")) && startsWith(b.subarray(8), ascii("WEBP")) },
];

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Reads the file behind a `show_image` call, checking its type from its
 * leading bytes and then its size before the whole of it is read, so a huge
 * file is turned away without being loaded.
 */
async function readImage(path: string): Promise<{ bytes: Uint8Array; contentType: string } | { reason: string }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { reason: `no file at ${path}; check the path` };
    return { reason: `couldn't read ${path}: ${(e as Error).message}` };
  }
  try {
    const { size } = await handle.stat();
    const head = new Uint8Array(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const contentType = SIGNATURES.find((s) => s.matches(head.subarray(0, bytesRead)))?.contentType;
    if (!contentType) {
      return {
        reason: `${path} is not a PNG, JPEG, GIF or WebP image, the only types that can be shown; convert it to one of those, or show something else`,
      };
    }
    if (size > MAX_IMAGE_BYTES) {
      return {
        reason: `${path} is ${megabytes(size)}, over the 10MB limit for an image; take a smaller screenshot or crop it`,
      };
    }
    const bytes = new Uint8Array(size);
    await handle.read(bytes, 0, size, 0);
    return { bytes, contentType };
  } catch (e) {
    return { reason: `couldn't read ${path}: ${(e as Error).message}` };
  } finally {
    await handle.close();
  }
}

/**
 * Carries out one `show_image` call: reads the file, checks it really is an
 * image, has the relay sign an upload, sends the bytes straight to S3, and
 * only then reports the `image` Event. Any failure along the way comes back
 * as a reason the Engine can act on, and emits no Event.
 *
 * Any path this process can read is allowed. Permissions are always
 * bypassed, so the Engine could copy the file somewhere allowed anyway, and a
 * restriction would protect nothing.
 */
export async function showImage(
  ctx: SessionContext,
  image: EngineImage,
  signal: AbortSignal,
): Promise<ShowImageOutcome> {
  const path = resolve(ctx.config.projectDir, image.path);

  const read = await readImage(path);
  if ("reason" in read) return { shown: false, reason: read.reason };
  const { bytes, contentType } = read;

  // Each stage names itself in the reason, so the Engine can tell a refused
  // signature from a failed upload from a refused Event, and retry or report.
  const failed = (stage: string, e: unknown): ShowImageOutcome => ({
    shown: false,
    reason: `${stage}: ${(e as Error).message}`,
  });

  let upload;
  try {
    upload = await ctx.client.signImageUpload(contentType, bytes.length);
  } catch (e) {
    return failed("the relay didn't sign the upload", e);
  }
  if (signal.aborted) return { shown: false, reason: "stopped before the image was sent" };
  try {
    await ctx.client.uploadImage(upload, bytes, contentType);
  } catch (e) {
    return failed("the upload to storage failed", e);
  }
  if (signal.aborted) return { shown: false, reason: "stopped before the image was shown" };
  try {
    await postAfterBuffered(ctx, {
      type: "image",
      image_id: upload.imageId,
      tool_use_id: image.toolUseId,
      content_type: contentType,
      ...(image.caption ? { caption: image.caption } : {}),
    });
  } catch (e) {
    return failed("the relay didn't accept the image Event", e);
  }
  return { shown: true };
}
