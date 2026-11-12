import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  credentialRefusalText,
  descriptionTooLargeText,
  forgetUnknownText,
  indexFullText,
  memoryFolderUnavailableText,
  memoryTooLargeText,
} from "../engine/memoryTools";
import type { ForgetOutcome } from "../engine/types";
import { looksLikeCredential, MAX_DESCRIPTION_BYTES, MEMORY_LIMITS, type MemoryLimits } from "./limits";

export type MemoryScope = "global" | { project: string };

export interface Memory {
  name: string;
  description: string;
  body: string;
}

export type SaveOutcome = { saved: true; index: string; replaced: boolean } | { saved: false; reason: string };

export interface MemoryStore {
  forget(scope: MemoryScope, name: string): Promise<ForgetOutcome>;
  save(scope: MemoryScope, memory: Memory): Promise<SaveOutcome>;
  read(scope: MemoryScope, name: string): Promise<string | undefined>;
  index(scope: MemoryScope): Promise<string>;
}

const INDEX_FILE = "MEMORY.md";
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_LINE = /^description: (.*)$/m;

function parse(file: string): { description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(file);
  if (!match) return { description: "", body: file };
  return { description: DESCRIPTION_LINE.exec(match[1]!)?.[1] ?? "", body: match[2]!.replace(/\n$/, "") };
}

export function createMemoryStore(root: string, limits: MemoryLimits = MEMORY_LIMITS): MemoryStore {
  const within = (scope: MemoryScope) => (scope === "global" ? "global" : join("projects", scope.project));
  const folder = (scope: MemoryScope) => join(root, within(scope));

  async function orUnavailable<T>(attempt: () => Promise<T>, failed: (reason: string) => T): Promise<T> {
    try {
      return await attempt();
    } catch {
      return failed(memoryFolderUnavailableText());
    }
  }

  async function names(scope: MemoryScope): Promise<string[]> {
    try {
      const files = await readdir(folder(scope));
      return files
        .filter((f) => f.endsWith(".md") && f !== INDEX_FILE)
        .map((f) => f.slice(0, -3))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async function index(scope: MemoryScope): Promise<string> {
    const lines: string[] = [];
    for (const name of await names(scope)) {
      const { description } = parse(await readFile(join(folder(scope), `${name}.md`), "utf-8"));
      lines.push(`- ${name}: ${description}`);
    }
    return lines.join("\n");
  }

  async function refusal(scope: MemoryScope, name: string, description: string, body: string): Promise<string | undefined> {
    if (looksLikeCredential(`${description}\n${body}`)) return credentialRefusalText();
    if (Buffer.byteLength(description, "utf-8") > MAX_DESCRIPTION_BYTES) return descriptionTooLargeText(MAX_DESCRIPTION_BYTES);
    if (Buffer.byteLength(body, "utf-8") > limits.maxMemoryBytes) return memoryTooLargeText(limits.maxMemoryBytes);
    const existing = await names(scope);
    if (!existing.includes(name) && existing.length >= limits.maxIndexLines) return indexFullText(limits.maxIndexLines);
    return undefined;
  }

  async function writeIndex(scope: MemoryScope): Promise<string> {
    const current = await index(scope);
    await writeFile(join(folder(scope), INDEX_FILE), `${current}\n`, { mode: 0o600 });
    return current;
  }

  async function write(scope: MemoryScope, { name, description, body }: Memory): Promise<SaveOutcome> {
    if (!VALID_NAME.test(name)) {
      return { saved: false, reason: `"${name}" is not a usable memory name; use lowercase letters, digits and hyphens.` };
    }
    const oneLine = description.replace(/\s+/g, " ").trim();
    const refused = await refusal(scope, name, oneLine, body);
    if (refused) return { saved: false, reason: refused };
    await mkdir(folder(scope), { recursive: true, mode: 0o700 });
    const file = join(folder(scope), `${name}.md`);
    const replaced = (await names(scope)).includes(name);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, `---\nname: ${name}\ndescription: ${oneLine}\n---\n${body}\n`, { mode: 0o600 });
    await rename(tmp, file);
    return { saved: true, index: await writeIndex(scope), replaced };
  }

  async function moveAside(scope: MemoryScope, name: string): Promise<ForgetOutcome> {
    if (!VALID_NAME.test(name) || !(await names(scope)).includes(name)) {
      return { forgotten: false, reason: forgetUnknownText(name) };
    }
    const aside = join(root, "forgotten", within(scope));
    await mkdir(aside, { recursive: true, mode: 0o700 });
    await rename(join(folder(scope), `${name}.md`), join(aside, `${name}.${randomUUID()}.md`));
    return { forgotten: true, index: await writeIndex(scope) };
  }

  return {
    index,

    forget: (scope, name) => orUnavailable(() => moveAside(scope, name), (reason) => ({ forgotten: false, reason })),

    async read(scope, name) {
      if (!VALID_NAME.test(name)) return undefined;
      try {
        return parse(await readFile(join(folder(scope), `${name}.md`), "utf-8")).body;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },

    save: (scope, memory) => orUnavailable(() => write(scope, memory), (reason) => ({ saved: false, reason })),
  };
}
