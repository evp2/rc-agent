import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_RELAY_LOOKUP_URL, resolveRelayBaseUrl } from "../src/relayLookup.ts";

const credential = "abcDEF123456";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const reply = (relayBaseUrl: unknown) => () => Response.json({ relayBaseUrl });

test("a relayBaseUrl in the config wins and nothing is looked up", async () => {
  const { fetch, calls } = fakeFetch(reply("https://elsewhere.test"));

  const url = await resolveRelayBaseUrl(
    { relayBaseUrl: "https://configured.test", connectorCredential: credential },
    fetch,
  );

  assert.equal(url, "https://configured.test");
  assert.equal(calls.length, 0);
});

test("without a relayBaseUrl the default endpoint is asked, presenting the credential", async () => {
  const { fetch, calls } = fakeFetch(reply("https://relay.test/test"));

  const url = await resolveRelayBaseUrl({ connectorCredential: credential }, fetch);

  assert.equal(url, "https://relay.test/test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, DEFAULT_RELAY_LOOKUP_URL);
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-connector-credential"), credential);
});

test("relayLookupUrl in the config replaces the default endpoint", async () => {
  const { fetch, calls } = fakeFetch(reply("https://relay.test/test"));

  await resolveRelayBaseUrl(
    { relayLookupUrl: "https://lookup.test/api", connectorCredential: credential },
    fetch,
  );

  assert.equal(calls[0]?.url, "https://lookup.test/api");
});

test("trailing slashes on the looked-up address are dropped, as for a configured one", async () => {
  const { fetch } = fakeFetch(reply("https://relay.test/test//"));

  assert.equal(await resolveRelayBaseUrl({ connectorCredential: credential }, fetch), "https://relay.test/test");
});

test("an unreachable endpoint fails and says how to bypass the lookup", async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    resolveRelayBaseUrl({ connectorCredential: credential }, fetch),
    (e: Error) => e.message.includes(DEFAULT_RELAY_LOOKUP_URL) && /relayBaseUrl/.test(e.message),
  );
});

test("a rejected credential fails and points at connectorCredential", async () => {
  const { fetch } = fakeFetch(() => new Response("{}", { status: 400 }));

  await assert.rejects(resolveRelayBaseUrl({ connectorCredential: credential }, fetch), /connectorCredential/);
});

test("any other error status fails and reports the status", async () => {
  const { fetch } = fakeFetch(() => new Response("boom", { status: 500 }));

  await assert.rejects(resolveRelayBaseUrl({ connectorCredential: credential }, fetch), /HTTP 500/);
});

test("a response without a usable address fails", async () => {
  for (const body of [() => reply(undefined)(), () => reply(42)(), () => new Response("not json")]) {
    const { fetch } = fakeFetch(body);
    await assert.rejects(resolveRelayBaseUrl({ connectorCredential: credential }, fetch), /relay/i);
  }
});

test("a plain-http address for a non-local host is refused, as it is in config", async () => {
  const { fetch } = fakeFetch(reply("http://relay.example.com/test"));

  await assert.rejects(resolveRelayBaseUrl({ connectorCredential: credential }, fetch), /https/);
});
