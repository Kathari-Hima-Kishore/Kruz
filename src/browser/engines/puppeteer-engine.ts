/**
 * PuppeteerEngine — default BrowserEngine implementation.
 *
 * Wraps `puppeteer-core` connected to a Chrome launched via
 * `--remote-debugging-port`. Same Chromium as Playwright, same CDP under
 * the hood, but without Playwright's Locator abstraction and without the
 * bundled browser download.
 *
 * Lifecycle:
 *   1. Kruz launcher spawns Chrome with the right flags.
 *   2. PuppeteerEngine connects to Chrome's CDP WebSocket.
 *   3. Every `page.*` action in Kruz goes through this engine.
 *
 * Element handles:
 *   KruzElement is just an opaque `{ handle, strategy, target, resolvedAt }`.
 *   The `handle` is a CSS selector string that we re-resolve on every action
 *   (lazy resolution) so stale-element errors are handled gracefully.
 */

import puppeteer, { type Page, type Browser, type ElementHandle, type Dialog } from "puppeteer-core";
import type {
  BrowserEngine, KruzElement, KruzFrame, EvalResult, NetworkEvent,
  ConsoleEvent, DialogEvent, KruzTab, EngineCapability,
} from "../engine.js";
import type { Target, Fallback } from "../../types/schema.js";
import type { P1Config } from "../../config.js";
import { computePath, stepDelaysMs, resamplePath, visualLayerScript } from "../visual-cursor.js";
import { stealthScript } from "../stealth.js";

/* ── tiny helpers ──────────────────────────────────────────────────── */

function escCSS(s: string): string {
  return s.replace(/([\\\"\#.:;,!>+~\/\[\](){}|\s$%@&*=])/g, "\\$1");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const NAV_WAIT_MAP: Record<string, "networkidle0" | "networkidle1" | "domcontentloaded" | "load"> = {
  load: "load",
  domcontentloaded: "domcontentloaded",
  networkidle: "networkidle1",
  networkidle0: "networkidle0",
  commit: "domcontentloaded",
};

// Real cap for captured response bodies. The run log's Workday crash arrived with
// network.capture on: memory accumulated because the body buffer was never actually
// truncated (the `truncated` flag was set but the body kept in full) and the event
// list grew without bound.
const NETWORK_BODY_MAX_CHARS = 200_000;
// Ring cap on retained events: drop the oldest past this many. Without it, a full
// capture session on a response-rich SPA grew the array for the whole run.
const NETWORK_EVENT_CAP = 500;

/* ── engine ───────────────────────────────────────────────────────── */

export class PuppeteerEngine implements BrowserEngine {
  readonly kind = "puppeteer" as const;
  private _page: Page | null = null;
  private _browser: Browser | null = null;
  // K32: tab ids were URL strings — any navigation changed the id, which made
  // switchTab/closeTab silently no-op and dropped tabs from listTabs on reload.
  // Assign each Page a stable id at first sight, keyed by the Page reference.
  private _tabIds = new Map<Page, string>();
  private _tabCounter = 0;
  private _handledPages = new WeakSet<Page>();
  private _connected = false;
  private _networkEvents: NetworkEvent[] = [];
  private _networkEnabled = false;
  private _captureBodies = false;
  /**
   * Whether request interception is currently INSTALLED on `_page`
   * (`null` = unknown, so the next call re-asserts instead of assuming).
   *
   * This exists because `setRequestInterception` was being re-issued on every
   * single `page.open` (via controller.listen) and on every `switchTab`, to put
   * a page into a state it was usually already in. That is not free: see
   * `setInterception` below for why the redundant call was the expensive part.
   */
  private _interceptionOn: boolean | null = null;
  private _consoleEvents: ConsoleEvent[] = [];
  private _consoleEnabled = false;
  private _dialogQueue: { page: Page; dialog: Dialog; event: DialogEvent }[] = [];
  private _dialogPolicy?: { action: "accept" | "dismiss"; value?: string };
  private _config: P1Config | null = null;
  /**
   * The display's REAL device pixel ratio, captured before any viewport emulation.
   *
   * Puppeteer's `page.setViewport` defaults `deviceScaleFactor` to 1. Applying a
   * viewport without restoring the real ratio would silently change every element
   * crop from DEVICE pixels to CSS pixels (a 238x250 CSS box is 298x313 at dpr
   * 1.25 today, and would become 238x250) — which breaks the vision pipeline's
   * `image_space: device_px` contract and every size assertion built on it.
   */
  private _dpr = 1;
  private evaluateTimeoutMs = 5000;
  /** Last point the visible cursor acted on, so a later glide starts there. */
  private _lastCursor?: { x: number; y: number };

  constructor(private readonly launchBrowser: boolean, private readonly cdpEndpoint?: string) {}

  get connected(): boolean { return this._connected && !!this._browser?.connected; }

  /* ── lifecycle ─────────────────────────────────────────────── */

  async boot(config: P1Config, profileDir: string): Promise<void> {
    this._config = config;
    if (this.launchBrowser) {
      const chromeFlags = [
        // NOTE: --disable-blink-features=AutomationControlled was removed on
        // purpose. Chrome shows the "You are using an unsupported command-line
        // flag ... Stability and security will suffer" infobar for it, which is
        // both a UX wart and a tell in front of the user. The automation tells
        // it protects are neutralised in-page instead (see stealthScript(),
        // injected at document_start in the MAIN world): navigator.webdriver,
        // the missing window.chrome.runtime and the CDP/plugin query leaks.
        "--allow-file-access-from-files",
        ...(config.headless ? [] : ["--start-maximized"]),
      ];
      this._browser = await puppeteer.launch({
        executablePath: config.browserPath || undefined,
        headless: config.headless ? true : false,
        userDataDir: profileDir,
        args: chromeFlags,
        defaultViewport: null,
        ignoreDefaultArgs: ["--enable-automation", "--disable-extensions", "--disable-component-extensions-with-background-pages"],
      });
    } else if (this.cdpEndpoint) {
      this._browser = await puppeteer.connect({ browserWSEndpoint: this.cdpEndpoint });
    } else {
      throw new Error("PuppeteerEngine: either launchBrowser=true or cdpEndpoint required");
    }
    const pages = await this._browser.pages();
    this._page = pages[0] ?? (await this._browser.newPage());
    this.attachHandlers(this._page);
    // Capture the display's real DPR before any Emulation override is applied, so
    // setViewportSize() can pin the CSS viewport WITHOUT collapsing device pixels.
    const dpr = await this.page.evaluate(() => window.devicePixelRatio).catch(() => 1);
    if (typeof dpr === "number" && dpr > 0) this._dpr = dpr;
    // Automation tells are removed in-page at document_start (see stealth.ts) —
    // this replaces the --disable-blink-features=AutomationControlled flag, which
    // Chrome answers with an "unsupported command-line flag" infobar.
    await this.installStealth().catch(() => {});
    // K31+: If Chrome dies (renderer OOM, hard crash on a hostile page) puppeteer fires
    // "disconnected" — without this, `connected` stays true and callers would think the
    // session is alive while every call hangs. Marking it false lets the router's
    // openWithRetry pick up BROWSER_CRASHED and auto-recreate the session instead of
    // reporting a misleading PAGE_NOT_READY.
    this._browser.on("disconnected", () => { this._connected = false; });
    this._connected = true;
  }

  async shutdown(): Promise<void> {
    if (this._browser && this.launchBrowser) {
      await this._browser.close().catch(() => {});
    } else if (this._browser) {
      await this._browser.disconnect().catch(() => {});
    }
    this._page = null;
    this._browser = null;
    this._connected = false;
  }

  get page(): Page {
    if (!this._page || this._page.isClosed()) throw new Error("No active page");
    return this._page;
  }

  private attachHandlers(p: Page): void {
    if (this._handledPages.has(p)) return;
    this._handledPages.add(p);
    // Request listener lives here (once per page object) — NOT in
    // enableNetworkCapture, which runs per-navigation and stacked duplicate
    // listeners until requests double-handled and crashed the process.
    p.on("request", this._onRequest);
    p.on("dialog", async (dlg) => {
      const type: DialogEvent["type"] = dlg.type() === "beforeunload" ? "beforeunload" : dlg.type();
      // Keep the actual Puppeteer Dialog until an explicit page.dialog call.
      // No standing auto-accept policy: confirm() can trigger unwanted actions.
      const policy = this._dialogPolicy;
      if (policy) {
        try { if (policy.action === "accept") await dlg.accept(policy.value); else await dlg.dismiss(); } catch { /* closed */ }
      } else this._dialogQueue.push({ page: p, dialog: dlg, event: { type, message: dlg.message(), defaultValue: dlg.defaultValue() } });
    });
    p.on("close", () => { this._dialogQueue = this._dialogQueue.filter(d => d.page !== p); });
    p.on("console", (msg) => {
      if (!this._consoleEnabled) return;
      this._consoleEvents.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location()?.url ? { url: msg.location().url!, lineNumber: msg.location().lineNumber! } : undefined,
      });
    });
    p.on("response", async (res) => {
      if (!this._networkEnabled) return;
      const req = res.request();
      const evt: NetworkEvent = {
        url: req.url(),
        method: req.method(),
        status: res.status(),
        contentType: res.headers()["content-type"] || undefined,
      };
      if (this._captureBodies && (res.headers()["content-type"] || "").includes("json")) {
        try {
          const txt = await res.text();
          // Previously `evt.body = txt` stored the FULL body while `truncated` was
          // still only ever a flag saying it *would* be 200KB — contradicting itself.
          // SYMMETRIC FIX: truncate the stored body for real, keep the flag honest.
          // On Workday's JSON-heavy board that turned the buffer into an unbounded,
          // multi-hundred-KB-per-response copy of the session.
          if (txt.length > NETWORK_BODY_MAX_CHARS) {
            evt.body = txt.slice(0, NETWORK_BODY_MAX_CHARS);
            evt.truncated = true;
          } else {
            evt.body = txt;
            evt.truncated = false;
          }
        } catch { /* ignore */ }
      }
      this._networkEvents.push(evt);
      // Bound the buffer: drop oldest so a long capture session cannot retain
      // every response — with bodies now capped per event, the cap per EVENT was the
      // remaining growth vector.
      if (this._networkEvents.length > NETWORK_EVENT_CAP) {
        this._networkEvents.splice(0, this._networkEvents.length - NETWORK_EVENT_CAP);
      }
    });
  }

  /* ── page-level ─────────────────────────────────────────────── */

  async url(): Promise<string> { return this.page.url(); }
  async title(): Promise<string> {
    // K31: bound like evaluate — Page.getTitle can hang right after a goto timeout.
    try { return await this.withEvaluateTimeout(this.page.title()); }
    catch { return ""; }
  }
  /**
 * The page's REAL layout viewport, measured in-page.
 *
 * This deliberately does NOT use `page.viewport()`. That returns the CDP emulation
 * override — i.e. what Puppeteer was told to emulate — and falls back to a hardcoded
 * 1280x720 when emulation is off. So it can never disagree with what was requested,
 * which made it useless as the read-back in `mkSession`: the reported "measured"
 * viewport was the request echoed back, and a headed window at a genuinely different
 * size went unreported (DEF-5).
 *
 * `window.innerWidth/innerHeight` is the layout viewport the page actually renders
 * into, and it is what responsive breakpoints key off — so it is the number that
 * determines which elements exist. Falls back to the emulation value only if the
 * page cannot be evaluated.
 */
async viewportSize(): Promise<{ width: number; height: number; dpr?: number }> {
    // NOTE: `this.page.evaluate` is the raw Puppeteer page, so it resolves to the
    // value itself — NOT the engine's `{ ok, result }` EvalResult wrapper. Reading
    // `.ok`/`.result` here silently always failed and fell through to the hardcoded
    // default, which is why the first attempt at this fix appeared to do nothing.
    const m: any = await this.page
      .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }))
      .catch(() => null);
    if (m && typeof m.width === "number" && m.width > 0 && typeof m.height === "number" && m.height > 0) {
      // `dpr` rides along so a capture can declare its own coordinate space
      // (device px vs the CSS px `clickAt` expects) instead of leaving the caller
      // to infer the ratio — see controller.screenshot (E-008).
      return { width: m.width, height: m.height, dpr: typeof m.dpr === "number" && m.dpr > 0 ? m.dpr : 1 };
    }
    const vp = this.page.viewport();
    return vp ? { width: vp.width, height: vp.height, dpr: 1 } : { width: 1280, height: 720, dpr: 1 };
  }
  async setViewportSize(w: number, h: number): Promise<void> {
    // Pin the CSS viewport for determinism WITHOUT touching the device scale
    // factor. Responsive layouts flip between mobile and desktop variants at a
    // media-query breakpoint, so an agent that lets window.innerWidth follow the
    // window manager can find a control it observed simply gone after the user
    // un-maximizes. But Puppeteer defaults deviceScaleFactor to 1, which would
    // turn every element crop from device pixels into CSS pixels.
    await this.page.setViewport({ width: w, height: h, deviceScaleFactor: this._dpr });
  }

  /** The real device pixel ratio this engine preserves across viewport emulation. */
  get deviceScaleFactor(): number { return this._dpr; }
  async bringToFront(): Promise<void> {
    // K31: Page.bringToFront CDP can hang without responding right after a goto timeout.
    // It's a focus ping on an already-active page (we just navigated it), so a short bound
    // is plenty — the old 5s credit here was ~4s of open()'s overhead on slow portals.
    try { await this.withEvaluateTimeout(this.page.bringToFront(), 1500); }
    catch { /* best-effort; the page is already active if we just navigated it */ }
  }
  /**
 * Close the ACTIVE TAB only. The browser process and every other tab keep running.
 *
 * This is what `session.close({graceful:false})` used to call, which made "hard
 * close" the *weakest* close available: Chrome survived with all its tabs, still
 * holding the `--user-data-dir` lock, so the next `session.create` failed with
 * BROWSER_LAUNCH_FAILED (13 orphaned chrome.exe reported). Use `terminate()` to
 * actually release the profile.
 */
