import assert from "node:assert/strict";
import { test } from "node:test";

import { pairingQrUrl } from "../src/qr.ts";

const phoneUrl = "https://relay.example/test/?s=abc&k=secret";
const controlUrl = "https://claude-rc.netlify.app/p/1234567890";

test("pairingQrUrl encodes the Control link by default", () => {
  assert.equal(pairingQrUrl({ phoneUrl, controlUrl }, false), controlUrl);
});

test("pairingQrUrl encodes the relay phone URL when asked to", () => {
  assert.equal(pairingQrUrl({ phoneUrl, controlUrl }, true), phoneUrl);
});

test("pairingQrUrl falls back to the relay phone URL when the session has no Control link", () => {
  assert.equal(pairingQrUrl({ phoneUrl }, false), phoneUrl);
});
