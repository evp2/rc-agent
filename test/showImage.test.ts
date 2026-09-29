import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EngineImage, ShowImageOutcome } from "../src/engine/types.ts";
import { runTurn } from "../src/session/turn.ts";
import { cmd, makeTurnHarness, type FakeRelay, type TurnHarness } from "./doubles.ts";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
const PNG = fixture("pixel.png");

/**
 * Runs one Turn whose body shows `image` and reports what `show_image`
 * returned to the Engine. `arrange` sets the fake relay up first, for the
 * cases where the relay or S3 misbehaves.
 */
async function showInTurn(
  image: EngineImage,
  arrange: (relay: FakeRelay) => void = () => {},
): Promise<{ h: TurnHarness; outcome: ShowImageOutcome }> {
  let outcome: ShowImageOutcome | undefined;
  const h = await makeTurnHarness({
    handlerFor: () => async (turn) => {
      outcome = await turn.showImage(image);
    },
  });
  arrange(h.relay);
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

for (const [file, contentType] of [
  ["pixel.jpg", "image/jpeg"],
  ["pixel.gif", "image/gif"],
  ["pixel.webp", "image/webp"],
] as const) {
  test(`showing ${file} emits one image Event carrying ${contentType}`, async () => {
    const path = fixture(file);
    const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path });

    assert.deepEqual(outcome, { shown: true });
    assert.deepEqual(h.relay.signed, [{ contentType, byteLength: readFileSync(path).length }]);
    assert.equal(h.relay.uploaded[0].contentType, contentType);
    assert.deepEqual(
      h.relay.posted.filter((e) => e.type === "image"),
      [{ type: "image", image_id: "img-1", tool_use_id: "toolu_img", content_type: contentType }],
    );
    await h.close();
  });
}

/** Asserts a refused `show_image` never got as far as the relay: nothing signed, uploaded or emitted. */
function assertNoRelayCalls(h: TurnHarness): void {
  assert.deepEqual(h.relay.signed, []);
  assert.deepEqual(h.relay.uploaded, []);
  assert.equal(h.relay.posted.some((e) => e.type === "image"), false);
}

/** The reason a refused `show_image` gave the Engine, failing the test if it was shown after all. */
function reasonOf(outcome: ShowImageOutcome): string {
  assert.equal(outcome.shown, false, "the image should have been refused");
  return (outcome as { reason: string }).reason;
}

test("a path with no file behind it is refused, naming the path, with no relay calls", async () => {
  const missing = fixture("no-such-screenshot.png");
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: missing });

  assert.match(reasonOf(outcome), /no file at .*no-such-screenshot\.png/);
  assertNoRelayCalls(h);
  await h.close();
});

test("a directory is refused as unreadable, with no relay calls", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: join(import.meta.dirname, "fixtures") });

  assert.match(reasonOf(outcome), /couldn't read/);
  assertNoRelayCalls(h);
  await h.close();
});

test("an SVG is refused as a disallowed type, with no relay calls", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: fixture("diagram.svg") });

  assert.match(reasonOf(outcome), /not a PNG, JPEG, GIF or WebP/);
  assertNoRelayCalls(h);
  await h.close();
});

test("a text file renamed to .png is refused by its bytes, not accepted by its extension", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: fixture("renamed-text.png") });

  assert.match(reasonOf(outcome), /not a PNG, JPEG, GIF or WebP/);
  assertNoRelayCalls(h);
  await h.close();
});

test("a real PNG over 10MB is refused as too large before any relay call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "show-image-"));
  try {
    const big = join(dir, "huge.png");
    const bytes = new Uint8Array(11 * 1024 * 1024);
    bytes.set(readFileSync(PNG));
    writeFileSync(big, bytes);
    const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: big });

    assert.match(reasonOf(outcome), /11\.0MB.*over the 10MB limit/);
    assertNoRelayCalls(h);
    await h.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relay that refuses to sign returns an error and nothing is uploaded or emitted", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: PNG }, (relay) => {
    relay.failNextSign = new Error("HTTP 403 forbidden");
  });

  assert.match(reasonOf(outcome), /relay didn't sign the upload.*HTTP 403/);
  assert.deepEqual(h.relay.uploaded, []);
  assert.equal(h.relay.posted.some((e) => e.type === "image"), false);
  await h.close();
});

test("a failed S3 upload returns an error and emits no image Event", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: PNG }, (relay) => {
    relay.failNextUpload = new Error("HTTP 400 EntityTooLarge");
  });

  assert.match(reasonOf(outcome), /upload to storage failed.*HTTP 400/);
  assert.equal(h.relay.posted.some((e) => e.type === "image"), false);
  await h.close();
});

test("a relay that rejects the image Event returns an error, and the Event is not recorded", async () => {
  const { h, outcome } = await showInTurn({ toolUseId: "toolu_img", path: PNG }, (relay) => {
    relay.rejectImageEvents = new Error("HTTP 400 unknown image_id");
  });

  assert.match(reasonOf(outcome), /relay didn't accept the image Event.*HTTP 400/);
  assert.equal(h.relay.uploaded.length, 1, "the bytes reached S3 before the Event was refused");
  assert.equal(h.relay.posted.some((e) => e.type === "image"), false);
  await h.close();
});
