import assert from "node:assert/strict";
import { test } from "node:test";

import { ForkError } from "../src/fork.ts";
import { checkForkRequest } from "../src/session/watchers.ts";
import { SessionEndedError } from "../src/relay/client.ts";
import { makeTurnHarness } from "./doubles.ts";

test("checkForkRequest does nothing when there is no fork_request", async () => {
  const h = makeTurnHarness([]);
  h.relay.getSession = async () => ({});

  await checkForkRequest(h.ctx);

  assert.deepEqual(h.relay.posted, []);
});

test("checkForkRequest drives executeFork and posts the success shape", async () => {
  const calls: string[] = [];
  const h = makeTurnHarness([], {
    executeFork: async (name) => {
      calls.push(name);
      return { controlUrl: "https://relay.test/c/abc123" };
    },
  });
  h.relay.getSession = async () => ({
    fork_request: { name: "fix-login-bug", requested_at: "2026-01-01T00:00:00.000Z" },
  });

  await checkForkRequest(h.ctx);

  assert.deepEqual(calls, ["fix-login-bug"]);
  assert.deepEqual(h.relay.posted, [
    {
      type: "status",
      fork_requested_at: "2026-01-01T00:00:00.000Z",
      fork_name: "fix-login-bug",
      fork_control_url: "https://relay.test/c/abc123",
    },
  ]);
});

test("checkForkRequest posts the failure shape with git's own error text, unmodified", async () => {
  const h = makeTurnHarness([], {
    executeFork: async () => {
      throw new Error("fatal: a branch named 'fix-login-bug' already exists");
    },
  });
  h.relay.getSession = async () => ({
    fork_request: { name: "fix-login-bug", requested_at: "2026-01-01T00:00:00.000Z" },
  });

  await checkForkRequest(h.ctx);

  assert.deepEqual(h.relay.posted, [
    {
      type: "status",
      fork_requested_at: "2026-01-01T00:00:00.000Z",
      fork_name: "fix-login-bug",
      fork_error: "fatal: a branch named 'fix-login-bug' already exists",
    },
  ]);
});

test("checkForkRequest carries a classified fork_error_code alongside the raw text", async () => {
  const h = makeTurnHarness([], {
    executeFork: async () => {
      throw new ForkError("fatal: a branch named 'fix-login-bug' already exists", "name_taken");
    },
  });
  h.relay.getSession = async () => ({
    fork_request: { name: "fix-login-bug", requested_at: "2026-01-01T00:00:00.000Z" },
  });

  await checkForkRequest(h.ctx);

  assert.deepEqual(h.relay.posted, [
    {
      type: "status",
      fork_requested_at: "2026-01-01T00:00:00.000Z",
      fork_name: "fix-login-bug",
      fork_error: "fatal: a branch named 'fix-login-bug' already exists",
      fork_error_code: "name_taken",
    },
  ]);
});

test("checkForkRequest omits fork_error_code when the failure could not be classified", async () => {
  const h = makeTurnHarness([], {
    executeFork: async () => {
      throw new ForkError("fatal: something nobody anticipated", undefined);
    },
  });
  h.relay.getSession = async () => ({
    fork_request: { name: "fix-login-bug", requested_at: "2026-01-01T00:00:00.000Z" },
  });

  await checkForkRequest(h.ctx);

  assert.deepEqual(h.relay.posted, [
    {
      type: "status",
      fork_requested_at: "2026-01-01T00:00:00.000Z",
      fork_name: "fix-login-bug",
      fork_error: "fatal: something nobody anticipated",
    },
  ]);
});

test("checkForkRequest never acts on the same fork_request twice", async () => {
  let calls = 0;
  const h = makeTurnHarness([], {
    executeFork: async () => {
      calls += 1;
      return { controlUrl: "https://relay.test/c/abc123" };
    },
  });
  h.relay.getSession = async () => ({
    fork_request: { name: "fix-login-bug", requested_at: "2026-01-01T00:00:00.000Z" },
  });

  await checkForkRequest(h.ctx);
  await checkForkRequest(h.ctx);

  assert.equal(calls, 1);
  assert.equal(h.relay.posted.length, 1);
});

test("checkForkRequest acts again once a newer fork_request supersedes the last one it handled", async () => {
  const calls: string[] = [];
  const h = makeTurnHarness([], {
    executeFork: async (name) => {
      calls.push(name);
      return { controlUrl: undefined };
    },
  });
  h.relay.getSession = async () => ({
    fork_request: { name: "first", requested_at: "2026-01-01T00:00:00.000Z" },
  });
  await checkForkRequest(h.ctx);

  h.relay.getSession = async () => ({
    fork_request: { name: "second", requested_at: "2026-01-01T00:00:01.000Z" },
  });
  await checkForkRequest(h.ctx);

  assert.deepEqual(calls, ["first", "second"]);
});

test("checkForkRequest swallows a SessionEndedError from the session poll", async () => {
  const h = makeTurnHarness([]);
  h.relay.getSession = async () => {
    throw new SessionEndedError();
  };

  await assert.doesNotReject(checkForkRequest(h.ctx));
  assert.deepEqual(h.relay.posted, []);
});
