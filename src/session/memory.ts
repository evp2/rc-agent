import { join } from "node:path";

import { memoryStartupText } from "../engine/memoryTools";
import type { OpenOptions, RememberScope } from "../engine/types";
import { projectScope } from "../memory/projectScope";
import { createMemoryStore, type MemoryScope } from "../memory/store";
import { STATE_DIR } from "../state";

export const MEMORY_ROOT = join(STATE_DIR, "memories");

async function resolveScope(scope: RememberScope, projectDir: string): Promise<MemoryScope> {
  return scope === "global" ? "global" : projectScope(projectDir);
}

/** The Memory callbacks for an Engine that keeps its Memories in the connector's store. */
export function memoryOptions(
  projectDir: string,
  root: string = MEMORY_ROOT,
): Pick<OpenOptions, "onRemember" | "onForget" | "startupText"> {
  const store = createMemoryStore(root);
  const indexOf = async (scope: RememberScope): Promise<{ index: string; folder: string } | undefined> => {
    try {
      const where = await resolveScope(scope, projectDir);
      return { index: await store.index(where), folder: where === "global" ? join(root, "global") : join(root, "projects", where.project) };
    } catch {
      return undefined;
    }
  };
  return {
    onRemember: async ({ scope, name, description, content }) =>
      store.save(await resolveScope(scope, projectDir), { name, description, body: content }),
    onForget: async ({ scope, name }) => store.forget(await resolveScope(scope, projectDir), name),
    startupText: async () => {
      const global = await indexOf("global");
      const project = await indexOf("project");
      if (!global && !project) return undefined;
      return memoryStartupText(
        { global: global?.index ?? "", project: project?.index ?? "" },
        { global: global?.folder ?? "", project: project?.folder ?? "" },
      );
    },
  };
}
