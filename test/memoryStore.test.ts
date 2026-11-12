import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { credentialRefusalText, descriptionTooLargeText, forgetUnknownText, indexFullText, memoryTooLargeText } from "../src/engine/memoryTools.ts";
import { MAX_DESCRIPTION_BYTES, MEMORY_LIMITS } from "../src/memory/limits.ts";
import { projectScope } from "../src/memory/projectScope.ts";
import { createMemoryStore } from "../src/memory/store.ts";

function inTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "memory-store-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const COMMITS = { name: "commit-style", description: "How the person likes commits", body: "Short subjects." };

test("a saved Global memory reads back and shows in the index", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const saved = await store.save("global", COMMITS);
    assert.deepEqual(saved, { saved: true, index: "- commit-style: How the person likes commits", replaced: false });
    assert.equal(await store.read("global", "commit-style"), "Short subjects.");
    assert.equal(await store.index("global"), "- commit-style: How the person likes commits");
    assert.ok(readFileSync(join(root, "global", "commit-style.md"), "utf-8").includes("Short subjects."));
  }));

test("saving under an existing name replaces the Memory and keeps one index line", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", COMMITS);
    await store.save("global", { ...COMMITS, description: "Updated", body: "Long subjects." });
    assert.equal(await store.read("global", "commit-style"), "Long subjects.");
    assert.equal(await store.index("global"), "- commit-style: Updated");
  }));

test("a name that could leave the Memory folder is refused and writes nothing", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const saved = await store.save("global", { ...COMMITS, name: "../escape" });
    assert.equal(saved.saved, false);
    assert.equal(existsSync(join(root, "escape.md")), false);
    assert.equal(await store.index("global"), "");
  }));

const SECRETS: Record<string, string> = {
  "an AWS access key": "Use AKIAIOSFODNN7EXAMPLE for deploys.",
  "a GitHub token": "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "an OpenAI-style key": "key is sk-abcdefghijklmnopqrstuvwx1234",
  "a private key block": "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
  "a password assignment": "db password = hunter2hunter2",
  "a colon-style token": "token: 9fK2xQ7mLp4vZt8w",
  "a quoted api key": 'api_key="Zx9Qm2Lp7Vt4Kw8Rb3"',
  "a mixed-case password with symbols": "password=Tr0ub4dor&3",
  "a bearer token": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
};

for (const [label, body] of Object.entries(SECRETS)) {
  test(`text containing ${label} is refused, says why, and writes nothing`, () =>
    inTempRoot(async (root) => {
      const store = createMemoryStore(root);
      const saved = await store.save("global", { ...COMMITS, body });
      assert.equal(saved.saved, false);
      if (!saved.saved) assert.equal(saved.reason, credentialRefusalText());
      assert.equal(existsSync(join(root, "global")), false);
    }));
}

test("a credential in the description is refused too", () =>
  inTempRoot(async (root) => {
    const saved = await createMemoryStore(root).save("global", { ...COMMITS, description: SECRETS["a GitHub token"]! });
    assert.equal(saved.saved, false);
  }));

test("the refusal suggests saving the non-secret part", () => {
  assert.match(credentialRefusalText(), /non-secret/);
});

test("ordinary text that mentions a password or a key is saved", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    for (const [i, body] of [
      "The password lives in the 1Password vault under 'staging'.",
      "Use the SSH key in ~/.ssh/id_work for the work profile.",
      "Never commit an API key; rotate the token monthly.",
      "Set the password field to be required in the signup form.",
      "token: refresh-handled-by-vault",
      "password: stored-in-keychain",
      "api_key = read-from-the-environment",
    ].entries()) {
      const saved = await store.save("global", { ...COMMITS, name: `note-${i}`, body });
      assert.equal(saved.saved, true, body);
    }
  }));

test("a Memory over the per-Memory limit is refused with what to do, and writes nothing", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root, { maxIndexLines: 200, maxMemoryBytes: 20 });
    const saved = await store.save("global", { ...COMMITS, body: "x".repeat(21) });
    assert.deepEqual(saved, { saved: false, reason: memoryTooLargeText(20) });
    assert.match(memoryTooLargeText(20), /shorten|split/i);
    assert.equal(existsSync(join(root, "global")), false);
  }));

test("a description over the description limit is refused with what to do, and writes nothing", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const saved = await store.save("global", { ...COMMITS, description: "x".repeat(MAX_DESCRIPTION_BYTES + 1) });
    assert.deepEqual(saved, { saved: false, reason: descriptionTooLargeText(MAX_DESCRIPTION_BYTES) });
    assert.match(descriptionTooLargeText(MAX_DESCRIPTION_BYTES), /shorten/i);
    assert.equal(existsSync(join(root, "global")), false);
    assert.equal((await store.save("global", { ...COMMITS, description: "x".repeat(MAX_DESCRIPTION_BYTES) })).saved, true);
  }));

