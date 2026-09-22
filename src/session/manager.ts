import type { BrowserEngine, KruzTab } from "../browser/engine.js";
import { launchBrowser, closeBrowser } from "../browser/launcher.js";
import { Observer } from "../extractor/observer.js";
import { FidelityExtractor } from "../extractor/fidelity.js";
import type { P1Config } from "../config.js";

export interface SessionState {
  id: string;
  status: "active" | "paused" | "closed";
  createdAt: string;
  engine: BrowserEngine | null;
  observer: Observer;
  extractor: FidelityExtractor;
  config: P1Config;
  navigationTrace: NavigationTraceEntry[];
}

export interface NavigationTraceEntry {
  timestamp: string;
  action: string;
  url: string;
  pageId: string;
}

let sessionCounter = 0;

/**
 * Session manager. Manages the lifecycle of browser sessions.
 */
export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private activeSessionId: string | null = null;
  private creating: Promise<SessionState> | null = null;

  get isCreating(): boolean { return this.creating !== null; }

  /**
   * Create a new browser session.
   */
  async create(overrides?: {
    headless?: boolean;
    profileDir?: string;
    viewportWidth?: number;
    viewportHeight?: number;
    userAgent?: string;
    locale?: string;
    proxy?: string;
    downloadDir?: string;
    startupUrl?: string;
  }): Promise<SessionState> {
    if (this.creating) return this.creating;
    const active = this.getActive();
    if (active?.engine?.connected) return active;
    this.creating = this.launch(overrides);
    try { return await this.creating; }
    finally { this.creating = null; }
  }

  private async launch(overrides?: Parameters<typeof launchBrowser>[0]): Promise<SessionState> {
    const previous = this.getActive();
    if (previous) await this.close(previous.id);
    const id = `session_${++sessionCounter}`;
    const { engine, config } = await launchBrowser(overrides);

    const observer = new Observer(config.observationCacheSize);
    const extractor = new FidelityExtractor();

    const state: SessionState = {
      id,
      status: "active",
      createdAt: new Date().toISOString(),
      engine,
      observer,
      extractor,
      config,
      navigationTrace: [],
    };

    this.sessions.set(id, state);
    this.activeSessionId = id;

    return state;
  }

  /**
   * Get the active session.
   */
  getActive(): SessionState | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  /**
   * Get session by ID.
   */
  get(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Get the active engine for a session.
   */
  getActiveEngine(sessionId?: string): BrowserEngine | null {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActive();
    return session?.engine ?? null;
  }

  /**
   * Pause the active session (for human takeover).
   */
  async pause(sessionId?: string): Promise<boolean> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActive();
    if (!session || session.status !== "active") return false;

    session.status = "paused";

    // Bring the browser window to front so user can interact
    if (session.engine) {
      await session.engine.bringToFront().catch(() => {});
    }

    return true;
  }

  /**
   * Resume a paused session.
   */
  async resume(sessionId?: string): Promise<boolean> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActive();
    if (!session || session.status !== "paused") return false;

    session.status = "active";

    // Invalidate cache since page may have changed during pause
    session.observer.clearCache();

    return true;
  }

  /**
   * Close a session.
   */
  async close(sessionId?: string, graceful = true): Promise<boolean> {
    if (!sessionId && this.creating) {
      try { await this.creating; } catch { return false; }
    }
    const id = sessionId || this.activeSessionId;
    if (!id) return false;

    const session = this.sessions.get(id);
    if (!session) return false;

    try {
      if (graceful && session.engine) {
        await closeBrowser(session.engine);
      } else if (session.engine) {
        await session.engine.close();
      }
    } catch {
      // Ignore close errors
    }

    session.status = "closed";
    session.engine = null;

    if (this.activeSessionId === id) {
      this.activeSessionId = null;
    }

    return true;
  }

  /**
   * Add a navigation trace entry.
   */
  trace(sessionId: string, action: string, url: string, pageId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.navigationTrace.push({
      timestamp: new Date().toISOString(),
      action,
      url,
      pageId,
    });

    // Keep trace compact - last 50 entries
    if (session.navigationTrace.length > 50) {
      session.navigationTrace = session.navigationTrace.slice(-50);
    }
  }

  /**
   * Get navigation trace for a session.
   */
  getTrace(sessionId: string): NavigationTraceEntry[] {
    return this.sessions.get(sessionId)?.navigationTrace ?? [];
  }

  /**
   * Get all active sessions.
   */
  listActive(): SessionState[] {
    return Array.from(this.sessions.values()).filter((s) => s.status === "active");
  }

  /**
   * Count of active sessions.
   */
  get activeCount(): number {
    return this.listActive().length;
  }

  /**
   * Open a new tab in the active session and switch to it.
   * Returns the new tab id.
   */
  async newTab(url?: string, sessionId?: string): Promise<{ id: string; tab: KruzTab } | null> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActive();
    if (!session || !session.engine) return null;

    const tab = await session.engine.newTab(url);
    return { id: tab.id, tab };
  }

  /**
   * Close a tab in the active session.
   */
  async closeTab(pageId: string, sessionId?: string): Promise<boolean> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActive();
    if (!session || !session.engine) return false;

    try {
      await session.engine.closeTab(pageId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List the tabs in the active session.
   */
  async listTabs(sessionId?: string): Promise<KruzTab[]> {
    const session = sessionId ? this.sessions.get(sessionId) : this.getActive();
    if (!session || !session.engine) return [];
    return session.engine.listTabs();
  }

  /**
   * Attach to an already-running browser via CDP.
   */
  async attach(endpoint: string, sessionId?: string): Promise<SessionState | null> {
    const id = sessionId || `session_${++sessionCounter}`;
    const { PuppeteerEngine } = await import("../browser/engines/puppeteer-engine.js");
    const { connect } = await import("puppeteer-core");

    // Normalize ws:// or wss:// or raw http endpoint to a browserWSEndpoint
    let wsEndpoint = endpoint;
    if (!/^ws:|^wss:/.test(endpoint)) {
      wsEndpoint = (await connect({ browserURL: endpoint }).catch(() => null))?.wsEndpoint?.() ?? endpoint;
    }

    const engine = new PuppeteerEngine(false, wsEndpoint);
    const config = { profileDir: "attach", headless: false } as P1Config;
    try {
      await engine.boot(config, "attach");
    } catch {
      return null;
    }

    const observer = new Observer(config.observationCacheSize ?? 1000);
    const extractor = new FidelityExtractor();

    const state: SessionState = {
      id, status: "active", createdAt: new Date().toISOString(),
      engine, observer, extractor, config, navigationTrace: [],
    };
    this.sessions.set(id, state);
    this.activeSessionId = id;
    return state;
  }
}
