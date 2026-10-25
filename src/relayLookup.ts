import { validateRelayUrl, type ConnectorConfig } from "./config";

export const DEFAULT_RELAY_LOOKUP_URL = "https://claude-rc.netlify.app/api";

const LOOKUP_TIMEOUT_MS = 10_000;

export type RelayLookupConfig = Pick<ConnectorConfig, "relayBaseUrl" | "relayLookupUrl" | "connectorCredential">;

/** The config's own address if it names one, otherwise the lookup endpoint's; a failed lookup never falls back to a default. */
export async function resolveRelayBaseUrl(
  config: RelayLookupConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (config.relayBaseUrl) return config.relayBaseUrl;

  const lookupUrl = config.relayLookupUrl ?? DEFAULT_RELAY_LOOKUP_URL;
  let res: Response;
  try {
    res = await fetchImpl(lookupUrl, {
      method: "POST",
      headers: { "X-Connector-Credential": config.connectorCredential },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${lookupUrl} to find the relay (${(e as Error).message}). ` +
        "Set 'relayBaseUrl' in your config to skip the lookup.",
    );
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error(
      `${lookupUrl} rejected 'connectorCredential' (HTTP ${res.status}). ` +
        "Check it in your config, or set 'relayBaseUrl' to skip the lookup.",
    );
  }
  if (!res.ok) {
    throw new Error(`Looking up the relay at ${lookupUrl} failed: HTTP ${res.status}.`);
  }

  const body = (await res.json().catch(() => undefined)) as { relayBaseUrl?: unknown } | undefined;
  if (typeof body?.relayBaseUrl !== "string" || body.relayBaseUrl.length === 0) {
    throw new Error(`${lookupUrl} did not return a relay address ('relayBaseUrl').`);
  }
  return validateRelayUrl(body.relayBaseUrl, "relayBaseUrl from the relay lookup");
}
