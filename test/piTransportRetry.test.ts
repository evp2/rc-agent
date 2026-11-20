import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { retryTransportErrors } from "../src/engine/pi/transportRetry.ts";

function failed(errorMessage: string, stopReason: "error" | "stop" = "error"): AssistantMessage {
  return { stopReason, errorMessage } as AssistantMessage;
}

function sessionWhere(piRetries: boolean): AgentSession {
  const session = { _isRetryableError: () => piRetries };
  retryTransportErrors(session as unknown as AgentSession);
  return session as unknown as AgentSession;
}

const verdict = (session: AgentSession, message: AssistantMessage): boolean =>
  (session as unknown as { _isRetryableError(m: AssistantMessage): boolean })._isRetryableError(message);

test("retries a refused connection to the proxy", () => {
  assert.equal(verdict(sessionWhere(false), failed("connect ECONNREFUSED 192.168.5.2:3128")), true);
});

test("retries a proxy that drops the CONNECT tunnel", () => {
  assert.equal(verdict(sessionWhere(false), failed("Proxy connection ended before receiving CONNECT response")), true);
});

test("keeps Pi's own verdict for errors it already retries", () => {
  assert.equal(verdict(sessionWhere(true), failed("overloaded")), true);
});

test("does not retry other errors, or a message that did not fail", () => {
  assert.equal(verdict(sessionWhere(false), failed("AccessDeniedException")), false);
  assert.equal(verdict(sessionWhere(false), failed("connect ECONNREFUSED 1.2.3.4:1", "stop")), false);
});
