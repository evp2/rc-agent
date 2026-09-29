import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EngineImage, ShowImageOutcome } from "../engine/types";
import type { SessionContext } from "./context";
import { postAfterBuffered } from "./events";

/** A PNG's fixed eight-byte signature. The type comes from the bytes, never the extension, so a renamed file can't pass as an Image. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
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

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (e) {
    return { shown: false, reason: `couldn't read ${path}: ${(e as Error).message}` };
  }
  if (!isPng(bytes)) {
    return { shown: false, reason: `${path} is not a PNG image` };
  }

  const contentType = "image/png";
  try {
    const upload = await ctx.client.signImageUpload(contentType, bytes.length);
    if (signal.aborted) return { shown: false, reason: "stopped before the image was sent" };
    await ctx.client.uploadImage(upload, bytes, contentType);
    if (signal.aborted) return { shown: false, reason: "stopped before the image was shown" };
    await postAfterBuffered(ctx, {
      type: "image",
      image_id: upload.imageId,
      tool_use_id: image.toolUseId,
      content_type: contentType,
      ...(image.caption ? { caption: image.caption } : {}),
    });
  } catch (e) {
    return { shown: false, reason: (e as Error).message };
  }
  return { shown: true };
}
