import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// Project root — always the directory where this source file lives (../ = project root)
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
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

function findChromePath(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const candidates = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else if (platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else {
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  return "chrome"; // fallback to PATH
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
    profileDir: resolveFromRoot(env("BROWSER_PROFILE_DIR", fileConfig.profileDir || "./browser-profile")),
    userAgent: envStr("BROWSER_USER_AGENT", fileConfig.userAgent ?? null),
    locale: env("BROWSER_LOCALE", fileConfig.locale || "en-US"),
    proxy: envStr("BROWSER_PROXY", fileConfig.proxy ?? null),
    downloadDir: resolveFromRoot(env("BROWSER_DOWNLOAD_DIR", fileConfig.downloadDir || "./downloads")),
    tracing: envBool("BROWSER_TRACING", fileConfig.tracing ?? false),
    screenshots: envBool("BROWSER_SCREENSHOTS", fileConfig.screenshots ?? false),
    timeoutMs: envInt("BROWSER_TIMEOUT_MS", fileConfig.timeoutMs ?? 30000),
    logLevel: (env("LOG_LEVEL", fileConfig.logLevel || "info") as P1Config["logLevel"]),
    safetyPolicy: (env("SAFETY_POLICY", fileConfig.safetyPolicy || "off") as P1Config["safetyPolicy"]),
    observationCacheSize: envInt("OBSERVATION_CACHE_SIZE", fileConfig.observationCacheSize ?? 100),
  };

  return _config;
}

export function resetConfig(): void {
  _config = null;
}

/** Get the project root directory — useful for install scripts. */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
