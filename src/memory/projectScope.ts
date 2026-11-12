import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

function gitCommonDir(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 5000 }, (err, stdout) => {
      done(err ? undefined : stdout.trim() || undefined);
    });
  });
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** The Project scope for a directory: its repository's shared git folder when it has one, else its own path. */
export async function projectScope(projectDir: string): Promise<{ project: string }> {
  const dir = await real(projectDir);
  const common = await gitCommonDir(dir);
  const root = common ? await real(resolve(dir, common)) : dir;
  const label = basename(common ? resolve(root, "..") : root).replace(/[^A-Za-z0-9._-]/g, "_");
  return { project: `${label}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}` };
}
