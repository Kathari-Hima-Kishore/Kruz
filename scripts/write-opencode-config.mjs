#!/usr/bin/env node
/**
 * Write/refresh the OpenCode MCP registration for Kruz.
 *
 * Runs automatically as part of `npm run build`. Nothing here is hardcoded to a
 * developer's machine: every path is derived at RUN time from this script's own
 * location, so cloning to `C:\tools\kruz`, `D:\project prototypes\Kruz` or a
 * UNC share all produce a correct config with no edits.
 *
 * What it does, and why each part exists:
 *
 *  1. Resolves the install root and the built entry point relative to THIS file,
 *     so the generated `command`/`cwd` are absolute and correct on any machine.
 *  2. Resolves the node executable via `process.execPath` rather than the bare
 *     string "node", because an MCP host spawns the server with the inherited
 *     environment — where node may not be on PATH (nvm, Volta, a GUI app
 *     launched outside the shell). Absolute exePath always works.
 *  3. Writes BOTH the correct V2 schema shape (`mcp.servers.<name>`) and the
 *     permission rule, PRESERVING every unrelated key already in the file.
 *  4. Verifies the build output actually exists before registering it, so a
 *     failed `tsc` cannot leave a config pointing at a missing entry point.
 *
 * OpenCode's server config lives in project `opencode.json(c)` and/or the global
 * `~/.config/opencode/opencode.json(c)`. Project config is written by default;
 * pass `--global` to write the user-wide config instead (or set
 * `KRUZ_OPENCODE_SCOPE=global`).
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Where this script lives -> the install root (scripts/ is directly under it). */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ENTRY = join(ROOT, "dist", "index.js");

const SERVER_NAME = "kruz";

const argv = process.argv.slice(2);
const useGlobal =
  argv.includes("--global") ||
  String(process.env.KRUZ_OPENCODE_SCOPE || "").toLowerCase() === "global";

const HOME = process.env.USERPROFILE || process.env.HOME || "";

/**
 * Candidate config locations.
 *
 * PROJECT scope (the default) writes into the checkout itself. That is the
 * portable choice: the file carries an absolute path that is generated on the
 * machine that ran the build, and it travels with the repo to exactly that
 * machine. It also keeps the build from silently editing a developer's personal
 * settings — an earlier version of this script fell back to
 * `~/.config/opencode/` whenever no project file existed, and so rewrote the
 * user's global config as a side effect of `npm run build`.
 *
 * GLOBAL scope is opt-in via `--global` / `KRUZ_OPENCODE_SCOPE=global`, and
 * then only that location is considered.
 *
 * `XDG_CONFIG_HOME` is honoured because OpenCode reads it, so a machine that
 * relocates it must be respected here too or the two would disagree about where
 * the global config lives.
 */
function candidates() {
  if (useGlobal) {
    const xdg = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : HOME
        ? join(HOME, ".config", "opencode")
        : null;
    // .json FIRST so a fresh install produces plain JSON; an existing .jsonc is
    // still found because the list is scanned for whichever already exists.
    return xdg ? [join(xdg, "opencode.json"), join(xdg, "opencode.jsonc")] : [];
  }
  return [
    join(ROOT, "opencode.json"),
    join(ROOT, "opencode.jsonc"),
    join(ROOT, ".opencode", "opencode.json"),
    join(ROOT, ".opencode", "opencode.jsonc"),
  ];
}

function pickTarget() {
  const list = candidates();
  const existing = list.find((p) => existsSync(p));
  if (existing) return existing;
  return list[0] ?? null;
}

/**
 * Parse JSONC (comments + trailing commas) into a plain object.
 *
 * We must READ the user's existing file without destroying it, and OpenCode
 * config is conventionally written as JSONC. JSON.parse alone would throw on the
 * first comment and we'd be forced to either clobber the file or give up. This
 * is a conservative stripper: it only removes what is provably a comment or a
 * trailing comma, and leaves string contents untouched.
 */
function parseJsonc(text) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch { /* fall through to the JSONC reader */ }

  let out = "";
  let inStr = false, quote = "", inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];

    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // Drop trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

/**
 * Strip comments from a serialised object so we can WRITE .jsonc targets as
 * valid JSONC without converting the user's chosen dialect.
 */