async close(): Promise<void> { await this.page.close().catch(() => {}); }

/**
 * Terminate the whole browser process, releasing the profile directory lock.
 *
 * `shutdown()` only closes Chrome when Kruz launched it; when Kruz merely attached
 * to an existing browser it calls `disconnect()`, which deliberately leaves the
 * user's browser running. Neither is right for a forced teardown, so this escalates:
 * close the browser, then kill the process if it is still alive.
 *
 * Used by `session.close({graceful:false})` — the caller has explicitly asked for a
 * hard stop and accepts losing unsaved browser state.
 */
async terminate(): Promise<void> {
  const browser: any = this._browser;
  if (!browser) { await this.shutdown().catch(() => {}); return; }
  try { await browser.close(); } catch { /* already gone, or refusing to close */ }
  // Chrome's main process owns the profile lock. If it outlived close(), kill it.
  const proc = typeof browser.process === "function" ? browser.process() : null;
  if (proc && typeof proc.exitCode !== "number") {
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
  }
  this._page = null;
  this._browser = null;
  this._connected = false;
}
  async content(): Promise<string> { return this.page.content(); }

  /* ── navigation ─────────────────────────────────────────────── */

  async navigate(url: string, waitFor: string, timeoutMs: number): Promise<void> {
    const wf = NAV_WAIT_MAP[waitFor] || "domcontentloaded";
    await this.page.goto(url, { waitUntil: wf as any, timeout: timeoutMs }).catch(async (e) => {
      // A lifecycle-wait timeout doesn't mean the navigation failed — the page
      // may have committed and be rendering (slow portals, long-polling SPAs).
      // Swallow it here and let the caller re-inspect the actual page state.
      const msg = String(e);
      const isTimeout = /[Tt]imeout/.test(msg) || /TimeoutError/.test(msg);
      if (!isTimeout) throw e;
      await sleep(250);
    });
  }
  async back(): Promise<void> { await this.page.goBack({ waitUntil: "domcontentloaded" }); }
  async forward(): Promise<void> { await this.page.goForward({ waitUntil: "domcontentloaded" }); }
  async reload(): Promise<void> { await this.page.reload({ waitUntil: "domcontentloaded" }); }
  async waitForLoadState(state: string, timeoutMs: number): Promise<void> {
    if (state === "networkidle" || state === "networkidle0") {
      // K1: networkidle NEVER resolves on SPAs with WebSockets — hard-cap it so
      // a lifecycle wait can't hang the routing thread for 30s+.
      await this.page.waitForNetworkIdle({ timeout: Math.min(timeoutMs, 10000) }).catch(() => {});
    } else if (state === "load" || state === "domcontentloaded") {
      // K30: The old code used page.waitForNavigation({waitUntil: state}), which
      // ONLY resolves when a navigation STARTS AND COMPLETES after the call. On an
      // already-loaded page (the common case) it waits the full timeout, then the
      // controller reports "still waiting" while the content is visibly rendered.
      // Poll the page's real readyState instead — this is a state check that cannot
      // miss an already-loaded page: domcontentloaded => readyState !== 'loading',
      // load => readyState === 'complete'.
      const complete = state === "load";
      const want = `document.readyState ${complete ? "===" : "!=="} '${complete ? "complete" : "loading"}'`;
      await this.waitFor(want, timeoutMs, 250);
    } else {
      await sleep(Math.min(timeoutMs, 100));
    }
  }

  /**
   * Poll-for-real-content wait (K30): repeatedly evaluate a JS predicate in the page
   * (MAIN world) every `intervalMs` until it returns truthy or `timeoutMs` elapses.
   * This is the default wait strategy for page interactions — it matches what a human
   * visually checks ("is the thing I need actually there") instead of trusting a
   * page-lifecycle proxy (DOMContentLoaded/load/networkidle) that does not correlate
   * with rendered content on JS-heavy SPAs.
   */
  async waitFor(predicateJs: string, timeoutMs = 15000, intervalMs = 400): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const wrapped = `(() => { try { return !!((${predicateJs})); } catch (e) { return false; } })()`;
      const r = await this.evaluate(wrapped).catch(() => ({ ok: false as const }));
      if (r.ok && r.result === true) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  /**
   * Settled-aware poll (P0-A). Like waitFor, but distinguishes "the page is still
   * materially changing, keep waiting" from "the page has stopped changing and the
   * predicate is still false — stop now". The page is considered settled once the
   * document is interactive AND the DOM has produced no mutations for `settleMs`.
   * §36b: the in-page tracker accumulates a mutation count in the MAIN world; if it
   * is unavailable the resolver is conservative and reports "never settled" so an
   * early failure can never be declared without positive evidence of stability.
   */
  async waitForSettled(
    predicateJs: string,
    opts: { timeoutMs?: number; intervalMs?: number; settleMs?: number; minWaitMs?: number } = {},
  ): Promise<{ met: boolean; settled: boolean; attempts: number; elapsedMs: number }> {
    const timeoutMs = opts.timeoutMs ?? 10000;
    const intervalMs = opts.intervalMs ?? 200;
    const settleMs = opts.settleMs ?? 700;
    // §5: never declare an early failure before this floor. Short bounded work —
    // hydration bursts, one-shot setTimeout renders, XHR-then-render — regularly
    // produces a quiet DOM for a second or so BEFORE the awaited content appears.
    // Without the floor the settle detector would reject exactly the case it exists
    // to catch. The floor is what keeps early failure honest.
    const minWaitMs = Math.max(0, Math.min(opts.minWaitMs ?? 1500, timeoutMs));
    const started = Date.now();
    const deadline = started + timeoutMs;
    const floor = started + minWaitMs;
    let lastCount = -1;
    let lastChangeAt = started;
    let attempts = 0;
    // P0-A: guarantee the in-page mutation tracker exists for THIS document. The
    // Observer installs it lazily on observe, but a wait may be the first tool call
    // after a navigation (fresh document, tracker gone). Installing it here makes the
    // settled detector self-sufficient — and if it cannot be installed we never
    // declare an early failure (the conservative branch below requires numeric data).
    await this.evaluate(`(() => { try { if (typeof window.__p1MutationCount !== 'function') { let c = 0; new MutationObserver(() => c++).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); window.__p1MutationCount = () => c; } return true; } catch (e) { return false; } })()`).catch(() => null);
    for (;;) {
      attempts++;
      const probe = `(() => {
        let met = false;
        try { met = !!((${predicateJs})); } catch (e) { met = false; }
        let mutations = null;
        try { const f = window.__p1MutationCount; if (typeof f === 'function') mutations = f(); } catch (e) { mutations = null; }
        const ready = document.readyState !== 'loading';
        const complete = document.readyState === 'complete';
        return { met, mutations, ready, complete };
      })()`;
      const r = await this.evaluate(probe).catch(() => ({ ok: false as const }));
      const res = r.ok ? (r.result as { met: boolean; mutations: number | null; ready: boolean; complete?: boolean } | null) : null;
      if (res?.met) return { met: true, settled: false, attempts, elapsedMs: Date.now() - started };
      const now = Date.now();
      // §36b: only trust the tracker when it is actually available.
      if (res && typeof res.mutations === "number") {
        if (res.mutations !== lastCount) { lastCount = res.mutations; lastChangeAt = now; }
        const stableFor = now - lastChangeAt;
        // Early failure requires: past the floor, document fully loaded, and a quiet DOM.
        if (now >= floor && res.ready && res.complete !== false && stableFor >= settleMs) {
          return { met: false, settled: true, attempts, elapsedMs: now - started };
        }
      }
      if (now >= deadline) return { met: false, settled: false, attempts, elapsedMs: now - started };
      await sleep(intervalMs);
    }
  }

  /* ── tabs ───────────────────────────────────────────────────── */

  /** Stable id for a page — survives navigation, unlike URL-as-id. */
  private tabId(p: Page): string {
    let id = this._tabIds.get(p);
    if (!id) {
      id = `tab-${++this._tabCounter}`;
      this._tabIds.set(p, id);
      p.once("close", () => this._tabIds.delete(p));
    }
    return id;
  }

  /** Resolve a tab by stable id, falling back to URL match (legacy callers). */
  private async resolveTab(tabId: string): Promise<Page | undefined> {
    const pages = await this._browser!.pages();
    for (const p of pages) {
      if (this.tabId(p) === tabId) return p;
      if (p.url() === tabId) return p;
    }
    return undefined;
  }

  async createIsolatedPage(): Promise<BrowserEngine> {
    const browser = this._browser;
    if (!browser || !this.connected) throw new Error("Browser is not connected");
    const viewport = this.page.viewport();
    const p = await browser.newPage();
    try { if (viewport) await p.setViewport(viewport); }
    catch (error) { await p.close().catch(() => {}); throw error; }
    const isolated = new PuppeteerEngine(false);
    isolated._browser = browser;
    isolated._page = p;
    isolated._connected = true;
    isolated._config = this._config;
    isolated.attachHandlers(p);
    this.tabId(p);
    return isolated;
  }

  async newTab(url?: string): Promise<KruzTab> {
    const viewport = this._page?.viewport();
    const p = await this._browser!.newPage();
    try { if (viewport) await p.setViewport(viewport); }
    catch (error) { await p.close().catch(() => {}); throw error; }
    this.attachHandlers(p);
    // A new tab is a new document: give it the same automation-tell masking.
    await p.evaluateOnNewDocument(stealthScript()).catch(() => {});
    await p.evaluate(stealthScript()).catch(() => {});
    // K32: the old code never assigned this._page to the new tab, so the
    // "switch to it" contract was broken — controller.newTab brought the OLD
    // tab to front and every subsequent action ran against the wrong page.
    this._page = p;
    // A new tab has NEVER had interception applied, whatever the previous tab had.
    // `switchTab` clears this for the same reason; `newTab` did not, so an engine
    // that had capture on kept `_interceptionOn = true` while the new tab had
    // interception off. The next `enableNetworkCapture({captureBodies:true})`
    // then short-circuited in setInterception as a no-op and `network.body`
    // silently returned nothing for the rest of that tab's life.
    this._interceptionOn = null;
    if (url) await p.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.withEvaluateTimeout(p.bringToFront(), 1500).catch(() => {});
    return { id: this.tabId(p), url: p.url(), title: await p.title().catch(() => ""), isActive: true };
  }
  async listTabs(): Promise<KruzTab[]> {
    // Bounded at the source, not just at the callers. `page.listTabs` is an
    // agent-facing tool, so an unbounded hang here is reachable directly and not
    // only through internal page_id decoration.
    const pages = await this.withEvaluateTimeout(this._browser!.pages(), 3000).catch(() => []);
    const active = this._page;
    return Promise.all(pages.map(async (p) => ({
      id: this.tabId(p),
      url: p.url(),
      // Bound, for the same reason the engine's own `title()` is: Page.getTitle
      // hangs indefinitely on a tab whose navigation is still in flight — exactly
      // the state right after a goto timeout. A title is decoration; when it
      // cannot be read in time, an empty string is the honest answer.
      title: await this.withEvaluateTimeout(p.title(), 1500).catch(() => ""),
      isActive: p === active,
      openerId: (() => { const opener = pages.find(q => q.target() === p.target().opener()); return opener ? this.tabId(opener) : undefined; })(),
      isBlank: p.url() === "about:blank",
    })));
  }
  async closeTab(tabId: string): Promise<void> {
    const p = await this.resolveTab(tabId);
    if (!p) return;
    await p.close().catch(() => {});
    // K32: don't leave _page pointing at a dead page.
    if (this._page === p) {
      const next = (await this._browser!.pages()).filter((q) => !q.isClosed())[0];
      this._page = next ?? null;
      // Same reasoning as switchTab/newTab: the surviving tab's interception state
      // is unknown to this engine, so the per-tab bookkeeping must be reset to
      // "unknown" rather than inherited from the tab that just went away.
      this._interceptionOn = null;
    }
  }
  async switchTab(tabId: string): Promise<void> {
    const p = await this.resolveTab(tabId);
    if (!p) throw new Error(`No open tab '${tabId}'`);
    this.attachHandlers(p);
    this._page = p;
    // A freshly-activated tab has never had interception applied, so the
    // bookkeeping flag is per-tab-unknown here: force the toggle by clearing it.
    this._interceptionOn = null;
    // Keep interception live on the newly-active tab so network capture
    // (ATS feed bodies) keeps working after a switch. Bounded + deduped: this
    // used to be a bare `setRequestInterception(true)` on every switch, which is
    // the call that can block until the new tab's in-flight requests drain.
    //
    // It also keyed off `_networkEnabled` and always passed `true`, so body
    // capture being ON was not actually what decided interception — defeating the
    // "only pay the per-request CDP round-trip when bodies are wanted" rule
    // documented in enableNetworkCapture. `_captureBodies` is the real condition.
    if (this._networkEnabled) await this.setInterception(p, this._captureBodies);
    // Same hazard as bringToFront() above: an unbounded focus ping here used to
    // hang switchTab past the router's 25s budget, so the tool reported
    // ACTION_TIMEOUT for a switch that had already succeeded.
    await this.withEvaluateTimeout(p.bringToFront(), 1500).catch(() => {});
  }

  /* ── eval ────────────────────────────────────────────────────── */

  async evaluate<T = unknown>(expression: string): Promise<EvalResult> {
    try {
      // Arrow functions like "() => expr" need to be invoked, not just eval'd.
      // Wrap: eval(expr) → eval(expr)() so the function is actually called.
      const invocable = /^\s*\(\s*\)\s*=>/.test(expression) ? `(${expression})()` : expression;
      // K31: Bound the CDP evaluate with a budget. After a page.goto timeout on a slow
      // career portal, the renderer can stall mid-commit and `page.evaluate` hangs without
      // ever rejecting — which would wedge snapshotPage/pollForContent and block page.open
      // past the router timeout (and pile up a second concurrent call that can crash the
      // process). A hard cap turns that hang into a recoverable { ok:false }.
      const result = await this.withEvaluateTimeout(
        this.page.evaluate((e: string) => (0, eval)(e), invocable),
      );
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private async withEvaluateTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const budget = ms ?? this.evaluateTimeoutMs;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("evaluate timeout")), budget);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Install (or remove) request interception, bounded and idempotent.
   *
   * `Page.setRequestInterception` is a CDP call that does not settle until every
   * already-in-flight intercepted request has been handled. On a heavy page that
   * means it blocks for as long as the page keeps issuing requests — and on a
   * renderer mid-navigation it can simply never answer. The old call sites wrapped
   * it in `.catch(() => {})`, which handles a REJECTION and does nothing at all
   * about a HANG, so `controller.listen()` blocked on it before `page.open` had
   * even started navigating. That is the observed `ACTION_TIMEOUT ... outcome:
   * "unknown"` on careers.cognizant.com, twice, where the navigation never ran.
   *
   * Two changes, both needed:
   *  1. Skip the call when the page is already in the requested state. On a normal
   *     run capture is off, so this is the overwhelmingly common path and it now
   *     costs nothing.
   *  2. Bound the call, so a genuine state change on a busy page degrades to
   *     "interception unavailable" (network.body returns nothing) instead of
   *     wedging the route until the router's budget expires.
   *
   * The flag is set BEFORE the await, so concurrent callers dedupe against each
   * other rather than both issuing the same toggle. That makes it optimistic: if
   * the toggle times out we believe interception is on when it may not be. The
   * failure mode is a missing body for `network.body`, which the caller can see
   * and retry deliberately — strictly better than an un-resumable route.
   */
  private async setInterception(p: Page, on: boolean, budgetMs = 2000): Promise<void> {
    if (this._interceptionOn === on) return;
    this._interceptionOn = on;
    try {
      await this.withEvaluateTimeout(p.setRequestInterception(on), budgetMs);
    } catch {
      /* interception is an optimisation, never a correctness requirement */
    }
  }
  async readVariable<T = unknown>(name: string): Promise<T | undefined> {
    try {
      const result = await this.page.evaluate((n: string) => (globalThis as any)[n], name);
      return result as T | undefined;
    } catch {
      return undefined;
    }
  }

  /* ── screenshot ──────────────────────────────────────────────── */

  async screenshot(opts: { fullPage?: boolean; path?: string; type?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Buffer> {
    const type = opts.type ?? "png";
    const buf = await this.page.screenshot({
      fullPage: opts.fullPage ?? false,
      path: opts.path as any,
      type,
      // `quality` is only meaningful for lossy types; passing it with png is rejected.
      ...(type === "png" ? {} : { quality: opts.quality ?? 80 }),
    });
    return Buffer.from(buf);
  }

  /** Intrinsic size of the captured image, without a second screenshot round trip. */
  private imageSize(buf: Buffer): { width: number | null; height: number | null } {
    try {
      // PNG: IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
      if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      // JPEG: walk the segment chain to the SOFn frame header.
      if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let off = 2;
        while (off + 9 < buf.length) {
          if (buf[off] !== 0xff) { off++; continue; }
          const marker = buf[off + 1];
          const len = buf.readUInt16BE(off + 2);
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
          }
          off += 2 + len;
        }
      }
      // WebP (VP8X / VP8 / VP8L): dimensions are 24-bit little-endian after a chunk header.
      if (buf.length > 30 && buf.slice(8, 12).toString("latin1") === "WEBP") {
        const fmt = buf.slice(12, 16).toString("latin1");
        if (fmt === "VP8X") return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
        if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (fmt === "VP8L") {
          const b = buf.readUInt32LE(21);
          return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
      }
    } catch { /* dimensions are advisory; never fail a capture over them */ }
    return { width: null, height: null };
  }

  /* ── frames ──────────────────────────────────────────────────── */

  async frames(): Promise<KruzFrame[]> {
    return this.page.frames().map((f) => ({
      id: f.url(),
      url: f.url(),
      name: f.name(),
      isMain: f === this.page.mainFrame(),
    }));
  }
  async frameBy(name?: string, urlPattern?: string): Promise<KruzFrame | null> {
    const f = this.page.frames().find((f) => {
      if (name && f.name() === name) return true;
      if (urlPattern && f.url().includes(urlPattern)) return true;
      return false;
    });
    return f ? { id: f.url(), url: f.url(), name: f.name(), isMain: f === this.page.mainFrame() } : null;
  }
  async evaluateInFrame<T = unknown>(frameId: string, expression: string): Promise<EvalResult> {
    const f = this.page.frames().find((f) => f.url() === frameId);
    if (!f) return { ok: false, error: `Frame not found: ${frameId}` };
    try {
      const result = await f.evaluate((e: string) => (0, eval)(e), expression);
      return { ok: true, result: result as T };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /* ── element queries ─────────────────────────────────────────── */

  /** Resolve a Target to a CSS selector (engine-agnostic). */
  private selectorFor(target: Target, fallback?: Fallback, scope?: string): string {
    const root = scope ? `${scope} ` : "";
    if (target.css) return `${root}${target.css}`;
    // Preserve accessible names exactly, including punctuation and long names.
    if (target.role && target.name) return `${root}::-p-aria([name=${JSON.stringify(target.name)}][role=${JSON.stringify(target.role)}])`;
    if (target.role) return `${root}::-p-aria([role=${JSON.stringify(target.role)}])`;
    if (target.label) return `${root}::-p-aria([name=${JSON.stringify(target.label)}])`;
    if (target.placeholder) return `${root}[placeholder*=${JSON.stringify(target.placeholder)}]`;
    if (target.text) return `${root}::-p-text(${JSON.stringify(target.text)})`;
    if (target.testid) return `${root}[data-testid="${escCSS(target.testid)}"]`;
    if (target.nameAttr) return `${root}[name="${escCSS(target.nameAttr)}"]`;
    if (target.id) return `${root}#${escCSS(target.id)}`;
    if (fallback?.css) return `${root}${fallback.css}`;
    if (fallback?.xpath) return `${root}${fallback.xpath}`;
    if (fallback?.text) return `${root}::-p-text(${JSON.stringify(fallback.text)})`;
    return `${root}body`;
  }

  /**
   * Build a shadow-DOM-piercing ("deep") selector for a plain-CSS target.
   * Puppeteer's `>>>` combinator descends through open shadow roots, so a
   * control rendered inside a component is reachable even though
   * `page.waitForSelector('#id')` cannot see it. Returns null when the target
   * isn't expressible as a plain CSS selector (pseudo/xpath targets can't be
   * deep-combined).
   */
  private deepSelector(target: Target, fallback?: Fallback, scope?: string): string | null {
    const plain = (s?: string): boolean => !!s && !/:text\(|:has-text\(|:xpath[/=]|>>|::-p-/.test(s);
    let inner: string | null = null;
    if (plain(target.css)) inner = target.css!;
    else if (target.testid) inner = `[data-testid="${escCSS(target.testid)}"]`;
    else if (target.nameAttr) inner = `[name="${escCSS(target.nameAttr)}"]`;
    else if (target.id) inner = `#${escCSS(target.id)}`;
    else if (plain(fallback?.css)) inner = fallback!.css!;
    if (!inner) return null;
    return `${scope ? `${scope} ` : "body "}>>> ${inner}`;
  }

  /**
   * P0-A/QF: budgeted waitForSelector that stops early when the document is loaded
   * and the DOM has been mutation-quiet. A quiet document cannot produce the
   * element, so an impossible selector fails in ~1.5s instead of burning the whole
   * budget (the "impossible target" cost this replaces was 3-5s per miss).
   * Conservative by construction: without numeric tracker data we never stop early,
   * and the caller's budget is always the hard ceiling.
   */
  private async waitForSelectorQuiet(sel: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    // Same floor rationale as waitForSettled: hydration bursts regularly go quiet
    // for ~1s BEFORE the awaited node appears, so early failure needs a floor.
    const floor = started + Math.min(1500, timeoutMs);
    const settleMs = 600;
    const installed = await this.evaluate(`(() => { try { if (typeof window.__p1MutationCount !== 'function') { let c = 0; new MutationObserver(() => c++).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); window.__p1MutationCount = () => c; } return true; } catch (e) { return false; } })()`).catch(() => null);
    const tracked = installed?.ok === true && (installed as any).result === true;
    let lastCount = -1;
    let lastChangeAt = started;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) return false;
      const hit = await this.page.waitForSelector(sel, { timeout: Math.min(250, remain) }).catch(() => null);
      if (hit) { await hit.dispose().catch(() => {}); return true; }
      // No tracker → no positive evidence of stability → wait the full budget.
      if (!tracked) continue;
      const r = await this.evaluate(`(() => { try { const f = window.__p1MutationCount; return { mutations: typeof f === 'function' ? f() : null, ready: document.readyState !== 'loading', complete: document.readyState === 'complete' }; } catch (e) { return null; } })()`).catch(() => ({ ok: false as const }));
      const info = r.ok ? (r.result as { mutations: number | null; ready: boolean; complete?: boolean } | null) : null;
      const now = Date.now();
      if (info && typeof info.mutations === "number") {
        if (info.mutations !== lastCount) { lastCount = info.mutations; lastChangeAt = now; }
        if (now >= floor && info.ready && info.complete !== false && now - lastChangeAt >= settleMs) return false;
      }
      if (now >= deadline) return false;
    }
  }

  /**
   * Wrap the node stashed in-page by the marker's `markScript`.
   *
   * The node object is the strongest handle available: it survives shadow roots
   * (no CSS selector reaches into one), and it cannot drift onto a different
   * node the way a re-run `page.$(selector)` can. Falls back to the selector
   * when the stash is unavailable.
   */
  async takeMarkedNode(fallbackCss: string, target: Target): Promise<KruzElement | null> {
    const js = await this.page
      .evaluateHandle(() => {
        try { return (window as any).__kruzMarkedNode ?? null; } catch { return null; }
      })
      .catch(() => null);
    const node = js?.asElement?.() ?? null;
    if (node) {
      return { handle: fallbackCss, strategy: "pinned-node", target, resolvedAt: Date.now(), node };
    }
    await js?.dispose?.().catch(() => {});
    return await this.queryOne({ css: fallbackCss }, undefined, undefined, 500).catch(() => null);
  }

  /**
   * Wrap a pinned node so per-operation cleanup cannot invalidate it.
   *
   * A KruzElement carrying `node` is used by several engine calls in one action
   * (evaluate, attribute, click, ...), and each of those disposes the handle it
   * was given. Disposing the pinned node on the first call made every later call
   * fail with "JSHandle is disposed!". The pinned node outlives the action and
   * is owned by the KruzElement, so disposal is suppressed here and left to
   * the garbage collector.
   */
  private pinnedHandle(node: ElementHandle): ElementHandle {
    return new Proxy(node, {
      get(target, prop, receiver) {
        if (prop === "dispose") return async () => { /* owned by the KruzElement */ };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as ElementHandle;
  }

  async queryOne(target: Target, fallback?: Fallback, scope?: string, timeoutMs = 3000): Promise<KruzElement | null> {
    const sel = this.selectorFor(target, fallback, scope);
    // P2-A: plain-CSS resolution respects the caller's remaining budget instead of a
    // fixed 3s. The controller propagates its action timeout here so a "does this exist
    // now?" click on a small budget fails fast (the caller can still request a longer
    // wait via page.wait when it genuinely expects the element to appear).
    timeoutMs = Math.max(0, Math.min(timeoutMs, 5000));
    // K31: Puppeteer's custom pseudo-selectors (:text(), :has-text(), :xpath/) run through its
    // own selector engine and can keep waiting the full timeout (3s) even when the match is
    // split across nodes/shadow DOM/iframes — which, when looped (observer text probes,
    // dismissCookieBanner), blew page.observe/page.open past their route budgets. These are
    // existence probes, so try the instant path first; only fall back to a short wait for
    // plain-CSS (real "wait for the element to appear" semantics).
    const isPseudo = /:text\(|:has-text\(|:xpath\/|>>|::-p-/.test(sel);
    try {
      if (isPseudo) {
        const hit = await this.page.$(sel).catch(() => null);
        if (hit) { await hit.dispose(); return { handle: sel, strategy: "selector", target, fallback, scope, resolvedAt: Date.now() }; }
        const deep = this.deepSelector(target, fallback, scope);
        if (deep) {
          const hitDeep = await this.page.$(deep).catch(() => null);
          if (hitDeep) { await hitDeep.dispose(); return { handle: deep, strategy: "deep-selector", target, fallback, scope, resolvedAt: Date.now() }; }
        }
        return this.queryChildFrame(target, fallback, scope, sel);
      }
      // P2-A: when the budget is effectively zero, don't wait at all — just check now.
      if (timeoutMs <= 100) {
        const hit = await this.page.$(sel).catch(() => null);
        if (hit) { await hit.dispose(); return { handle: sel, strategy: "selector", target, fallback, scope, resolvedAt: Date.now() }; }
        const deep = this.deepSelector(target, fallback, scope);
        if (deep) {
          const hitDeep = await this.page.$(deep).catch(() => null);
          if (hitDeep) { await hitDeep.dispose(); return { handle: deep, strategy: "deep-selector", target, fallback, scope, resolvedAt: Date.now() }; }
        }
        return this.queryChildFrame(target, fallback, scope, sel);
      }
      try {
        const found = await this.waitForSelectorQuiet(sel, timeoutMs);
        if (!found) throw new Error("not found");
        return { handle: sel, strategy: "selector", target, fallback, scope, resolvedAt: Date.now() };
      } catch {
        // Plain CSS that the document can't see may live inside an (open) shadow
        // root — component-based portals (Shoelace, Lit, Salesforce LWC) render
        // their controls that way. Retry with a deep selector before giving up.
        const deep = this.deepSelector(target, fallback, scope);
        if (!deep) throw new Error("not found");
        const hitDeep = await this.page.$(deep).catch(() => null);
        if (!hitDeep) throw new Error("not found");
        await hitDeep.dispose();
        return { handle: deep, strategy: "deep-selector", target, fallback, scope, resolvedAt: Date.now() };
      }
    } catch (error) {
      // queryChildFrame throws `Ambiguous target across child frames`; the old
      // check looked for the literal 'AMBIGUOUS_TARGET', which that message never
      // contains — so the ambiguity was swallowed, the call returned null, and the
      // caller reported TARGET_NOT_FOUND. That is the wrong diagnosis for "two
      // elements match": it tells the model to narrow or re-observe when what it
      // actually needs is to pick one of the candidates.
      if (error instanceof Error && /^Ambiguous target across child frames/i.test(error.message)) throw error;
      return null;
    }
  }

  private async queryChildFrame(target: Target, fallback: Fallback | undefined, scope: string | undefined, selector: string): Promise<KruzElement | null> {
    const matches: KruzElement[] = [];
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      // A missing main-page button must not hang on third-party video/auth frames.
      const frameUrl = frame.url();
      if (frameUrl !== 'about:srcdoc' && frameUrl !== 'about:blank') {
        try { if (new URL(frameUrl).origin !== new URL(this.page.url()).origin) continue; } catch { continue; }
      }
      const hits = await frame.$$(selector).catch(() => []);
      for (const hit of hits) {
        matches.push({handle: 'frame:' + JSON.stringify([frame.url(), selector]), strategy:'frame', target, fallback, scope, resolvedAt:Date.now()});
        await hit.dispose().catch(() => {});
      }
    }
    if(matches.length > 1) throw new Error('Ambiguous target across child frames');
    return matches[0] ?? null;
  }

  async queryAll(target: Target, _fallback?: Fallback, _scope?: string): Promise<KruzElement[]> {
    const sel = this.selectorFor(target, _fallback, _scope);
    const count = await this.page.$$(sel).then(async (els) => { const count = els.length; await Promise.all(els.map(el => el.dispose())); return count; }).catch(() => 0);
    return Array.from({ length: count }, (_, i) => ({
      handle: `(${sel}).nth(${i})`,
      strategy: `selector:nth(${i})`,
      target,
      fallback: _fallback,
      scope: _scope,
      resolvedAt: Date.now(),
    }));
  }

  /** Re-resolve a KruzElement handle to a live Puppeteer ElementHandle. */
  private async resolveHandle(el: KruzElement): Promise<ElementHandle | null> {
    try {
      // A pinned node is authoritative — see KruzElement.node. Re-querying by
      // handle here could silently resolve to a different node.
      if (el.node) return this.pinnedHandle(el.node as ElementHandle);
      if (el.handle.startsWith('frame:')) {
        // `[url, selector]` = the single match; `[url, selector, index]` = the
        // index-th element of the frame's query RESULT SET (which is what
        // queryAllInFrame returns). The index must be resolved by $$ + position,
        // NOT by appending `:nth-of-type(i)` to the selector: that pseudo-class
        // counts among same-tag SIBLINGS, so for a selector matching several
        // different tags it silently resolves to the wrong node or to none.
        const parsed = JSON.parse(el.handle.slice(6));
        const [url, selector, index] = parsed as [string, string, number | undefined];
        const frames = this.page.frames().filter(f => f.url() === url);
        if (frames.length !== 1) throw new Error('Ambiguous or missing child frame');
        if (typeof index !== "number") return frames[0].$(selector);
        for (let attempt = 0; attempt < 2; attempt++) {
          const all = await frames[0].$$(selector).catch(() => []);
          const pick = all[index] ?? null;
          for (const h of all) if (h !== pick) await h.dispose().catch(() => {});
          if (pick) return pick;
          await sleep(200);
        }
        return null;
      }
      // queryAll builds `(selector).nth(i)` handles — page.$ can't parse those,
      // so resolve via $$ + index (previously every .nth() handle resolved null,
      // silently breaking batch flows built on queryAll).
      const nth = /^\((.*)\)\.nth\((\d+)\)$/.exec(el.handle);
      if (nth) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const all = await this.page.$$(nth[1]).catch(() => []);
          const pick = all[Number(nth[2])] ?? null;
          for (const h of all) if (h !== pick) await h.dispose().catch(() => {});
          if (pick) return pick;
          await sleep(200);
        }
        return null;
      }
      const handle = await this.page.$(el.handle);
      if (handle) return handle;
      // Retry once after brief wait (SPA may be updating DOM)
      await sleep(200);
      return await this.page.$(el.handle);
    } catch {
      return null;
    }
  }

  /* ── element operations ──────────────────────────────────────── */

  async click(el: KruzElement, opts?: { button?: "left" | "right" | "middle"; clickCount?: number; force?: boolean; timeoutMs?: number; visual?: boolean; speed?: "instant" | "fast" | "normal" | "slow"; modifiers?: string[] }): Promise<void> {
    // Open the dispatch window BEFORE any waiting: the obscured check, the
    // scroll and Puppeteer's actionability wait are all part of this click.
    await this.expectInput(Math.max(3000, opts?.timeoutMs ?? 5000));
    // Held modifiers are what make shift-click multi-select / ctrl-click additive
    // selection work in canvas editors. Key COMBOS (page.press "Control+g") cannot
    // cover this: a combo is atomic, while multi-select needs the modifier down
    // across the whole click.
    const modifiers = (opts?.modifiers ?? []).filter((m) => !!m);
    for (const m of modifiers) await this.page.keyboard.down(m as any).catch(() => {});
    const handle = await this.resolveHandle(el);
    if (!handle) { for (const m of [...modifiers].reverse()) await this.page.keyboard.up(m as any).catch(() => {}); throw new Error(`Element not found: ${el.handle}`); }
    try {
      const enabled = await handle.evaluate((node: any) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');
      if (!enabled) throw new Error('ELEMENT_DISABLED');
      const visible = await handle.isVisible();
      if (!visible && !opts?.force) throw new Error('ELEMENT_NOT_VISIBLE');
      await this.scrollHandleIntoView(handle);

      // Native built-in controls are opened correctly by a real mouse click at
      // their box centre but are unreliable under a synthesized/element click
      // (file pickers, date pickers, and especially <select>). Playwright/
      // Puppeteer semantics only apply when the caller did not force or opt
      // into the visual-cursor glide.
      const tag = await handle.evaluate((n: any) => n.tagName).catch(() => "");
      const nativeClick = !opts?.force && !opts?.visual && (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA");
      if (nativeClick) {
        const box = await handle.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          await this.rememberCursor({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
          await handle.click({ button: opts?.button, clickCount: opts?.clickCount });
          return;
        }
      }

      if (opts?.visual) {
        // Virtual-cursor path: glide a human-like trajectory and dispatch real
        // CDP input, so the click is trusted AND visibly verifiable. The
        // obscured guard still applies — the cursor must never click through an
        // overlay the page put there on purpose.
        const point = await this.computeClickPoint(handle, !!opts.force);
        if (point) { await this.glideAndClick(point, opts); return; }
      }
      // W7: when the centre is covered but an alternate probe point is clear,
      // click the clear point with trusted CDP input instead of failing.
      let probeClick: { x: number; y: number } | null = null;
      if (!opts?.force) {
        const covered = await handle.evaluate((node: any) => {
          const r = node.getBoundingClientRect();
          const inViewport = (x: number, y: number) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          // D6: an offscreen or zero-size centre cannot be hit-tested — that is
          // a visibility problem, not an overlay. Report it as such instead of
          // "obscured by null".
          if (r.width === 0 || r.height === 0 || !inViewport(x, y)) return "OFFSCREEN";
          // A frame is a container, not an obstruction: everything inside it is
          // the target's own content. Hit-testing an <iframe> with
          // elementFromPoint in the parent document retargets to the frame's
          // inner node (a SPAN in TinyMCE, a DIV in a video player), which made
          // every iframe on a real page report ELEMENT_OBSCURED.
          if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') return false;
          let hit = node.ownerDocument.elementFromPoint(x, y);
          // A hit that lives in a different document is inside a child frame, so
          // it is not an overlay covering this element.
          if (hit && hit.ownerDocument !== node.ownerDocument) return false;
          const seen = new Set();
          // document.elementFromPoint retargets slotted controls to a shadow host.
          // Descend through the composed hit tree before declaring an obstruction.
          while (hit?.shadowRoot && !seen.has(hit)) {
            seen.add(hit);
            const deeper = hit.shadowRoot.elementFromPoint(x, y);
            if (!deeper || deeper === hit) break;
            hit = deeper;
          }
          // Slotted text can retarget all the way back to this control's own host.
          if (node.getRootNode()?.host === hit) return false;
          for (let current = hit; current; current = current.assignedSlot || current.parentElement || current.getRootNode()?.host) {
            if (current === node || node.contains(current)) return false;
          }
          // A blocker that is itself a frame is not covering us either.
          if (hit?.tagName === 'IFRAME' || hit?.tagName === 'FRAME') return false;
          return { target: node.tagName, hit: hit?.tagName ?? null, hit_id: hit?.id ?? null, x, y };
        });
        if (covered === "OFFSCREEN") throw new Error("ELEMENT_NOT_VISIBLE");
        if (covered) {
          probeClick = await this.computeClickPoint(handle, false).catch(() => null);
          if (!probeClick) throw new Error(`ELEMENT_OBSCURED: ${JSON.stringify(covered)}`);
        }
      }
      const page = this.page;
      let listener: ((dialog: Dialog) => void) | undefined;
      const dialogOpened = new Promise<void>(resolve => { listener = () => resolve(); page.once('dialog', listener); });
      try {
        // The probe path dispatches trusted CDP input at a clear point — move
        // the visible cursor there first so the user sees where it lands.
        if (probeClick) await this.rememberCursor(probeClick);
        const action = opts?.force
          // Force path synthesizes untrusted DOM events — mark them as the
          // model's own so the control lock's untrusted-input filter lets them
          // through (synchronous dispatch, so the flag cannot leak to user input).
          ? handle.evaluate((node: any) => { const w = window; w.__kruzAutomationBypass = true; try { node.click(); } finally { w.__kruzAutomationBypass = false; } })
          : probeClick
            ? this.page.mouse.click(probeClick.x, probeClick.y, { button: opts?.button ?? "left", clickCount: opts?.clickCount ?? 1 })
            : (async () => {
                // Default handle.click path: move cursor to the element center so the
                // visible cursor always tracks the model's actions.
                const box = await handle.boundingBox().catch(() => null);
                if (box && box.width > 0 && box.height > 0) {
                  await this.rememberCursor({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
                }
                return handle.click({ button: opts?.button, clickCount: opts?.clickCount });
              })();
        await Promise.race([action, dialogOpened]);
      } finally { if (listener) page.off('dialog', listener); }
    } finally {
      // Disposal waits on renderer execution while a native dialog is open.
      if (!this._dialogQueue.some(d => d.page === this.page)) await handle.dispose().catch(() => {});
      // Always release: a modifier stuck down makes every subsequent click a
      // shift-click, which is far worse than the modifier never landing.
      for (const m of [...modifiers].reverse()) await this.page.keyboard.up(m as any).catch(() => {});
      this.endInput();
    }
  }

  /** Remember where the visible cursor last acted, purely in memory. */
  private async rememberCursor(point: { x: number; y: number }): Promise<void> {
    this._lastCursor = point;
    await this.page.evaluate((x: number, y: number) => { try { (window as any).__kruzVisual?.setPos(x, y); } catch { /* no layer */ } }, point.x, point.y).catch(() => {});
  }

  /**
   * Pick a reliable click point for an element.
   *
   * The geometric centre is wrong surprisingly often: a badge, a spinner, or a
   * sticky sibling can sit exactly on top of it. Probe a small inset grid and
   * return the first point that hit-tests back to the element (or a descendant),
   * so a click still lands when the centre is covered.
   */
  private async computeClickPoint(handle: ElementHandle, force: boolean): Promise<{ x: number; y: number } | null> {
    const probe = await handle.evaluate((node: any, force: boolean) => {
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const w = r.width, h = r.height;
      const inset = (fx: number, fy: number) => ({ x: r.left + w * fx, y: r.top + h * fy });
      // Centre first, then an inset ring, then the corners.
      const pts = [
        inset(0.5, 0.5), inset(0.5, 0.35), inset(0.35, 0.5), inset(0.65, 0.5), inset(0.5, 0.65),
        inset(0.3, 0.3), inset(0.7, 0.3), inset(0.3, 0.7), inset(0.7, 0.7), inset(0.5, 0.8), inset(0.5, 0.2),
      ];
      const inViewport = (p: any) => p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight;
      if (force) { const c = pts[0]; return inViewport(c) ? c : null; }
      for (const p of pts) {
        if (!inViewport(p)) continue;
        let hit = document.elementFromPoint(p.x, p.y);
        const seen = new Set();
        while (hit?.shadowRoot && !seen.has(hit)) { seen.add(hit); const d = hit.shadowRoot.elementFromPoint(p.x, p.y); if (!d || d === hit) break; hit = d; }
        if (!hit) continue;
        for (let cur: any = hit; cur; cur = (cur as any).assignedSlot || cur.parentElement || (cur.getRootNode() as any)?.host) {
          if (cur === node || node.contains(cur)) return p;
        }
        // An <iframe> never covers its own interior.
        if (hit.tagName === 'IFRAME' && (node.tagName === 'IFRAME' || node.contains(hit))) return p;
      }
      return null;
    }, force).catch(() => null);
    if (probe) return probe as { x: number; y: number };
    // A null probe in non-force mode means FULLY COVERED (every in-viewport
    // point failed the hit-test) — never fall back to the covered centre.
    // Force mode keeps the legacy box-centre fallback: it bypasses
    // actionability by design.
    if (force) {
      const box = await handle.boundingBox().catch(() => null);
      if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  }

  /**
   * Glide the virtual cursor to a point and click with real CDP input.
   *
   * Each step updates the visual and dispatches a trusted `Input.dispatchMouseEvent`
   * move, so what the operator watches is exactly what the page receives. The
   * press/hold/release gap is real (not zero-duration) because a mousedown and
   * mouseup in the same millisecond is a strong automation tell.
   */
  private async glideAndClick(point: { x: number; y: number }, opts: { button?: "left" | "right" | "middle"; clickCount?: number; speed?: "instant" | "fast" | "normal" | "slow" }): Promise<void> {
    const speed = opts.speed ?? "normal";
    const from = await this.virtualCursorPos();
    const path = computePath(from, point, { speed });
    const delays = stepDelaysMs(path, { speed });
    const button = opts.button ?? "left";

    const dialogOpened = new Promise<void>((resolve) => {
      const l = () => resolve();
      this.page.once("dialog", l);
      (this as any)._pendingDialogCleanup = () => this.page.off("dialog", l);
    });

    try {
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        // Visual and trusted input advance together, step for step.
        await this.page.evaluate((x: number, y: number) => { try { (window as any).__kruzVisual?.setPos(x, y); } catch { /* layer absent */ } }, p.x, p.y).catch(() => {});
        await this.page.mouse.move(p.x, p.y);
        const d = delays[i] ?? 0;
        if (d > 0) await sleep(d);
      }
      await this.page.evaluate(() => { try { (window as any).__kruzVisual?.press(true); } catch { /* layer absent */ } }).catch(() => {});
      await this.page.mouse.down({ button: button as any });
      // A human press is not instantaneous.
      const hold = speed === "instant" ? 0 : 35 + Math.round(Math.random() * 45);
      if (hold) await sleep(hold);
      await this.page.mouse.up({ button: button as any });
      for (let i = 0; i < (opts.clickCount ?? 1) - 1; i++) {
        await this.page.mouse.down({ button: button as any, clickCount: i + 2 as any });
        await this.page.mouse.up({ button: button as any, clickCount: i + 2 as any });
      }
      await this.page.evaluate(() => {
        try { const v = (window as any).__kruzVisual; v?.press(false); v?.ripple(); } catch { /* layer absent */ }
      }).catch(() => {});
      await Promise.race([sleep(0), dialogOpened]);
    } finally {
      (this as any)._pendingDialogCleanup?.();
      (this as any)._pendingDialogCleanup = undefined;
    }
  }

  /** Neutralise Chrome's automation tells in the page (MAIN world, every
   *  document). Deliberately not a command-line flag — that one is fingerprinted
   *  and triggers Chrome's "unsupported command-line flag" infobar. */
  async installStealth(): Promise<void> {
    const src = stealthScript();
    await this.page.evaluateOnNewDocument(src).catch(() => {});
    await this.page.evaluate(src).catch(() => {});
  }

  /** Install the visual control layer on this page and every future navigation. */
  async installControlIndicator(opts: { status?: string | null; glow?: boolean } = {}): Promise<void> {
    const src = visualLayerScript();
    // Persist across navigations so a SPA route change does not drop the cursor.
    await this.page.evaluateOnNewDocument(src).catch(() => {});
    await this.page.evaluate(src).catch(() => {});
    // Restore the last cursor position so it survives navigation.
    if (this._lastCursor) {
      await this.page.evaluate((x: number, y: number) => { try { (window as any).__kruzVisual?.setPos(x, y); } catch { /* ignore */ } }, this._lastCursor.x, this._lastCursor.y).catch(() => {});
    }
    if (opts.status !== undefined) {
      await this.page.evaluate((s: string | null) => { try { (window as any).__kruzVisual?.setStatus(s); } catch { /* ignore */ } }, opts.status).catch(() => {});
    }    if (opts.glow !== undefined) {
      await this.page.evaluate((g: boolean) => { try { (window as any).__kruzVisual?.setGlow(g); } catch { /* ignore */ } }, opts.glow).catch(() => {});
    }
  }

  async removeControlIndicator(): Promise<void> {
    await this.page.evaluate(() => { try { (window as any).__kruzVisual?.destroy(); } catch { /* ignore */ } }).catch(() => {});
  }

  async virtualCursorPos(): Promise<{ x: number; y: number }> {
    const r = await this.page.evaluate(() => {
      const v = (window as any).__kruzVisual;
      if (v?.getPos) { const q = v.getPos(); if (q && q.x > -50) return { x: q.x, y: q.y }; }
      return null;
    }).catch(() => null) as { ok: boolean; result?: { x: number; y: number } | null } | null;
    if (r?.ok && r.result) return r.result;
    // The layer is not installed yet (or was just re-injected on navigation):
    // continue from wherever the cursor last acted so a glide does not jump.
    if (this._lastCursor) return this._lastCursor;
    return { x: 0, y: 0 };
  }

  async dblclick(el: KruzElement, opts?: { timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    // Open the model-dispatch window, exactly as click() does. Without it the
    // in-page control lock (visual-cursor.ts, capture phase on `dblclick`)
    // cancels every event, so a double-click landed while the overlay was in
    // `controlling` never reached the page at all.
    await this.expectInput(Math.max(3000, opts?.timeoutMs ?? 5000));
    try {
      await handle.click({ clickCount: 2 });
    } finally {
      await handle.dispose().catch(() => {});
      this.endInput();
    }
  }

  async hover(el: KruzElement, opts?: { timeoutMs?: number; dwellMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    await handle.hover();
    const box = await handle.boundingBox().catch(() => null);
    if (box) await this.rememberCursor({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    if (opts?.dwellMs) await sleep(opts.dwellMs);
    await handle.dispose().catch(() => {});
  }

  async scrollIntoView(el: KruzElement, _opts?: { timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    await this.scrollHandleIntoView(handle);
    await handle.dispose().catch(() => {});
  }

  /** Instant scroll + settle poll shared by scrollIntoView and click. */
  private async scrollHandleIntoView(handle: ElementHandle): Promise<void> {
    await handle.evaluate((node: any) => {
      node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" } as any);
    });
    // Settle: wait until the element's viewport rect stops moving (lazy images,
    // sticky headers, SPA layout shifts keep shifting it). Clicks issued
    // mid-shift land on the wrong node with no error — the classic "click went
    // through but hit the wrong thing" on job portals.
    //
    // The first probe is after ONE FRAME, not after a flat 100ms. The old loop
    // slept 100ms before its first comparison, so no action could ever return
    // sooner than 100ms even when the rect had not moved at all — a 110-200ms
    // floor measured on every click, fill and press, on pages with no layout
    // shift whatsoever. An instant scroll has already applied by the next frame,
    // so an unchanged rect has nothing to settle; only a rect that has MOVED
    // pays the full 100ms to wait it out.
    try {
      const rectOf = (n: any) => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(","); };
      let last: string = await handle.evaluate(rectOf);
      for (let i = 0; i < 10; i++) {
        await sleep(i === 0 ? 16 : 100);
        const cur: string = await handle.evaluate(rectOf);
        if (cur === last) break;
        last = cur;
      }
    } catch { /* element detached mid-scroll — caller re-resolves */ }
  }

  /** Scroll a scrollable container (the element itself or its nearest scrollable
   *  ancestor) by amount in direction. Window-only scrolling does nothing on
   *  portals whose results live in an inner scroll pane (Workday, Greenhouse). */
  async scrollElement(el: KruzElement, direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    const dir = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[direction];
    await handle.evaluate((node: any, d: number[]) => {
      let cur: any = node;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        try {
          const st = getComputedStyle(cur);
          const scrollable = /(auto|scroll)/.test(st.overflowY + " " + st.overflowX)
            && (cur.scrollHeight > cur.clientHeight + 1 || cur.scrollWidth > cur.clientWidth + 1);
          if (scrollable) { cur.scrollBy({left:d[0], top:d[1], behavior:'instant'}); return true; }
        } catch { /* keep climbing */ }
        cur = cur.parentElement || cur.getRootNode()?.host;
      }
      window.scrollBy({left:d[0], top:d[1], behavior:'instant'});
      return true;
    }, dir);
    await handle.dispose().catch(() => {});
  }

  async boundingBox(el: KruzElement): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const handle = await this.resolveHandle(el);
    if (!handle) return null;
    const box = await handle.boundingBox();
    await handle.dispose().catch(() => {});
    return box ?? null;
  }

  async isVisible(el: KruzElement): Promise<boolean> {
    const handle = await this.resolveHandle(el);
    if (!handle) return false;
    const vis = await handle.isVisible().catch(() => false);
    await handle.dispose().catch(() => {});
    return vis;
  }
  async isEnabled(el: KruzElement): Promise<boolean> {
    const handle = await this.resolveHandle(el);
    if (!handle) return false;
    const en = await handle.evaluate((n: any) => !n.disabled).catch(() => false);
    await handle.dispose().catch(() => {});
    return en;
  }
  async isChecked(el: KruzElement): Promise<boolean> {
    const handle = await this.resolveHandle(el);
    if (!handle) return false;
    const c = await handle.evaluate((n: any) => n.checked);
    await handle.dispose().catch(() => {});
    return c;
  }
  async innerText(el: KruzElement): Promise<string> {
    const handle = await this.resolveHandle(el);
    if (!handle) return "";
    const t = await handle.evaluate((n: any) => n.innerText?.trim() ?? "");
    await handle.dispose().catch(() => {});
    return t;
  }
  async textContent(el: KruzElement): Promise<string> {
    const handle = await this.resolveHandle(el);
    if (!handle) return "";
    const t = await handle.evaluate((n: any) => n.textContent?.trim() ?? "");
    await handle.dispose().catch(() => {});
    return t;
  }
  async attribute(el: KruzElement, name: string): Promise<string | null> {
    const handle = await this.resolveHandle(el);
    if (!handle) return null;
    const a = await handle.evaluate((n: any, name: string) => n.getAttribute(name), name);
    await handle.dispose().catch(() => {});
    return a;
  }
  async evaluateOn<T = unknown>(el: KruzElement, expression: string): Promise<EvalResult> {
    const handle = await this.resolveHandle(el);
    if (!handle) return { ok: false, error: "Element not found" };
    try {
      // ElementHandle.evaluate passes the element FIRST, then user arguments.
      // Direct eval inside a bound function gives snippets their documented `this`.
      const r = await handle.evaluate((node: Element, source: string) => {
        return function(this: Element, code: string) { return eval(code); }.call(node, source);
      }, expression);
      await handle.dispose().catch(() => {});
      return { ok: true, result: r as T };
    } catch (e) {
      await handle.dispose().catch(() => {});
      return { ok: false, error: String(e) };
    }
  }
  async tagName(el: KruzElement): Promise<string> {
    const handle = await this.resolveHandle(el);
    if (!handle) return "";
    const t = await handle.evaluate((n: Element) => n.tagName.toLowerCase());
    await handle.dispose().catch(() => {});
    return t;
  }

  /* ── form interactions ──────────────────────────────────────── */

  async fill(el: KruzElement, value: string, opts?: { force?: boolean; timeoutMs?: number }): Promise<void> {
    await this.expectInput(Math.max(2000, opts?.timeoutMs ?? 5000));
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    try {
      if (!opts?.force) { await this.scrollHandleIntoView(handle); await handle.focus(); }
      // Focus the field even on the instant path too: a following page.press
      // (e.g. Enter to submit a search) must reach the input, and an unfocused
      // field silently drops it.
      else { await this.scrollHandleIntoView(handle).catch(() => {}); await handle.focus().catch(() => {}); }
      await handle.evaluate((node: any, v: string) => {
        // Model-synthesized input/change events — bypass the control lock filter.
      const w = window; w.__kruzAutomationBypass = true;
      try {
        if (node.disabled || node.readOnly) throw new Error("Cannot fill a disabled or readonly field");
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          if (node instanceof HTMLInputElement && /^(checkbox|radio|file|submit|button|reset|image)$/.test(node.type)) throw new Error("Target is not a text field");
          const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (!setter) throw new Error("No native value setter");
          setter.call(node, v);
        } else if (node.isContentEditable) node.textContent = v;
        else throw new Error("Target is not editable");
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        } finally { w.__kruzAutomationBypass = false; }
      }, value);
      // Framework handlers may reject or transform the value. A resolved event
      // dispatch is not sufficient evidence of a successful replacement.
      await sleep(50);
      const actual = await handle.evaluate((node: any) => node.isContentEditable ? node.textContent : node.value);
      if (actual !== value) throw new Error("Fill did not retain the requested value");
    } finally { await handle.dispose().catch(() => {}); this.endInput(); }
  }

  async type(el: KruzElement, text: string, opts?: { delayMs?: number; clear?: boolean; timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    if (opts?.clear) await handle.evaluate((n: any) => { n.value = ""; });
    // P2-B: element-level typing emits real key events, so it MUST run inside the
    // dispatch window. Without it the in-page input lock cancels each keydown in the
    // capture phase and the characters never reach the field.
    await this.expectInput(2000 + text.length * ((opts?.delayMs ?? 0) + 20));
    try {
      await handle.type(text, { delay: opts?.delayMs ?? 0 });
    } finally {
      await handle.dispose().catch(() => {});
      this.endInput();
    }
  }

  async press(el: KruzElement | undefined, key: string, opts?: { timeoutMs?: number }): Promise<void> {
    // Combo keys ("Control+a", "Shift+Home"): ElementHandle.press can't hold
    // modifiers, so focus the element and drive the combo via the keyboard.
    if (el && key.includes("+")) {
      const handle = await this.resolveHandle(el);
      if (handle) {
        await (handle as any).focus?.().catch(() => {});
        await handle.dispose().catch(() => {});
      }
      return this.keyboardPress(key);
    }
    if (el) {
      const handle = await this.resolveHandle(el);
      if (handle) {
        // P2-B: ElementHandle.press dispatches trusted key events. The in-page input
        // lock (visual-cursor.ts) cancels those events in the capture phase unless the
        // model-dispatch window is open — which is why Enter never reached the input's
        // own handlers and never triggered implicit form submission. Open it here.
        await this.expectInput(Math.max(2000, opts?.timeoutMs ?? 0));
        try {
          await handle.press(key as any);
        } finally {
          await handle.dispose().catch(() => {});
          this.endInput();
        }
        return;
      }
      // An element WAS named but could not be resolved. Falling through to
      // keyboardPress() sent the key to whatever currently held focus — so a
      // stale ref silently typed into the wrong field instead of reporting
      // STALE_REFERENCE. Only fall back when NO element was requested at all.
      throw new Error(`Element not found: ${el.handle}`);
    }
    await this.keyboardPress(key as any);
  }

  async selectOption(el: KruzElement, value: string | string[]): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    const vals = Array.isArray(value) ? value : [value];
    try {
      const matched = await handle.evaluate((node: any, values: string[]) => {
        if (!(node instanceof HTMLSelectElement)) throw new Error("Target is not a select");
        if (!values.length || (!node.multiple && values.length > 1)) throw new Error("Invalid number of selected options");
        const options = Array.from(node.options);
        return values.map(value => {
          const label = value.trim().toLowerCase();
          const option = options.find(o => o.value === value) || options.find(o => o.text.trim().toLowerCase() === label)
            || (label ? options.find(o => o.text.trim().toLowerCase().includes(label)) : undefined);
          if (!option || option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))
            throw new Error(`Option not found or disabled: ${value} (tried option value and visible label)`);
          return option.value;
        });
      }, vals);
      const selected = await handle.select(...matched);
      if (selected.length !== new Set(matched).size || matched.some(v => !selected.includes(v))) {
        throw new Error("Select did not apply all requested options");
      }
    } finally { await handle.dispose().catch(() => {}); }
  }

  async check(el: KruzElement, opts?: { force?: boolean; timeoutMs?: number }): Promise<void> {
    const state = async () => {
      const result = await this.evaluateOn(el, `(() => {
        if (this instanceof HTMLInputElement && /^(checkbox|radio)$/.test(this.type)) return this.checked;
        const value = this.getAttribute('aria-checked') ?? this.getAttribute('aria-pressed');
        return value === 'true' ? true : value === 'false' || value === 'mixed' ? false : null;
      })()`);
      if (!result.ok || typeof result.result !== 'boolean') throw new Error("Target has no readable checked state");
      return result.result;
    };
    if (await state()) return;
    await this.click(el, opts);
    for (let i = 0; i < 5; i++) {
      if (await state()) return;
      await sleep(100);
    }
    throw new Error("Checkbox is still unchecked after click");
  }

  async uncheck(el: KruzElement, _opts?: { force?: boolean; timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    try {
      const tag = await handle.evaluate((n: Element) => n.tagName.toLowerCase());
      // The click paths below are real trusted input, so they need the same
      // model-dispatch window every other action opens — otherwise the in-page
      // control lock cancels them and `uncheck` silently does nothing.
      await this.expectInput(Math.max(2000, _opts?.timeoutMs ?? 5000));
      if (tag === "input") {
        // Read the CURRENT state before dispatching anything. The old code
        // clicked unconditionally, so unchecking a checkbox that was ALREADY off
        // CHECKED it — the exact opposite of the requested action, reported as
        // success. A click is a toggle, not an assignment.
        const currentlyChecked = await handle.evaluate((n: any) => {
          if (n instanceof HTMLInputElement) return n.checked === true;
          return n.getAttribute('aria-checked') === 'true';
        });
        if (!currentlyChecked) return;
        try { await handle.click(); } catch { await handle.evaluate((n: any) => { const w = window; w.__kruzAutomationBypass = true; try { n.checked = false; n.dispatchEvent(new Event("change", { bubbles: true })); } finally { w.__kruzAutomationBypass = false; } }); }
      } else {
        const currentlyChecked = await handle.evaluate((n: any) => n.getAttribute('aria-checked') === 'true' || n.classList.contains('checked'));
        if (!currentlyChecked) return;
        await handle.click();
      }
    } finally {
      await handle.dispose().catch(() => {});
      this.endInput();
    }
  }

  async setFiles(el: KruzElement, paths: string[]): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    await (handle as any).uploadFile(...paths);
    await handle.dispose().catch(() => {});
  }

  async submitForm(_el?: KruzElement): Promise<void> {
    await this.page.evaluate(() => {
      const f = document.querySelector("form");
      if (f) (f as HTMLFormElement).requestSubmit();
    });
  }

  async setSliderValue(el: KruzElement, value: number): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    await handle.evaluate((node: any, v: number) => {
      const w = window; w.__kruzAutomationBypass = true;
      try {
        // Go through the NATIVE prototype setter, exactly as fill() does.
        // Assigning `node.value` directly only updates the DOM property;
        // React installs a value tracker and compares against the last value it
        // recorded, so it concludes nothing changed and never fires onChange —
        // the slider moved visually while the application state stayed at the
        // old value. The native setter is what React's own input simulation
        // calls, and it is what makes the tracker observe a real change.
        const proto = Object.getPrototypeOf(node);
        const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(node, String(v));
        else node.value = String(v);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      } finally { w.__kruzAutomationBypass = false; }
    }, value);
    await handle.dispose().catch(() => {});
  }

  /* ── mouse / keyboard (page-level) ──────────────────────────── */

  /**
   * Mark a model-dispatch window so the in-page control layer does not read the
   * model's OWN trusted input as a human handoff. Set at the START of an action
   * (Puppeteer's own scroll/actionability wait can take seconds on a heavy page,
   * so a short window set just before the mouse call expires mid-click), and
   * cleared explicitly afterwards. The TTL is only a safety net for a throw path.
   */
  private async expectInput(ms = 3000): Promise<void> {
    await this.page.evaluate((windowMs: number) => {
      window.__kruzExpectingInput = true;
      setTimeout(() => { window.__kruzExpectingInput = false; }, windowMs);
    }, ms).catch(() => {});
  }

  /** Close the dispatch window. Fire-and-forget: a pending native dialog makes
   *  evaluate() block, and the TTL already guarantees cleanup. */
  private endInput(): void {
    void this.page.evaluate(() => { window.__kruzExpectingInput = false; }).catch(() => {});
  }

  async mouseClick(x: number, y: number, opts?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void> {
    await this.expectInput(1500 + (opts?.clickCount ?? 1) * 150);
    await this.page.mouse.click(x, y, { button: opts?.button ?? "left", clickCount: opts?.clickCount ?? 1 });
    this.endInput();
  }
  async mouseMove(x: number, y: number): Promise<void> { await this.page.mouse.move(x, y); }
  async mouseDown(): Promise<void> { await this.page.mouse.down(); }
  async mouseUp(): Promise<void> { await this.page.mouse.up(); }
  async keyboardPress(key: string): Promise<void> {
    await this.expectInput(2000);
    // Combo support: "Control+a", "Control+Shift+s", "Alt+F4". Puppeteer's
    // press() only knows single keys ("Unknown key" otherwise), so hold the
    // modifiers around the final key.
    const parts = key.split("+").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const mods = parts.slice(0, -1).map((m) => this.modKey(m));
      const main = parts[parts.length - 1] as any;
      for (const m of mods) await this.page.keyboard.down(m);
      try { await this.page.keyboard.press(main); }
      finally { for (const m of [...mods].reverse()) await this.page.keyboard.up(m).catch(() => {}); }
      this.endInput();
      return;
    }
    await this.page.keyboard.press(key as any);
    this.endInput();
  }

  private modKey(m: string): any {
    switch (m.toLowerCase()) {
      case "control": case "ctrl": return "Control";
      case "shift": return "Shift";
      case "alt": case "option": return "Alt";
      case "meta": case "cmd": case "command": case "win": return "Meta";
      default: return m;
    }
  }
  async keyboardType(text: string, opts?: { delayMs?: number }): Promise<void> {
    await this.expectInput(2000 + text.length * ((opts?.delayMs ?? 0) + 20));
    await this.page.keyboard.type(text, { delay: opts?.delayMs ?? 0 });
    this.endInput();
  }

  /* ── scroll ──────────────────────────────────────────────────── */

  async scrollPage(direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    const dir = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[direction];
    await this.page.evaluate(([dx, dy]) => window.scrollBy({left:dx, top:dy, behavior:"instant"}), dir);
  }
  async scrollToTop(): Promise<void> { await this.page.evaluate(() => window.scrollTo({left:0, top:0, behavior:"instant"})); }
  async scrollHeight(): Promise<number> { return this.page.evaluate(() => document.body.scrollHeight); }
  async scrollY(): Promise<number> { return this.page.evaluate(() => window.scrollY); }

  /* ── wait helpers ───────────────────────────────────────────── */

  async waitForSelector(target: Target, opts: { state: "visible" | "hidden" | "attached"; timeoutMs: number }): Promise<KruzElement | null> {
    const sel = this.selectorFor(target);
    try {
      const puppeteerOpts: { visible?: boolean; hidden?: boolean; timeout?: number } = { timeout: opts.timeoutMs };
      if (opts.state === "visible") puppeteerOpts.visible = true;
      else if (opts.state === "hidden") puppeteerOpts.hidden = true;
      await this.page.waitForSelector(sel, puppeteerOpts);
      return { handle: sel, strategy: "waitForSelector", target, resolvedAt: Date.now() };
    } catch {
      return null;
    }
  }

  async waitMs(ms: number): Promise<void> { await sleep(ms); }

  async waitForNavigation(timeoutMs: number): Promise<void> {
    await this.page.waitForNavigation({ timeout: timeoutMs }).catch(() => {});
  }

  async inputValue(el: KruzElement): Promise<string> {
    const handle = await this.resolveHandle(el);
    if (!handle) return "";
    const val = await handle.evaluate((n: any) => n.value ?? "").catch(() => "");
    await handle.dispose().catch(() => {});
    return val;
  }

  async countElements(target: Target, scope?: string): Promise<number> {
    const sel = this.selectorFor(target, undefined, scope);
    // Dispose the probe handles: only the COUNT is wanted. Returning `els.length`
    // while leaving the handles alive accumulated an undisposed remote object per
    // matched element for the life of the document (fidelity extraction and the
    // controller both call this repeatedly on dense pages).
    return this.page.$$(sel).then(async (els) => { const n = els.length; await Promise.all(els.map((e) => e.dispose())); return n; }).catch(() => 0);
  }

  async screenshotElement(el: KruzElement, opts?: { path?: string; type?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Buffer> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    const type = opts?.type ?? "png";
    const buf = await handle.screenshot({
      type,
      path: opts?.path as any,
      ...(type === "png" ? {} : { quality: opts?.quality ?? 80 }),
    }) as Buffer;
    await handle.dispose().catch(() => {});
    return Buffer.from(buf);
  }

  /** Intrinsic dimensions of a PNG/JPEG/WebP buffer. Advisory; never throws. */
  imageDimensions(buf: Buffer): { width: number | null; height: number | null } {
    return this.imageSize(buf);
  }

  async queryOneInFrame(frameId: string, target: Target, fallback?: Fallback): Promise<KruzElement | null> {
    const f = this.page.frames().find((f) => f.url() === frameId);
    if (!f) return null;
    const sel = this.selectorFor(target, fallback);
    try {
      await f.waitForSelector(sel, { timeout: 3000 });
      // The handle MUST be frame-scoped. It used to be the bare selector, so
      // resolveHandle fell through to `this.page.$(el.handle)` — a query against
      // the MAIN frame. An element that exists ONLY inside the iframe (the whole
      // point of this method) therefore resolved to null and was reported
      // "Element not found" despite having just been found. The format matches
      // the `frame:` branch of resolveHandle exactly.
      return { handle: 'frame:' + JSON.stringify([f.url(), sel]), strategy: `frame:${frameId}`, target, fallback, resolvedAt: Date.now() };
    } catch {
      return null;
    }
  }

  async queryAllInFrame(frameId: string, target: Target, fallback?: Fallback): Promise<KruzElement[]> {
    const f = this.page.frames().find((f) => f.url() === frameId);
    if (!f) return [];
    const sel = this.selectorFor(target, fallback);
    // Dispose the probe handles: only their COUNT is wanted, and leaking them
    // keeps remote objects alive for the life of the document (compare queryAll).
    const count = await f.$$(sel).then(async (els) => { const n = els.length; await Promise.all(els.map((e) => e.dispose())); return n; }).catch(() => 0);
    return Array.from({ length: count }, (_, i) => ({
      // Same frame-scoped, index-bearing shape resolveHandle understands. The old
      // `frame:${frameId}:${sel}:nth(${i})` was fed to `JSON.parse(slice(6))`,
      // which threw, so resolveHandle returned null for EVERY hit — iCIMS
      // extraction silently yielded zero job links.
      handle: 'frame:' + JSON.stringify([f.url(), sel, i]),
      strategy: `frame:${frameId}:nth(${i})`,
      target,
      fallback,
      resolvedAt: Date.now(),
    }));
  }

  async queryOneInScope(parent: KruzElement, target: Target, fallback?: Fallback, _timeoutMs?: number): Promise<KruzElement | null> {
    const parentHandle = await this.resolveHandle(parent);
    if (!parentHandle) return null;
    const sel = this.selectorFor(target, fallback);
    try {
      const child = await parentHandle.$(sel);
      await parentHandle.dispose().catch(() => {});
      if (!child) return null;
      await child.dispose().catch(() => {});
      return { handle: `${parent.handle} >> ${sel}`, strategy: "scope", target, fallback, resolvedAt: Date.now() };
    } catch {
      await parentHandle.dispose().catch(() => {});
      return null;
    }
  }

  async contextFetch(url: string, opts?: { method?: string; timeoutMs?: number }): Promise<{ ok: boolean; status: number; headers: Record<string, string>; text: string }> {
    // Runs in the Node process, NOT through the page: an in-page fetch() is subject
    // to the same-origin policy, so cross-origin ATS feeds (boards-api.greenhouse.io,
    // api.lever.co, posting-api/job-board/*) came back HTTP 0 even on public boards.
    // Node's own fetch has no CORS and hits the feed directly.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 20000);
      try {
        const res = await fetch(url, { method: opts?.method ?? "GET", signal: controller.signal });
        const text = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        return { ok: res.ok, status: res.status, headers, text };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, status: 0, headers: {}, text: String((e as Error)?.message ?? e) };
    }
  }

  private _loadCallbacks: Array<() => void> = [];
  onPageLoad(callback: () => void): void {
    this._loadCallbacks.push(callback);
    this.page.on("load", () => callback());
  }

  /* ── drag & drop ────────────────────────────────────────────── */

  async dragPointer(srcBox: { x: number; y: number }, dstBox: { x: number; y: number }): Promise<void> {
    // Same dispatch window as dragPath(): these are trusted mouse events, and the
    // in-page control lock cancels them otherwise. This is the fallback path of
    // html5Drag, so when the HTML5 route threw, the pointer route was cancelled
    // too and the drag silently did nothing.
    await this.expectInput(Math.max(3000, 5000));
    try {
      await this.page.mouse.move(srcBox.x, srcBox.y);
      await this.page.mouse.down();
      await sleep(50);
      await this.page.mouse.move(dstBox.x, dstBox.y, { steps: 20 });
      await this.page.mouse.up();
    } finally {
      this.endInput();
    }
  }

  async dragPath(
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: { steps?: number; button?: "left" | "right" | "middle"; speed?: "instant" | "fast" | "normal" | "slow"; modifiers?: string[]; pressHoldMs?: number; releaseSettleMs?: number },
  ): Promise<{ steps: number; duration_ms: number; modifiers: string[] }> {
    const speed = opts?.speed ?? "normal";
    const button = (opts?.button ?? "left") as any;
    const modifiers = (opts?.modifiers ?? []).filter((m) => !!m);
    const t0 = Date.now();
    // Held keys make the browser apply the modifier to the generated mouse events,
    // which is what shift-click multi-select and ctrl-click additive selection in
    // canvas editors actually listen for.
    for (const m of modifiers) await this.page.keyboard.down(m as any);
    let steps = 0;
    try {
      await this.expectInput(Math.max(3000, 5000));
      // Approach the grab point and pause: a press with no prior hover registers as a
      // cold hit-test miss on engines that require a hover target.
      await this.page.evaluate((x: number, y: number) => { try { (window as any).__kruzVisual?.setPos(x, y); } catch { /* layer absent */ } }, from.x, from.y).catch(() => {});
      await this.page.mouse.move(from.x, from.y);
      await sleep(speed === "instant" ? 0 : 40);

      await this.page.evaluate(() => { try { (window as any).__kruzVisual?.press(true); } catch { /* layer absent */ } }).catch(() => {});
      await this.page.mouse.down({ button });
      const pressHold = opts?.pressHoldMs ?? (speed === "instant" ? 0 : 60);
      if (pressHold) await sleep(pressHold);

      // Walk a real trajectory with per-step delays. Every intermediate move is
      // dispatched while the button is held (puppeteer tracks the pressed buttons),
      // so the page sees a continuous pointer drag rather than two teleports.
      //
      // `steps` is honoured by resampling the human trajectory, not by replacing
      // it: the easing curve is what makes the gesture look human, and the count is
      // what decides whether the page starts a drag at all. Ignoring `steps` made a
      // documented knob a no-op (asked for 30, got the speed default).
      const raw = computePath(from, to, { speed });
      const want = opts?.steps && opts.steps > 1 ? Math.min(opts.steps, 200) : raw.length;
      const path = resamplePath(raw, want);
      const delays = stepDelaysMs(path, { speed });
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        await this.page.evaluate((x: number, y: number) => { try { (window as any).__kruzVisual?.setPos(x, y); } catch { /* layer absent */ } }, p.x, p.y).catch(() => {});
        await this.page.mouse.move(p.x, p.y);
        steps++;
        const d = delays[i] ?? 0;
        if (d > 0) await sleep(d);
      }

      // Settle on the target before releasing. Releasing on the same task as the last
      // move is a recognised way to lose a drop.
      const settle = opts?.releaseSettleMs ?? (speed === "instant" ? 0 : 80);
      if (settle) await sleep(settle);
      await this.page.mouse.up({ button });
      await this.page.evaluate(() => { try { const v = (window as any).__kruzVisual; v?.press(false); v?.ripple(); } catch { /* layer absent */ } }).catch(() => {});
    } finally {
      // Release must happen even if the gesture failed, or the page keeps a stuck
      // primary button — which silently disables every later click.
      try { await this.page.mouse.up({ button }); } catch { /* already up */ }
      for (const m of [...modifiers].reverse()) await this.page.keyboard.up(m as any).catch(() => {});
      this.endInput();
    }
    return { steps, duration_ms: Date.now() - t0, modifiers };
  }

  async viewportPoint(el: KruzElement): Promise<{ x: number; y: number } | null> {
    const handle = await this.resolveHandle(el);
    if (!handle) return null;
    try {
      await this.scrollHandleIntoView(handle);
      return await handle.evaluate((n: any) => {
        const r = n.getBoundingClientRect();
        // `&&` is wrong here: a collapsed element is one with EITHER dimension
        // zero, which is exactly what computeClickPoint (line ~1103) checks with
        // `||`. With `&&`, a 0x40px element passed the guard and returned a point
        // on its left EDGE (x = r.left), so page.drag pressed on the boundary of
        // the element instead of reporting ELEMENT_NOT_VISIBLE.
        if (r.width === 0 || r.height === 0) return null;
        // getBoundingClientRect is viewport-relative, which is exactly the space
        // trusted mouse input is dispatched in.
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async uploadFileTo(el: KruzElement, paths: string[]): Promise<{ files: string[] }> {
    // Same CDP DOM.setFileInputFiles route as setFiles(), kept as a named method
    // because "attach a file" is the operation a caller is actually expressing.
    await this.setFiles(el, paths);
    return { files: paths };
  }

  async html5Drag(src: KruzElement, dst: KruzElement, payload?: Record<string, string>): Promise<void> {
    const srcHandle = await this.resolveHandle(src);
    const dstHandle = await this.resolveHandle(dst);
    if (!srcHandle || !dstHandle) throw new Error("Source or dest not found");
    try {
      await srcHandle.evaluate((s: any, d: any, data: Record<string, string> | null) => {
        const dt = new DataTransfer();
        // Seed the payload DIRECTLY rather than trusting the page's own dragstart
        // listener. Measured in this Chrome: `dt.setData()` called straight from
        // script survives, but the SAME call made inside a `dragstart` handler on a
        // synthetic DataTransfer is discarded — the drop handler then read an empty
        // string even though dragstart had fired. So a synthetic HTML5 drag cannot
        // rely on the app populating its own transfer, and `data` is the way through.
        if (data) { for (const k of Object.keys(data)) { try { dt.setData(k, String(data[k])); } catch { /* type rejected */ } } }
        try { dt.effectAllowed = "all"; dt.dropEffect = "move"; } catch { /* older shape */ }
        s.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
        // dragenter/dragover before drop: most real drop handlers only accept the
        // drop once dragover has been preventDefault()-ed, so skipping them makes a
        // correct handler ignore an otherwise well-formed drop.
        for (const type of ["dragenter", "dragover"]) {
          const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
          d.dispatchEvent(e);
        }
        d.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        s.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, dstHandle, payload ?? null);
    } catch {
      // fallback: pointer events drag
      const srcBox = await srcHandle.boundingBox();
      const dstBox = await dstHandle.boundingBox();
      if (srcBox && dstBox) await this.dragPointer(srcBox, dstBox);
    }
    await srcHandle.dispose().catch(() => {});
    await dstHandle.dispose().catch(() => {});
  }

  /* ── shadow DOM ─────────────────────────────────────────────── */

  async queryOnePiercing(target: Target, fallback?: Fallback, scope?: string): Promise<KruzElement | null> {
    // Shadow-piercing strategy: walk OPEN shadow roots IN-PAGE and stash the live
    // matched node on `window.__kruzMarkedNode`, then adopt it via
    // takeMarkedNode. Taking the node object is the only route that works — no
    // CSS selector addresses a node inside a shadow root.
    //
    // This previously did two things that made it a no-op:
    //  1. `walk(document, …)` — `document.nodeType` is 9, and the walk returned
    //     null for any node that was not an ELEMENT_NODE, so it bailed on the
    //     very first call and `sel` was always null.
    //  2. it created a CDP session (`createCDPSession`) twice — once assigned to
    //     an unused `client` local and never detached — and fetched a
    //     `DOM.getDocument` result that was then thrown away.
    // So the method silently degraded to plain `queryOne` on every call and
    // leaked a CDP session per invocation.
    const marked = await this.page
      .evaluateHandle((t: Target) => {
        const matches = (node: any, target: any): boolean => {
          if (!node || !target) return false;
          try {
            if (target.css && node.matches(target.css)) return true;
            if (target.id && node.id === target.id) return true;
            if (target.testid && node.getAttribute("data-testid") === target.testid) return true;
            if (target.role && node.getAttribute("role") === target.role) return true;
            if (target.nameAttr && node.getAttribute("name") === target.nameAttr) return true;
          } catch { /* invalid selector / cross-origin node */ }
          return false;
        };
        // Depth-first over the document AND every open shadow root. Light DOM is
        // searched first so a page's own control always wins over a component's.
        const walk = (root: any): any => {
          let nodes: any[] = [];
          try { nodes = Array.from(root.querySelectorAll("*")); } catch { return null; }
          for (const n of nodes) {
            if (matches(n, t)) return n;
            // `matches` covers the node itself; check its open shadow subtree.
            const sr = n.shadowRoot;
            if (sr) {
              const hit = walk(sr);
              if (hit) return hit;
            }
          }
          return null;
        };
        const found = walk(document);
        (window as any).__kruzMarkedNode = found ?? null;
        return !!found;
      }, target)
      .catch(() => null);

    const ok = (marked as any)?.jsonValue ? await (marked as any).jsonValue().catch(() => false) : false;
    await marked?.dispose?.().catch(() => {});

    if (ok) {
      const el = await this.takeMarkedNode(this.selectorFor(target, fallback, scope), target);
      // Clear the stash so a later unrelated takeMarkedNode() can never adopt a
      // stale node from this call.
      await this.page.evaluate(() => { try { (window as any).__kruzMarkedNode = null; } catch { /* gone */ } }).catch(() => {});
      if (el) return el;
    }

    return this.queryOne(target, fallback, scope);
  }

  /* ── network capture ─────────────────────────────────────────── */

  /** Guarded interception handler: never throws into the emitter (an uncaught
   *  "Request is already handled!" previously killed the whole MCP process on
   *  the second navigation). Attached once per page in attachHandlers — never
   *  per-navigation, so duplicate listeners can't stack up. */
  private readonly _onRequest = (req: any) => {
    try {
      if (typeof req.isInterceptResolutionHandled === "function" && req.isInterceptResolutionHandled()) return;
      req.continue().catch(() => {});
    } catch { /* already handled — swallow */ }
  };

  async enableNetworkCapture(opts: { captureBodies?: boolean }): Promise<void> {
    this._networkEnabled = true;
    this._captureBodies = opts.captureBodies ?? false;
    this._networkEvents = [];
    // Speed: request interception forces EVERY request through a CDP
    // round-trip. Only pay for it when body capture is actually on (ATS feed
    // reads via network.body). Default browsing runs interception-free.
    // The "response" listener (URL/method/status log) works regardless.
    if (this._captureBodies) await this.setInterception(this.page, true);
    else await this.setInterception(this.page, false);
  }
  async disableNetworkCapture(): Promise<void> {
    this._networkEnabled = false;
    this._captureBodies = false;
    await this.setInterception(this.page, false);
  }
  drainNetworkEvents(): NetworkEvent[] {
    const out = [...this._networkEvents];
    this._networkEvents = [];
    return out;
  }
  getResponseBody(filter: string): NetworkEvent | null {
    return this._networkEvents.find((e) => e.url.includes(filter)) ?? null;
  }

  /* ── console capture ────────────────────────────────────────── */

  async enableConsoleCapture(): Promise<void> {
    this._consoleEnabled = true;
    this._consoleEvents = [];
  }
  async disableConsoleCapture(): Promise<void> { this._consoleEnabled = false; }
  drainConsoleEvents(): ConsoleEvent[] {
    const out = [...this._consoleEvents];
    this._consoleEvents = [];
    return out;
  }

  /* ── dialog ──────────────────────────────────────────────────── */

  async handleDialog(action: "accept" | "dismiss", promptText?: string): Promise<void> {
    const index = this._dialogQueue.findIndex(d => d.page === this._page);
    if (index < 0) throw new Error("No pending dialog on the active page");
    const pending = this._dialogQueue[index];
    if (action === "accept") await pending.dialog.accept(promptText);
    else await pending.dialog.dismiss();
    this._dialogQueue.splice(index, 1);
  }
  nextDialog(): Promise<DialogEvent | null> {
    return Promise.resolve(this._dialogQueue.find(d => d.page === this._page)?.event ?? null);
  }
  setDialogPolicy(action: "accept" | "dismiss", value?: string): void {
    this._dialogPolicy = { action, value };
  }

  /* ── capabilities ───────────────────────────────────────────── */

  hasCapability(name: EngineCapability): boolean {
    switch (name) {
      case "closed-shadow-pierce": return true; // via in-page walk of open shadow roots
      // TRUE, and previously reported false. Both boot() (installStealth) and
      // newTab() call `page.evaluateOnNewDocument`, so scripts genuinely do run
      // before page scripts on every document. A capability gate reading this
      // flag was told the opposite of what the engine does.
      case "document-start-injection": return true;
      case "bot-detection-evasion": return true; // launch flags
      case "native-input-os-level": return false;
      case "iframe-crossorigin-eval": return true; // Puppeteer handles this
      case "request-modification": return true;
      default: return false;
    }
  }
}
