import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export interface P1Config {
  browserPath: string;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  profileDir: string;
  userAgent: string | null;
  locale: string;
  proxy: string | null;
  downloadDir: string;
  tracing: boolean;
  screenshots: boolean;
  timeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  safetyPolicy: "strict" | "lenient" | "off";
  observationCacheSize: number;
}

/**
 * Project root — the nearest ancestor of THIS FILE that contains a package.json.
 *
 * The previous implementation hardcoded `resolve(dirname(thisFile), "..")`, which
 * only happens to be the root because the file sits exactly one level down
 * (`src/config.ts` -> `dist/config.js`). That is a coincidence of the current
 * layout, not a rule: moving this module into `src/config/`, emitting nested
 * output, or running from a bundler that rewrites the location all silently
 * relocated the profile dir, the lockfile and `config.json` to a sibling
 * directory. Walking up to the real package root makes it layout-independent,
 * which is what "works on any machine" actually requires.
 */
function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No package.json anywhere above us (bundled into a single file). Fall back to
  // the previous one-level-up behaviour rather than throwing at import time.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const PROJECT_ROOT = findProjectRoot();

/**
 * Per-user writable directory for Kruz state that must NOT live in the install
 * directory.
 *
 * `browser-profile` and `downloads` default to `./…` under the project root,
 * which is correct for a git clone but FAILS on a machine where the install
 * directory is read-only — a global npm prefix (`%APPDATA%\npm`), a Program
 * Files copy, or a container image. When the project root is not writable we
 * relocate those defaults to a per-user location instead of crashing on
 * `mkdirSync`.
 */
function defaultStateDir(name: string): string {
  // Memoised: this probes the filesystem, and loadConfig() is called from many
  // hot-ish paths. The answer cannot change within a process.
  const memo = _stateDirMemo.get(name);
  if (memo) return memo;

  const candidate = resolve(PROJECT_ROOT, name);
  const probe = join(candidate, ".kruz-write-probe");
  let out: string;
  try {
    // Creating the dir is the real test: a nested mkdir fails if any parent is
    // read-only, which is exactly the global-npm-prefix / Program-Files case.
    mkdirSync(candidate, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    out = candidate;
  } catch {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const base =
      (process.platform === "win32" && process.env.LOCALAPPDATA) ||
      (process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : process.env.XDG_STATE_HOME || join(home, ".local", "state")) ||
      join(process.env.TEMP || "/tmp", "kruz");
    out = join(base, "kruz", name);
  }
  _stateDirMemo.set(name, out);
  return out;
}

const _stateDirMemo = new Map<string, string>();

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  // A non-numeric or NaN value ("BROWSER_TIMEOUT_MS=abc") previously yielded
  // NaN, which propagated into every `setTimeout(NaN)` and timeout comparison
  // downstream — a comparison against NaN is always false, so the timeout
  // silently stopped existing rather than failing loudly at the source.
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce a value to a closed set of string literals, case-insensitively, with
 * env winning over `config.json` and both winning over the built-in default.
 *
 * These fields were previously raw `as` casts of arbitrary strings, so
 * `SAFETY_POLICY=Strict` (wrong case) or a typo produced a config object whose
 * TYPE claimed a valid union member while holding something else. The safety
 * layer then matched none of its branches and treated EVERY action as safe —
 * a typo silently disabled the safety policy rather than being rejected.
 */
function pickEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fileValue: unknown,
  fallback: T,
): T {
  const matches = (raw: unknown): T | undefined =>
    allowed.find((a) => a.toLowerCase() === String(raw ?? "").trim().toLowerCase());

  return (
    (process.env[key] !== undefined && process.env[key] !== "" ? matches(process.env[key]) : undefined) ??
    matches(fileValue) ??
    fallback
  );
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

function envStr(key: string, fallback: string | null): string | null {
  return process.env[key] || fallback;
}

/** Resolve a path: if absolute, return as-is; if relative, resolve from project root. */
function resolveFromRoot(p: string): string {
  if (/^[A-Za-z]:[\\\/]/.test(p) || p.startsWith("/")) return resolve(p);
  return resolve(PROJECT_ROOT, p);
}

/**
 * Candidate browser executables for the current platform.
 *
 * Every Windows path is derived from the ENVIRONMENT (`PROGRAMFILES`,
 * `PROGRAMFILES(X86)`, `LOCALAPPDATA`, `PROGRAMW6432`) rather than from a
 * literal `C:/Program Files`. The previous list was three hardcoded C: paths,
 * which is wrong on a machine where:
 *  - Chrome is installed per-user under a redirected/moved LOCALAPPDATA,
 *  - the system drive is not C: (a real, common corporate layout),
 *  - a 64-bit Chrome was installed by a 32-bit installer, or vice versa,
 *  - the user has Chromium / Edge / Brave, which are all CDP-compatible and
 *    are the executable on plenty of machines where Chrome is absent.
 *
 * So: environment-derived installs first, then the registry (the authoritative
 * answer when a user relocated Chrome to a custom directory), then Chromium
 * variants and other Chromium-based browsers.
 */
function browserCandidates(): string[] {
  const platform = process.platform;

  if (platform === "win32") {
    // PROGRAMFILES(X86) needs brackets in the env name only for JS property
    // access; read it from process.env directly.
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || join(pf, "(x86)");
    const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local");
    const programW6432 = process.env.PROGRAMW6432;

    const roots = [pf, programW6432, pf86, local].filter(Boolean) as string[];

    const out: string[] = [];
    for (const r of roots) {
      out.push(
        join(r, "Google", "Chrome", "Application", "chrome.exe"),
        join(r, "Chromium", "Application", "chrome.exe"),
        join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      );
    }
    // Per-user (non-elevated) installs live under LOCALAPPDATA only.
    out.push(
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Chromium", "Application", "chrome.exe"),
      join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    );
    return out;
  }

  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      // Homebrew installs are not in /Applications.
      "/opt/homebrew/bin/chromium",
      "/usr/local/bin/chromium",
      "/usr/bin/chromium",
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
    "/opt/chromium/chrome",
  ];
}

