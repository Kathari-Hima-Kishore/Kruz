import { readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export const KRUZ_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/**
 * Build provenance.
 *
 * The manual report was produced against "server v1.7.1" and it was not possible
 * to tell from the outside whether the connected client was running the code in
 * this working tree. That is a real operational hazard: you cannot debug browser
 * behaviour against a possibly-stale process, and a version number that does not
 * change across builds hides it completely.
 *
 * So every `server.info` call now reports the identity of the actual compiled
 * artifact this process loaded, plus the source commit it was built from. If a
 * client is connected to a build that does not match the working tree, that is
 * now visible instead of guessed at.
 */
export interface BuildInfo {
  version: string;
  entry: string;
  /** ISO timestamp of the compiled entry point actually running. */
  built_at: string | null;
  /** Source commit the tree was at when this process started, if determinable. */
  source_commit: string | null;
  source_dirty: boolean | null;
  node_version: string;
  pid: number;
  started_at: string;
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  // dist/ at runtime, src/ under tsx; both sit directly under the project root.
  const root = existsSync(join(dir, "..", "package.json")) ? join(dir, "..") : dir;

  let builtAt: string | null = null;
  let entry = join(dir, "index.js");
  try {
    entry = fileURLToPath(import.meta.url);
    builtAt = statSync(entry).mtime.toISOString();
  } catch { /* not on disk (bundled): leave null */ }

  let commit: string | null = null;
  let dirty: boolean | null = null;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch { /* not a git checkout */ }

  cached = {
    version: KRUZ_VERSION,
    entry,
    built_at: builtAt,
    source_commit: commit,
    source_dirty: dirty,
    node_version: process.version,
    pid: process.pid,
    started_at: new Date((globalThis as any).__KRUZ_START__ ?? Date.now()).toISOString(),
  };
  return cached;
}