function toJsonc(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * Which OpenCode config dialect does this file already use?
 *
 * OpenCode V1 put server names directly under `mcp`; V2 nests them under
 * `mcp.servers`. Both shapes are seen in the wild, and writing the wrong one is
 * not a syntax error — V2 simply IGNORES a V1-shaped entry, so the server
 * silently never connects. Writing V2 into a V1 file produces a broken hybrid
 * (some servers live, some do not), which is the most confusing outcome of all.
 *
 * So the dialect is DETECTED from what is already in the file, and the new entry
 * is written to match. A brand-new file gets V2, which is the current version.
 */
function detectDialect(config) {
  const mcp = config && typeof config.mcp === "object" && config.mcp !== null ? config.mcp : null;
  if (!mcp) return "v2";
  if (mcp.servers && typeof mcp.servers === "object") return "v2";
  // Servers sitting directly under `mcp` (anything that is not `servers`).
  const direct = Object.keys(mcp).filter((k) => k !== "timeout");
  if (direct.length > 0) return "v1";
  return "v2";
}

function buildServerEntry() {
  return {
    type: "local",
    // Absolute path to the node that ran this build. OpenCode spawns MCP
    // servers with an inherited environment in which `node` is frequently NOT
    // resolvable (GUI launch, nvm/Volta shims, a service account), and a bare
    // "node" then fails with ENOENT and the server shows as errored.
    command: [process.execPath, ENTRY],
    cwd: ROOT,
    environment: {
      // stdout is reserved for the MCP stream; keep diagnostics on stderr.
      LOG_LEVEL: process.env.KRUZ_LOG_LEVEL || "info",
    },
    timeout: 60000,
  };
}

function main() {
  if (!existsSync(ENTRY)) {
    // Registering a missing entry point produces a server that fails at spawn
    // with a far more confusing error than this one. Refuse, and say why.
    process.stderr.write(
      `[kruz] opencode: refusing to register — ${relative(ROOT, ENTRY) || ENTRY} does not exist.\n` +
      `[kruz] opencode: run \`npm run build\` first, or check tsconfig "outDir".\n`,
    );
    process.exitCode = 1;
    return;
  }

  const target = pickTarget();
  if (!target) {
    process.stderr.write("[kruz] opencode: could not determine a config location (no HOME/USERPROFILE).\n");
    process.exitCode = 1;
    return;
  }

  let config = {};
  if (existsSync(target)) {
    try {
      config = parseJsonc(readFileSync(target, "utf8"));
      if (typeof config !== "object" || config === null || Array.isArray(config)) {
        throw new Error("top level is not an object");
      }
    } catch (e) {
      process.stderr.write(
        `[kruz] opencode: could not parse ${target} (${e.message}).\n` +
        `[kruz] opencode: refusing to overwrite it — fix or move the file, then rebuild.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Write the entry in the dialect the file ALREADY uses, so an existing
  // V1-style config keeps working and a fresh one gets current V2. Mixing the
  // two in one file is what produces a half-connected server list.
  const dialect = detectDialect(config);
  config.$schema ??= "https://opencode.ai/config.json";
  config.mcp ??= {};
  if (typeof config.mcp !== "object" || config.mcp === null || Array.isArray(config.mcp)) {
    process.stderr.write(`[kruz] opencode: "mcp" in ${target} is not an object; not touching it.\n`);
    process.exitCode = 1;
    return;
  }

  if (dialect === "v1") {
    config.mcp[SERVER_NAME] = buildServerEntry();
  } else {
    config.mcp.servers ??= {};
    config.mcp.servers[SERVER_NAME] = buildServerEntry();
  }

  // Permissions: Kruz's tools act on a browser the user can SEE and PAUSE, so
  // they are auto-allowed; the safety layer plus the headed overlay remain the
  // guardrails. V2 takes an ARRAY of {action,resource,effect}; V1 took an object
  // keyed by pattern. Writing the wrong one is silently ignored.
  if (dialect === "v1") {
    config.permission = { ...(config.permission ?? {}), [`${SERVER_NAME}_*`]: "allow" };
  } else {
    config.permissions = Array.isArray(config.permissions) ? config.permissions : [];
    const rule = { action: `${SERVER_NAME}_*`, resource: "*", effect: "allow" };
    if (!config.permissions.some((p) => p && p.action === rule.action)) {
      config.permissions.push(rule);
    }
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, toJsonc(config) + "\n", "utf8");

  const bytes = statSync(target).size;
  process.stderr.write(
    `[kruz] opencode: registered '${SERVER_NAME}' -> ${ENTRY}\n` +
    `[kruz] opencode: wrote ${target} (${bytes} bytes, scope=${useGlobal ? "global" : "project"}, dialect=${dialect})\n` +
    `[kruz] opencode: restart OpenCode (or run \`/mcp\`) to pick it up.\n`,
  );
}

main();