test("a save that would push the index past its limit is refused, but replacing is allowed", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root, { maxIndexLines: 2, maxMemoryBytes: 4096 });
    await store.save("global", { ...COMMITS, name: "one" });
    await store.save("global", { ...COMMITS, name: "two" });
    const refused = await store.save("global", { ...COMMITS, name: "three" });
    assert.deepEqual(refused, { saved: false, reason: indexFullText(2) });
    assert.match(indexFullText(2), /forget|merge/i);
    assert.equal(await store.read("global", "three"), undefined);
    assert.equal((await store.save("global", { ...COMMITS, name: "two", body: "new" })).saved, true);
  }));

test("the default limits are about 200 index lines and 4 KB", () => {
  assert.deepEqual(MEMORY_LIMITS, { maxIndexLines: 200, maxMemoryBytes: 4096 });
});

test("the index of an empty store is empty and reading an unknown name is undefined", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(join(root, "not-created-yet"));
    assert.equal(await store.index("global"), "");
    assert.equal(await store.read("global", "nothing"), undefined);
  }));

test("a forgotten Memory leaves the index and its file moves aside intact", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", COMMITS);
    await store.save("global", { name: "tabs", description: "Tabs please", body: "Use tabs." });
    const before = readFileSync(join(root, "global", "commit-style.md"), "utf-8");
    assert.deepEqual(await store.forget("global", "commit-style"), { forgotten: true, index: "- tabs: Tabs please" });
    assert.equal(await store.index("global"), "- tabs: Tabs please");
    assert.equal(await store.read("global", "commit-style"), undefined);
    assert.equal(existsSync(join(root, "global", "commit-style.md")), false);
    assert.equal(readFileSync(join(root, "global", "MEMORY.md"), "utf-8"), "- tabs: Tabs please\n");
    const aside = readdirSync(join(root, "forgotten", "global"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(root, "forgotten", "global", aside[0]!), "utf-8"), before);
  }));

test("forgetting an unknown or unusable name changes nothing", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", COMMITS);
    for (const name of ["nothing", "../global/commit-style"]) {
      assert.deepEqual(await store.forget("global", name), { forgotten: false, reason: forgetUnknownText(name) });
    }
    assert.equal(await store.index("global"), "- commit-style: How the person likes commits");
    assert.equal(existsSync(join(root, "forgotten")), false);
  }));

test("forgetting the same name twice keeps both forgotten files", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", { ...COMMITS, body: "one" });
    await store.forget("global", "commit-style");
    await store.save("global", { ...COMMITS, body: "two" });
    await store.forget("global", "commit-style");
    const dir = join(root, "forgotten", "global");
    const bodies = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8"));
    assert.equal(bodies.length, 2);
    assert.ok(bodies.some((b) => b.includes("one")) && bodies.some((b) => b.includes("two")));
    assert.equal(await store.index("global"), "");
  }));

test("a save reports whether it replaced an existing Memory", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const first = await store.save("global", COMMITS);
    assert.equal(first.saved && first.replaced, false);
    const second = await store.save("global", { ...COMMITS, body: "Long subjects." });
    assert.equal(second.saved && second.replaced, true);
  }));

test("two saves under one name at once leave one of them read back and one index line", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const results = await Promise.all([
      store.save("global", { ...COMMITS, body: "one" }),
      store.save("global", { ...COMMITS, body: "two" }),
    ]);
    assert.ok(results.every((r) => r.saved));
    assert.match((await store.read("global", "commit-style"))!, /^(one|two)$/);
    assert.equal((await store.index("global")).split("\n").length, 1);
  }));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  return path;
}

function inTempProjects<T>(body: (store: ReturnType<typeof createMemoryStore>, dir: (name: string) => string) => Promise<T>): Promise<T> {
  return inTempRoot((root) => body(createMemoryStore(join(root, "memories")), (name) => join(root, "work", name)));
}

test("a Project memory saved in one worktree is known from another worktree and from a subfolder", () =>
  inTempProjects(async (store, dir) => {
    const main = makeRepo(dir("repo"));
    const linked = dir("repo-linked");
    git(main, "worktree", "add", "-q", linked, "-b", "other");
    mkdirSync(join(main, "src"));
    await store.save(await projectScope(main), COMMITS);
    assert.equal(await store.index(await projectScope(linked)), "- commit-style: How the person likes commits");
    assert.equal(await store.read(await projectScope(join(main, "src")), "commit-style"), "Short subjects.");
    assert.equal(await store.index("global"), "", "Project memories are not Global");
  }));

test("two different repositories never see each other's Project memories", () =>
  inTempProjects(async (store, dir) => {
    await store.save(await projectScope(makeRepo(dir("a"))), COMMITS);
    assert.equal(await store.index(await projectScope(makeRepo(dir("b")))), "");
  }));

