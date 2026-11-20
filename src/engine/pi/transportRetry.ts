import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// Pi's own list matches "connection refused" but not Node's `ECONNREFUSED` code, and has nothing for a proxy dropping the CONNECT tunnel.
const TRANSPORT_ERROR = /ECONNREFUSED|Proxy connection ended/i;

export function isTransportError(message: AssistantMessage): boolean {
  return message.stopReason === "error" && TRANSPORT_ERROR.test(message.errorMessage ?? "");
}

// Pi exposes no hook for its retry policy, so this wraps the private predicate its retry loop asks.
export function retryTransportErrors(session: AgentSession): void {
  const internals = session as unknown as { _isRetryableError(message: AssistantMessage): boolean };
  const piVerdict = internals._isRetryableError.bind(session);
  internals._isRetryableError = (message) => piVerdict(message) || isTransportError(message);
}
