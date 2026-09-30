import { PuppeteerEngine } from "./engines/puppeteer-engine.js";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type P1Config } from "../config.js";
import type { BrowserEngine } from "./engine.js";

export interface LaunchedBrowser {
  engine: BrowserEngine;
  config: P1Config;
}

/** Build a P1Config with the requested launch overrides merged in. */
function buildConfig(overrides: NonNullable<Parameters<typeof launchBrowser>[0]> | undefined): P1Config {
  const base = loadConfig();
  return {
    ...base,
    headless: false,
    profileDir: overrides?.profileDir ?? base.profileDir,
    downloadDir: overrides?.downloadDir ?? base.downloadDir,
    viewportWidth: overrides?.viewportWidth ?? base.viewportWidth,
    viewportHeight: overrides?.viewportHeight ?? base.viewportHeight,
    userAgent: overrides?.userAgent ?? base.userAgent,
    locale: overrides?.locale ?? base.locale,
    proxy: overrides?.proxy ?? base.proxy,
  } as P1Config;
}

/**
 * Launch a headed Chrome browser using Puppeteer.
 * Uses Chrome's user data directory for persistent sessions.
 */
export async function launchBrowser(overrides?: {
  headless?: boolean;
  profileDir?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  userAgent?: string;
  locale?: string;
  proxy?: string;
  downloadDir?: string;
  startupUrl?: string;
}): Promise<LaunchedBrowser> {
  const config = buildConfig(overrides);
  const headless = config.headless;
  const profileDir = resolve(config.profileDir);
  const downloadDir = resolve(config.downloadDir);

  // Ensure directories exist
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }
  if (!existsSync(downloadDir)) {
    mkdirSync(downloadDir, { recursive: true });
  }

  const chromeArgs: string[] = [
    "--disable-blink-features=AutomationControlled",
    "--allow-file-access-from-files",
  ];

  // Only maximize if running headed AND no custom viewport was requested
  if (!headless && !overrides?.viewportWidth && !overrides?.viewportHeight) {
    chromeArgs.unshift("--start-maximized");
  }

  // Configure the base P1Config so the engine knows the launch settings; the
  // boot() signature takes (config, profileDir) so we pass config + profileDir.
  const engine = new PuppeteerEngine(true);
  try {
    await engine.boot(config, profileDir);
  } catch (cause) {
    await closeBrowser(engine);
    const error = new Error(`Could not start Chrome with profile '${profileDir}'. Another MCP process or Chrome may be using this profile; compare server_instance_id, or choose a separate profile_dir. No existing browser was attached or stopped. Cause: ${cause}`);
    Object.assign(error, { code: "BROWSER_LAUNCH_FAILED" });
    throw error;
  }

  // Navigate to startup URL if provided
  if (overrides?.startupUrl) {
    await engine.navigate(overrides.startupUrl, "domcontentloaded", 45000).catch(() => {});
  }

  return { engine, config };
}

/**
 * Close a browser session gracefully.
 */
export async function closeBrowser(engine: BrowserEngine): Promise<void> {
  try {
    await (engine as any).shutdown?.();
  } catch {
    // Ignore errors during close
  }
}
