import type { EngineImage, OpenOptions, ShowImageOutcome } from "./types";

// What every Engine's `show_image` tool says and returns, so the model sees
// the same tool whichever Engine runs the session.

export const SHOW_IMAGE_DESCRIPTION =
  "Show the human an image file from this machine -- a screenshot you took, a chart or diagram you rendered. " +
  "It appears inline in their transcript on their phone. Use it whenever seeing the picture would help them " +
  "more than a description would. Returns only a confirmation; the image does not come back to you.";

export const SHOW_IMAGE_PATH_DESCRIPTION = "Path to the image file. Absolute, or relative to the working directory.";

export const SHOW_IMAGE_CAPTION_DESCRIPTION = "What the human should look at in the image.";

/** The tool's whole result when the Image was shown. */
export const IMAGE_SHOWN = "The image is now showing in the human's transcript.";

/** Hands one call to `onShowImage`. A throw is a failure like any other, its message the reason. */
export async function forwardShowImage(
  onShowImage: NonNullable<OpenOptions["onShowImage"]>,
  image: EngineImage,
  signal: AbortSignal,
): Promise<ShowImageOutcome> {
  try {
    return await onShowImage(image, signal);
  } catch (e) {
    return { shown: false, reason: (e as Error).message };
  }
}