test("a directory outside any repository is keyed by its own path", () =>
  inTempProjects(async (store, dir) => {
    mkdirSync(dir("one"), { recursive: true });
    mkdirSync(dir("two"), { recursive: true });
    await store.save(await projectScope(dir("one")), COMMITS);
    assert.equal(await store.index(await projectScope(dir("one"))), "- commit-style: How the person likes commits");
    assert.equal(await store.index(await projectScope(dir("two"))), "");
  }));

const UNAVAILABLE = /^Not saved: the memory folder can't be written to right now\./;

test("a save into a folder that is not writable fails plainly and writes nothing", () =>
  inTempRoot(async (root) => {
    chmodSync(root, 0o500);
    try {
      const saved = await createMemoryStore(root).save("global", COMMITS);
      assert.equal(saved.saved, false);
      assert.match(saved.saved ? "" : saved.reason, UNAVAILABLE);
      assert.doesNotMatch(saved.saved ? "" : saved.reason, /EACCES|\/|errno/i);
    } finally {
      chmodSync(root, 0o700);
    }
    assert.deepEqual(readdirSync(root), []);
  }));

test("a save when the folder's place is taken by a file fails plainly", () =>
  inTempRoot(async (root) => {
    const blocked = join(root, "memories");
    writeFileSync(blocked, "not a folder");
    const saved = await createMemoryStore(blocked).save("global", COMMITS);
    assert.equal(saved.saved, false);
    assert.match(saved.saved ? "" : saved.reason, UNAVAILABLE);
  }));

test("a save into an unreadable folder fails plainly and leaves its files alone", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", COMMITS);
    chmodSync(join(root, "global"), 0o000);
    try {
      const saved = await store.save("global", { ...COMMITS, name: "editor" });
      assert.equal(saved.saved, false);
      assert.match(saved.saved ? "" : saved.reason, UNAVAILABLE);
    } finally {
      chmodSync(join(root, "global"), 0o700);
    }
    assert.deepEqual(readdirSync(join(root, "global")).sort(), ["MEMORY.md", "commit-style.md"]);
  }));

test("a forgotten Project memory leaves the Project index and moves aside under the Project's folder", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const project = { project: "abc" };
    await store.save(project, COMMITS);
    await store.save("global", COMMITS);
    assert.deepEqual(await store.forget(project, "commit-style"), { forgotten: true, index: "" });
    assert.equal(await store.index(project), "");
    assert.equal(await store.index("global"), "- commit-style: How the person likes commits");
    assert.equal(readdirSync(join(root, "forgotten", "projects", "abc")).length, 1);
    assert.equal(existsSync(join(root, "forgotten", "global")), false);
  }));

test("forgetting a name that exists only in the other scope changes nothing", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    const project = { project: "abc" };
    await store.save("global", COMMITS);
    assert.deepEqual(await store.forget(project, "commit-style"), { forgotten: false, reason: forgetUnknownText("commit-style") });
    await store.save(project, { ...COMMITS, name: "editor" });
    assert.deepEqual(await store.forget("global", "editor"), { forgotten: false, reason: forgetUnknownText("editor") });
    assert.equal(await store.index("global"), "- commit-style: How the person likes commits");
    assert.equal(await store.index(project), "- editor: How the person likes commits");
    assert.equal(existsSync(join(root, "forgotten")), false);
  }));

test("a forget from an unreadable folder fails plainly and leaves its files alone", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", COMMITS);
    chmodSync(join(root, "global"), 0o000);
    try {
      const forgotten = await store.forget("global", "commit-style");
      assert.equal(forgotten.forgotten, false);
      assert.match(forgotten.forgotten ? "" : forgotten.reason, UNAVAILABLE);
      assert.doesNotMatch(forgotten.forgotten ? "" : forgotten.reason, /EACCES|\/|errno/i);
    } finally {
      chmodSync(join(root, "global"), 0o700);
    }
    assert.deepEqual(readdirSync(join(root, "global")).sort(), ["MEMORY.md", "commit-style.md"]);
    assert.equal(existsSync(join(root, "forgotten")), false);
  }));

test("a forget from a read-only folder fails plainly and changes nothing", () =>
  inTempRoot(async (root) => {
    const store = createMemoryStore(root);
    await store.save("global", COMMITS);
    chmodSync(join(root, "global"), 0o500);
    try {
      const forgotten = await store.forget("global", "commit-style");
      assert.equal(forgotten.forgotten, false);
      assert.match(forgotten.forgotten ? "" : forgotten.reason, UNAVAILABLE);
    } finally {
      chmodSync(join(root, "global"), 0o700);
    }
    assert.deepEqual(readdirSync(join(root, "global")).sort(), ["MEMORY.md", "commit-style.md"]);
  }));