/**
 * Ask the Windows registry where a Chromium browser actually lives.
 *
 * This is the only reliable answer when Chrome was installed to a custom
 * directory, which the Google installer supports and which no fixed list of
 * well-known paths can cover. Read-only, best-effort, and every failure (no
 * registry, no `reg.exe`, access denied) returns null rather than throwing.
 */
function chromePathFromRegistry(): string | null {
  if (process.platform !== "win32") return null;
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  ];
  for (const key of keys) {
    try {
      const out = execFileSync("reg.exe", ["query", key, "/ve"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // `REG_SZ    C:\Program Files\...\chrome.exe`
      const m = /REG_SZ\s+(.+)/.exec(out);
      const p = m?.[1]?.trim().replace(/^"|"$/g, "");
      if (p && existsSync(p)) return p;
    } catch {
      // Key absent or unreadable — try the next one.
    }
  }
  return null;
}

function findChromePath(): string {
  for (const p of browserCandidates()) {
    try {
      if (p && existsSync(p)) return p;
    } catch { /* malformed path on this platform — skip */ }
  }
  const reg = chromePathFromRegistry();
  if (reg) return reg;
  return "chrome"; // last resort: resolve from PATH by the browser process
}

let _config: P1Config | null = null;

export function loadConfig(): P1Config {
  if (_config) return _config;

  // Try to load config.json from project root
  let fileConfig: Partial<P1Config> = {};
  const configPath = resolve(PROJECT_ROOT, "config.json");
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch { /* ignore */ }
  }

  _config = {
    browserPath: env("BROWSER_PATH", fileConfig.browserPath || findChromePath()),
    headless: envBool("BROWSER_HEADLESS", fileConfig.headless ?? false),
    viewportWidth: envInt("BROWSER_VIEWPORT_WIDTH", fileConfig.viewportWidth ?? 1280),
    viewportHeight: envInt("BROWSER_VIEWPORT_HEIGHT", fileConfig.viewportHeight ?? 720),
    // Falls back to a per-user writable dir when the install dir is read-only.
    profileDir: resolveFromRoot(env("BROWSER_PROFILE_DIR", fileConfig.profileDir || defaultStateDir("browser-profile"))),
    userAgent: envStr("BROWSER_USER_AGENT", fileConfig.userAgent ?? null),
    locale: env("BROWSER_LOCALE", fileConfig.locale || "en-US"),
    proxy: envStr("BROWSER_PROXY", fileConfig.proxy ?? null),
    downloadDir: resolveFromRoot(env("BROWSER_DOWNLOAD_DIR", fileConfig.downloadDir || defaultStateDir("downloads"))),
    tracing: envBool("BROWSER_TRACING", fileConfig.tracing ?? false),
    screenshots: envBool("BROWSER_SCREENSHOTS", fileConfig.screenshots ?? false),
    timeoutMs: envInt("BROWSER_TIMEOUT_MS", fileConfig.timeoutMs ?? 30000),
    logLevel: pickEnum("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, fileConfig.logLevel, "info"),
    safetyPolicy: pickEnum("SAFETY_POLICY", ["strict", "lenient", "off"] as const, fileConfig.safetyPolicy, "off"),
    observationCacheSize: envInt("OBSERVATION_CACHE_SIZE", fileConfig.observationCacheSize ?? 100),
  };

  return _config;
}

export function resetConfig(): void {
  _config = null;
  // Clear the writability probe cache too, so a caller that changes the
  // environment (or the install dir's permissions) actually re-resolves.
  _stateDirMemo.clear();
}

/** Get the project root directory — useful for install scripts. */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
