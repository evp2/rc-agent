import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { EngineImage, ShowImageOutcome } from "../src/engine/types.ts";
import { runTurn } from "../src/session/turn.ts";
import { cmd, makeTurnHarness, type TurnHarness } from "./doubles.ts";

const PNG = join(import.meta.dirname, "fixtures", "pixel.png");

/** Runs one Turn whose body shows `image` and reports what `show_image` returned to the Engine. */
async function showInTurn(image: EngineImage): Promise<{ h: TurnHarness; outcome: ShowImageOutcome }> {
  let outcome: ShowImageOutcome | undefined;
  const h = await makeTurnHarness({
    handlerFor: () => async (turn) => {
      outcome = await turn.showImage(image);
    },
  });
  await runTurn(h.ctx, cmd("show me the page"));
  return { h, outcome: outcome! };
}

test("showing a PNG signs an upload, sends its bytes to S3, and emits exactly one image Event", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: PNG, caption: "the login page" });

  assert.deepEqual(outcome, { shown: true });
  assert.deepEqual(h.relay.signed, [{ contentType: "image/png", byteLength: readFileSync(PNG).length }]);
  assert.equal(h.relay.uploaded.length, 1);
  assert.equal(h.relay.uploaded[0].imageId, "img-1");
  assert.deepEqual(h.relay.uploaded[0].bytes, new Uint8Array(readFileSync(PNG)));
  assert.equal(h.relay.uploaded[0].contentType, "image/png");

  const images = h.relay.posted.filter((e) => e.type === "image");
  assert.deepEqual(images, [
    {
      type: "image",
      image_id: "img-1",
      tool_use_id: "toolu_img",
      content_type: "image/png",
      caption: "the login page",
    },
  ]);
  await h.close();
});

test("the image Event reaches the relay after the show_image call it belongs to", async () => {
  const { h } = await showInTurn({ toolUseId: "toolu_img", path: PNG });

  const toolUse = h.relay.posted.findIndex((e) => e.type === "tool_use" && e.tool_use_id === "toolu_img");
  const image = h.relay.posted.findIndex((e) => e.type === "image");
  assert.ok(toolUse >= 0, "the tool_use was posted");
  assert.ok(image > toolUse, "the image Event follows its tool_use");
  await h.close();
});

test("a file that is not a PNG is refused, and nothing is signed, uploaded or emitted", async () => {
  const notPng = join(import.meta.dirname, "showImage.test.ts");
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: notPng });

  assert.equal(outcome.shown, false);
  assert.deepEqual(h.relay.signed, []);
  assert.deepEqual(h.relay.uploaded, []);
  assert.equal(h.relay.posted.some((e) => e.type === "image"), false);
  await h.close();
});
