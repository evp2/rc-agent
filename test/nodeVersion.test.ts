import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nodeVersionProblem } from "../src/nodeVersion";

describe("nodeVersionProblem", () => {
  it("accepts Node 22.19.0 and later", () => {
    for (const v of ["22.19.0", "22.23.2", "23.0.0", "24.1.0"])
      assert.equal(nodeVersionProblem(v), undefined, v);
  });

  it("names the running and the required version when Node is older", () => {
    for (const v of ["22.18.9", "20.11.1", "18.0.0"]) {
      const message = nodeVersionProblem(v);
      assert.ok(
        message?.includes(v) && message.includes("22.19.0"),
        `${v}: ${message}`,
      );
    }
  });
});
