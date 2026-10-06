import assert from "node:assert/strict";
import { test } from "node:test";

import { publishSkills } from "../src/session/commands.ts";
import { makeTurnHarness } from "./doubles.ts";

const grillMe = { name: "grill-me", description: "Interview me", argumentHint: "" };
const compact = { name: "compact", description: "Compact the conversation", argumentHint: "" };

test("publishSkills sends the skills and local commands", async () => {
  const { ctx, relay } = await makeTurnHarness();

  await publishSkills(ctx, [grillMe], [compact]);

  assert.equal(relay.putSkillsCalls.length, 1);
  assert.deepEqual(relay.putSkillsCalls[0], {
    skills: [grillMe],
    localCommands: [compact],
    inactivityCompactAfterMinutes: undefined,
  });
});

test("publishSkills skips the PUT when neither skills nor local commands have changed", async () => {
  const { ctx, relay } = await makeTurnHarness();

  await publishSkills(ctx, [grillMe], [compact]);
  await publishSkills(ctx, [grillMe], [compact]);

  assert.equal(relay.putSkillsCalls.length, 1);
});

test("publishSkills re-publishes when local commands change even though skills didn't", async () => {
  const { ctx, relay } = await makeTurnHarness();

  await publishSkills(ctx, [grillMe], []);
  await publishSkills(ctx, [grillMe], [compact]);

  assert.equal(relay.putSkillsCalls.length, 2);
  assert.deepEqual(relay.putSkillsCalls[1].localCommands, [compact]);
});
