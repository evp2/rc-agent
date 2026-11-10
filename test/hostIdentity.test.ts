import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The connector's home-level directory is fixed when its modules load, so HOME
// has to point at a scratch directory before they are imported.
process.env.HOME = mkdtempSync(join(tmpdir(), "crc-host-home-"));
const { RelayClient } = await import("../src/relay/client.ts");

const homeDir = join(process.env.HOME, ".claude-remote-control");

async function createSessions(count: number, projectDir: string): Promise<Array<Record<string, unknown>>> {
  const realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ session_id: "s1", secret: "k", phone_url: "p" }));
  }) as typeof fetch;
  try {
    for (let i = 0; i < count; i++) {
      await RelayClient.create("https://relay.test", "testCred0001", {
        permissionMode: "bypassPermissions",
        providerType: "anthropic",
        projectDir,
      });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

test("every session creation sends the same generated host id and the machine's hostname", async () => {
  rmSync(homeDir, { recursive: true, force: true });
  const projectDir = mkdtempSync(join(tmpdir(), "crc-host-project-"));

  const bodies = await createSessions(2, projectDir);

  assert.equal(typeof bodies[0].host_id, "string");
  assert.ok((bodies[0].host_id as string).length >= 16);
  assert.equal(bodies[1].host_id, bodies[0].host_id);
  assert.equal(bodies[0].host_name, hostname());
  assert.deepEqual(readdirSync(projectDir), [], "the host id is never kept inside the worktree");
});

test("a restarted connector sends the host id its earlier process generated", () => {
  const home = mkdtempSync(join(tmpdir(), "crc-host-home-"));
  const createInFreshProcess = (): string =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CREATE_ONCE], {
      env: { ...process.env, HOME: home },
      encoding: "utf-8",
    }).trim();

  const first = createInFreshProcess();
  const afterRestart = createInFreshProcess();

  assert.ok(first.length >= 16);
  assert.equal(afterRestart, first);
});

const CREATE_ONCE = `
const { RelayClient } = await import(${JSON.stringify(new URL("../src/relay/client.ts", import.meta.url).href)});
let sent;
globalThis.fetch = async (_url, init) => {
  sent = JSON.parse(init.body);
  return new Response(JSON.stringify({ session_id: "s1", secret: "k", phone_url: "p" }));
};
await RelayClient.create("https://relay.test", "c", { permissionMode: "bypassPermissions", providerType: "anthropic", projectDir: "/tmp/p" });
console.log(sent.host_id);
`;

test("two machines' homes never share a host id", async () => {
  rmSync(homeDir, { recursive: true, force: true });
  const [a] = await createSessions(1, mkdtempSync(join(tmpdir(), "crc-host-project-")));
  rmSync(homeDir, { recursive: true, force: true });
  const [b] = await createSessions(1, mkdtempSync(join(tmpdir(), "crc-host-project-")));

  assert.notEqual(a.host_id, b.host_id);
});

test("an unreadable host id file is replaced rather than failing session creation", async () => {
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, "host.json"), "{not json");

  const bodies = await createSessions(2, mkdtempSync(join(tmpdir(), "crc-host-project-")));

  assert.equal(typeof bodies[0].host_id, "string");
  assert.equal(bodies[1].host_id, bodies[0].host_id);
});

test("Connectors starting at once on a fresh machine all settle on one host id", async () => {
  const home = mkdtempSync(join(tmpdir(), "crc-host-home-"));
  const startAt = Date.now() + 3_000;
  const ids = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", identityAt(startAt)],
            { env: { ...process.env, HOME: home }, encoding: "utf-8" },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
    ),
  );

  assert.equal(new Set(ids).size, 1, ids.join("\n"));
  assert.equal(JSON.parse(readFileSync(join(home, ".claude-remote-control", "host.json"), "utf-8")).hostId, ids[0]);
});

// Every process loads first, then spins to one shared instant, so their first reads of host.json race.
const identityAt = (startAt: number) => `
const { hostIdentity } = await import(${JSON.stringify(new URL("../src/host.ts", import.meta.url).href)});
while (Date.now() < ${startAt});
console.log(hostIdentity().hostId);
`;
