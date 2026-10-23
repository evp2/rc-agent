import assert from "node:assert/strict";
import { test } from "node:test";

import { RelayClient } from "../src/relay/client.ts";
import { CONNECTOR_VERSION } from "../src/version.ts";

/**
 * Observed in production: a relay request whose connection hangs (no
 * response, no error -- a stuck socket) blocked the connector's single,
 * sequential main loop forever, because nothing bounded the fetch. This
 * proves the bound directly against the real RelayClient, with the global
 * fetch faked to hang exactly that way, rather than against a double that
 * could not have caught this.
 */
test("a hung relay request times out instead of blocking forever", async () => {
  const realFetch = globalThis.fetch;
  // Never resolves or rejects on its own -- the only way out is the signal.
  // The interval stands in for the stuck socket a real hung fetch holds open:
  // `AbortSignal.timeout`'s timer doesn't keep the process alive by itself, so
  // without something that does, Node exits before the timeout ever fires.
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const openSocket = setInterval(() => undefined, 1000);
      init?.signal?.addEventListener("abort", () => {
        clearInterval(openSocket);
        reject(init.signal!.reason);
      });
    })) as typeof fetch;

  try {
    await assert.rejects(
      RelayClient.resume("http://example.invalid", "sess-1", "secret", 20),
      /timeout/i,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * Auto-compact submits through the same endpoint the phone uses, told apart
 * only by this header. A wrong header value would make the relay misattribute
 * the Command to the phone -- exactly the false-liveness bug this header
 * exists to avoid -- so this pins the request shape directly.
 */
test("postCommand marks itself as the connector, not the phone", async () => {
  const realFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url, init: init! };
    return new Response(JSON.stringify({ seq: "01ABC", created_at: "2026-01-01T00:00:00.000Z" }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const client = await RelayClient.resume("http://relay.test", "sess-1", "secret");
    const result = await client.postCommand("/compact");

    assert.equal(result.seq, "01ABC");
    assert.equal(captured?.url, "http://relay.test/sessions/sess-1/commands");
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers["X-Crc-Client"], "connector");
    assert.equal(headers["Authorization"], "Bearer secret");
    assert.deepEqual(JSON.parse(captured!.init.body as string), { text: "/compact" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * Pins the whole skills report body against the real RelayClient: the relay
 * double only sees putSkills' arguments, so a stray field on the wire would
 * pass every test that goes through it.
 */
test("putSkills sends exactly the skills, local commands and the connector's version", async () => {
  const realFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url, init: init! };
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const client = await RelayClient.resume("http://relay.test", "sess-1", "secret");
    const skill = { name: "grill-me", description: "Interview me", argumentHint: "" };
    await client.putSkills([skill], [], undefined);

    assert.equal(captured?.url, "http://relay.test/sessions/sess-1/skills");
    assert.equal(captured!.init.method, "PUT");
    assert.deepEqual(JSON.parse(captured!.init.body as string), {
      skills: [skill],
      local_commands: [],
      connector_version: CONNECTOR_VERSION,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a relay that rejects the connector credential fails session creation with a credential error", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const status of [401, 403]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "missing or invalid X-Connector-Credential header" }), {
          status,
        })) as typeof fetch;

      await assert.rejects(
        RelayClient.create("https://relay.test", "testCred0001", {
          permissionMode: "bypassPermissions",
          providerType: "anthropic",
          projectDir: "/tmp/project",
        }),
        (e: Error) => {
          assert.match(e.message, /relay rejected 'connectorCredential'/);
          assert.doesNotMatch(e.message, /testCred0001/);
          return true;
        },
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("session creation sends the configured engine, and omits it when none is configured", async () => {
  const realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({ session_id: "s1", secret: "k", phone_url: "p", netlify_url: "n", control_url: "c" }),
      );
    }) as typeof fetch;
    const input = { permissionMode: "bypassPermissions", providerType: "copilot", projectDir: "/tmp/project" } as const;

    await RelayClient.create("https://relay.test", "testCred0001", { ...input, engine: "copilot" });
    await RelayClient.create("https://relay.test", "testCred0001", input);

    assert.equal(bodies[0].engine, "copilot");
    assert.equal("engine" in bodies[1], false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * An Archived file goes to S3 as the signed form's last part, read from disk
 * as it is sent. This drives the real client against a real HTTP server, so
 * the multipart body is the one fetch actually produces.
 */
test("uploadFile posts the signed fields, then the file's bytes as the form's last part", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "upload-"));
  const path = join(dir, "app.exe");
  writeFileSync(path, "MZ not really a program");
  let received: { contentType: string; body: Buffer } | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received = { contentType: req.headers["content-type"] ?? "", body: Buffer.concat(chunks) };
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };

  try {
    const client = await withFakeResume();
    await client.uploadFile(
      { fileId: "file-1", url: `http://127.0.0.1:${port}/`, fields: { key: "files/sess-1/file-1", Policy: "p" } },
      path,
      new AbortController().signal,
    );

    const form = await new Response(received!.body, {
      headers: { "content-type": received!.contentType },
    }).formData();
    assert.deepEqual([...form.keys()], ["key", "Policy", "file"]);
    assert.equal(form.get("key"), "files/sess-1/file-1");
    const file = form.get("file") as File;
    assert.equal(file.type, "application/octet-stream");
    assert.equal(await file.text(), "MZ not really a program");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A Blob that reads from disk as it is sent stops reading once the file
 * changes under it; one built from bytes read up front would still read the
 * old contents. So a body that still reads after the file changes was
 * buffered whole.
 */
test("uploadFile streams the file from disk rather than reading it whole into memory", async () => {
  const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "upload-"));
  const path = join(dir, "app.exe");
  writeFileSync(path, "MZ not really a program");
  const client = await withFakeResume();
  const realFetch = globalThis.fetch;
  let sent: Blob | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = (init.body as FormData).get("file") as Blob;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await client.uploadFile(
      { fileId: "file-1", url: "https://bucket.s3.test/", fields: { key: "files/sess-1/file-1" } },
      path,
      new AbortController().signal,
    );
    appendFileSync(path, " that grew");

    await assert.rejects(sent!.text(), { name: "NotReadableError" });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A RelayClient resumed against a relay faked just long enough to construct it. */
async function withFakeResume(): Promise<RelayClient> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    return await RelayClient.resume("http://relay.test", "sess-1", "secret");
  } finally {
    globalThis.fetch = realFetch;
  }
}
