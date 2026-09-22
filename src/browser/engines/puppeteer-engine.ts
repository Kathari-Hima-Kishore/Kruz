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
 *   4. When the Kruz Extension is loaded, query operations that need
 *      `document_start` timing or closed-shadow-piercing are routed
 *      through the extension's content-script portal (via page.evaluate).
 *
 * Element handles:
 *   KruzElement is just an opaque `{ handle, strategy, target, resolvedAt }`.
 *   The `handle` is a CSS selector string that we re-resolve on every action
 *   (lazy resolution) so stale-element errors are handled gracefully.
 */

import puppeteer, { type Page, type Browser, type ElementHandle, type Dialog } from "puppeteer-core";
import { resolve } from "node:path";
import type {
  BrowserEngine, KruzElement, KruzFrame, EvalResult, NetworkEvent,
  ConsoleEvent, DialogEvent, KruzTab, EngineCapability,
} from "../engine.js";
import type { Target, Fallback } from "../../types/schema.js";
import type { P1Config } from "../../config.js";

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
  private _consoleEvents: ConsoleEvent[] = [];
  private _consoleEnabled = false;
  private _dialogQueue: { page: Page; dialog: Dialog; event: DialogEvent }[] = [];
  private _dialogPolicy?: { action: "accept" | "dismiss"; value?: string };
  private _config: P1Config | null = null;
  private evaluateTimeoutMs = 5000;

  constructor(private readonly launchBrowser: boolean, private readonly cdpEndpoint?: string) {}

  get connected(): boolean { return this._connected && !!this._browser?.connected; }

  /* ── lifecycle ─────────────────────────────────────────────── */

  async boot(config: P1Config, profileDir: string): Promise<void> {
    this._config = config;
    if (this.launchBrowser) {
      const chromeFlags = [
        "--disable-blink-features=AutomationControlled",
        "--allow-file-access-from-files",
        // Required for extensions (incl. manually-installed ones) to run in
        // a Puppeteer-launched Chrome — Puppeteer's defaults disable them.
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        ...(config.extensionPath ? ["--enable-unsafe-extension-debugging"] : []),
        ...(config.headless ? [] : ["--start-maximized"]),
      ];
      this._browser = await puppeteer.launch({
        executablePath: config.browserPath || undefined,
        headless: config.headless ? true : false,
        userDataDir: profileDir,
        args: chromeFlags,
        defaultViewport: null,
        pipe: !!config.extensionPath,
        ignoreDefaultArgs: ["--enable-automation", "--disable-extensions", "--disable-component-extensions-with-background-pages"],
      });
    } else if (this.cdpEndpoint) {
      this._browser = await puppeteer.connect({ browserWSEndpoint: this.cdpEndpoint });
    } else {
      throw new Error("PuppeteerEngine: either launchBrowser=true or cdpEndpoint required");
    }
    if (this.launchBrowser && config.extensionPath) {
      const cdp = await this._browser.target().createCDPSession();
      try { await cdp.send("Extensions.loadUnpacked" as any, { path: resolve(config.extensionPath) }); }
      catch (error) { await this.shutdown(); throw new Error(`Kruz extension could not be loaded through Chrome extension debugging: ${error}`); }
      finally { await cdp.detach().catch(() => {}); }
    }
    const pages = await this._browser.pages();
    this._page = pages[0] ?? (await this._browser.newPage());
    this.attachHandlers(this._page);
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
          evt.body = txt;
          evt.truncated = txt.length > 200_000;
        } catch { /* ignore */ }
      }
      this._networkEvents.push(evt);
    });
  }

  /* ── page-level ─────────────────────────────────────────────── */

  async url(): Promise<string> { return this.page.url(); }
  async title(): Promise<string> {
    // K31: bound like evaluate — Page.getTitle can hang right after a goto timeout.
    try { return await this.withEvaluateTimeout(this.page.title()); }
    catch { return ""; }
  }
  async viewportSize(): Promise<{ width: number; height: number }> {
    const vp = this.page.viewport();
    return vp ? { width: vp.width, height: vp.height } : { width: 1280, height: 720 };
  }
  async setViewportSize(w: number, h: number): Promise<void> { await this.page.setViewport({ width: w, height: h }); }
  async bringToFront(): Promise<void> {
    // K31: Page.bringToFront CDP can hang without responding right after a goto timeout.
    // It's a focus ping on an already-active page (we just navigated it), so a short bound
    // is plenty — the old 5s credit here was ~4s of open()'s overhead on slow portals.
    try { await this.withEvaluateTimeout(this.page.bringToFront(), 1500); }
    catch { /* best-effort; the page is already active if we just navigated it */ }
  }
  async close(): Promise<void> { await this.page.close().catch(() => {}); }
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
    // K32: the old code never assigned this._page to the new tab, so the
    // "switch to it" contract was broken — controller.newTab brought the OLD
    // tab to front and every subsequent action ran against the wrong page.
    this._page = p;
    if (url) await p.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await p.bringToFront().catch(() => {});
    return { id: this.tabId(p), url: p.url(), title: await p.title().catch(() => ""), isActive: true };
  }
  async listTabs(): Promise<KruzTab[]> {
    const pages = await this._browser!.pages();
    const active = this._page;
    return Promise.all(pages.map(async (p) => ({
      id: this.tabId(p),
      url: p.url(),
      title: await p.title().catch(() => ""),
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
    }
  }
  async switchTab(tabId: string): Promise<void> {
    const p = await this.resolveTab(tabId);
    if (!p) throw new Error(`No open tab '${tabId}'`);
    this.attachHandlers(p);
    this._page = p;
    // Keep interception live on the newly-active tab so network capture
    // (ATS feed bodies) keeps working after a switch.
    if (this._networkEnabled) await p.setRequestInterception(true).catch(() => {});
    await p.bringToFront().catch(() => {});
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
  async readVariable<T = unknown>(name: string): Promise<T | undefined> {
    try {
      const result = await this.page.evaluate((n: string) => (globalThis as any)[n], name);
      return result as T | undefined;
    } catch {
      return undefined;
    }
  }

  /* ── screenshot ──────────────────────────────────────────────── */

  async screenshot(opts: { fullPage?: boolean; path?: string }): Promise<Buffer> {
    const buf = await this.page.screenshot({ fullPage: opts.fullPage ?? false, path: opts.path, type: "png" });
    return Buffer.from(buf);
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

  async queryOne(target: Target, fallback?: Fallback, scope?: string, timeoutMs = 3000): Promise<KruzElement | null> {
    const sel = this.selectorFor(target, fallback, scope);
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
      try {
        await this.page.waitForSelector(sel, { timeout: timeoutMs });
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
      if (String(error).includes('AMBIGUOUS_TARGET')) throw error;
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
      if (el.handle.startsWith('frame:')) {
        const [url, selector] = JSON.parse(el.handle.slice(6));
        const frames = this.page.frames().filter(f => f.url() === url);
        if (frames.length !== 1) throw new Error('Ambiguous or missing child frame');
        return frames[0].$(selector);
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

  async click(el: KruzElement, opts?: { button?: "left" | "right" | "middle"; clickCount?: number; force?: boolean; timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    try {
      const enabled = await handle.evaluate((node: any) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');
      if (!enabled) throw new Error('ELEMENT_DISABLED');
      const visible = await handle.isVisible();
      if (!visible && !opts?.force) throw new Error('ELEMENT_NOT_VISIBLE');
      await this.scrollHandleIntoView(handle);
      if (!opts?.force) {
        const covered = await handle.evaluate((node: any) => {
          const r = node.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          let hit = node.ownerDocument.elementFromPoint(x, y);
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
          return { target: node.tagName, hit: hit?.tagName ?? null, hit_id: hit?.id ?? null, x, y };
        });
        if (covered) throw new Error(`ELEMENT_OBSCURED: ${JSON.stringify(covered)}`);
      }
      const page = this.page;
      let listener: ((dialog: Dialog) => void) | undefined;
      const dialogOpened = new Promise<void>(resolve => { listener = () => resolve(); page.once('dialog', listener); });
      try {
        const action = opts?.force ? handle.evaluate((node: any) => node.click()) : handle.click({button: opts?.button, clickCount: opts?.clickCount});
        await Promise.race([action, dialogOpened]);
      } finally { if (listener) page.off('dialog', listener); }
    } finally {
      // Disposal waits on renderer execution while a native dialog is open.
      if (!this._dialogQueue.some(d => d.page === this.page)) await handle.dispose().catch(() => {});
    }
  }

  async dblclick(el: KruzElement, opts?: { timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    await handle.click({ clickCount: 2 });
    await handle.dispose().catch(() => {});
  }

  async hover(el: KruzElement, opts?: { timeoutMs?: number; dwellMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    await handle.hover();
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
    try {
      const rectOf = (n: any) => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(","); };
      let last: string = await handle.evaluate(rectOf);
      for (let i = 0; i < 10; i++) {
        await sleep(100);
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

  /** Build a unique CSS selector for an already-resolved element (id-first,
   *  else nth-of-type chain). Lets callers address the exact node via the
   *  extension portal's trusted-event click instead of re-querying. */
  async uniqueSelector(el: KruzElement): Promise<string | null> {
    const r = await this.evaluateOn(el, `(() => { const n = this; if (!n || !n.tagName) return null; if (n.id) return '#' + CSS.escape(n.id); const parts = []; let cur = n; while (cur && cur !== document.body && parts.length < 6) { let seg = cur.tagName.toLowerCase(); const parent = cur.parentElement; if (parent) { const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName); if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')'; } parts.unshift(seg); cur = parent; } parts.unshift('body'); return parts.join(' > '); })()`).catch(() => ({ ok: false as const }));
    const sel = r?.ok ? (r.result as string | null) : null;
    return sel && sel.length < 500 ? sel : null;
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
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    try {
      if (!opts?.force) { await this.scrollHandleIntoView(handle); await handle.focus(); }
      await handle.evaluate((node: any, v: string) => {
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
      }, value);
      // Framework handlers may reject or transform the value. A resolved event
      // dispatch is not sufficient evidence of a successful replacement.
      await sleep(50);
      const actual = await handle.evaluate((node: any) => node.isContentEditable ? node.textContent : node.value);
      if (actual !== value) throw new Error("Fill did not retain the requested value");
    } finally { await handle.dispose().catch(() => {}); }
  }

  async type(el: KruzElement, text: string, opts?: { delayMs?: number; clear?: boolean; timeoutMs?: number }): Promise<void> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    if (opts?.clear) await handle.evaluate((n: any) => { n.value = ""; });
    await handle.type(text, { delay: opts?.delayMs ?? 0 });
    await handle.dispose().catch(() => {});
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
        await handle.press(key as any);
        await handle.dispose().catch(() => {});
        return;
      }
    }
    await this.page.keyboard.press(key as any);
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
    const tag = await handle.evaluate((n: Element) => n.tagName.toLowerCase());
    if (tag === "input") {
      try { await handle.click(); } catch { await handle.evaluate((n: any) => { n.checked = false; n.dispatchEvent(new Event("change", { bubbles: true })); }); }
    } else {
      await handle.click();
    }
    await handle.dispose().catch(() => {});
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
      node.value = String(v);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    await handle.dispose().catch(() => {});
  }

  /* ── mouse / keyboard (page-level) ──────────────────────────── */

  async mouseClick(x: number, y: number, opts?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void> {
    await this.page.mouse.click(x, y, { button: opts?.button ?? "left", clickCount: opts?.clickCount ?? 1 });
  }
  async mouseMove(x: number, y: number): Promise<void> { await this.page.mouse.move(x, y); }
  async mouseDown(): Promise<void> { await this.page.mouse.down(); }
  async mouseUp(): Promise<void> { await this.page.mouse.up(); }
  async keyboardPress(key: string): Promise<void> {
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
      return;
    }
    await this.page.keyboard.press(key as any);
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
    await this.page.keyboard.type(text, { delay: opts?.delayMs ?? 0 });
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
    return this.page.$$(sel).then((els) => els.length).catch(() => 0);
  }

  async screenshotElement(el: KruzElement, opts?: { path?: string }): Promise<Buffer> {
    const handle = await this.resolveHandle(el);
    if (!handle) throw new Error(`Element not found: ${el.handle}`);
    const buf = await handle.screenshot({ type: "png", path: opts?.path as any }) as Buffer;
    await handle.dispose().catch(() => {});
    return Buffer.from(buf);
  }

  async queryOneInFrame(frameId: string, target: Target, fallback?: Fallback): Promise<KruzElement | null> {
    const f = this.page.frames().find((f) => f.url() === frameId);
    if (!f) return null;
    const sel = this.selectorFor(target, fallback);
    try {
      await f.waitForSelector(sel, { timeout: 3000 });
      return { handle: sel, strategy: `frame:${frameId}`, target, fallback, resolvedAt: Date.now() };
    } catch {
      return null;
    }
  }

  async queryAllInFrame(frameId: string, target: Target, fallback?: Fallback): Promise<KruzElement[]> {
    const f = this.page.frames().find((f) => f.url() === frameId);
    if (!f) return [];
    const sel = this.selectorFor(target, fallback);
    const count = await f.$$(sel).then((els) => els.length).catch(() => 0);
    return Array.from({ length: count }, (_, i) => ({
      handle: `frame:${frameId}:${sel}:nth(${i})`,
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
    await this.page.mouse.move(srcBox.x, srcBox.y);
    await this.page.mouse.down();
    await sleep(50);
    await this.page.mouse.move(dstBox.x, dstBox.y, { steps: 20 });
    await this.page.mouse.up();
  }

  async html5Drag(src: KruzElement, dst: KruzElement): Promise<void> {
    const srcHandle = await this.resolveHandle(src);
    const dstHandle = await this.resolveHandle(dst);
    if (!srcHandle || !dstHandle) throw new Error("Source or dest not found");
    try {
      await srcHandle.evaluate((s: any, d: any) => {
        const dt = new DataTransfer();
        const dragStart = new DragEvent("dragstart", { bubbles: true, dataTransfer: dt });
        s.dispatchEvent(dragStart);
        const drop = new DragEvent("drop", { bubbles: true, dataTransfer: dt });
        d.dispatchEvent(drop);
        const dragEnd = new DragEvent("dragend", { bubbles: true, dataTransfer: dt });
        s.dispatchEvent(dragEnd);
      }, dstHandle);
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
    // puppeteer-core gives us CDPSession — use DOM.getDocument with pierce:true
    const client = (this.page as any).target().createCDPSession?.() as Promise<any>;
    try {
      const cdp = await (this.page as any).target().createCDPSession();
      await cdp.send("DOM.enable");
      const doc = await cdp.send("DOM.getDocument", { depth: 20, pierce: true });
      await cdp.detach();
      // Convert CDP nodeId -> selector path via evaluate
      const sel = await this.page.evaluate((t: Target) => {
        const root = document;
        // Walk shadow roots to build a selector
        const walk = (node: any, path: string[]): string | null => {
          if (!node) return null;
          if (node.nodeType !== Node.ELEMENT_NODE) return null;
          const tag = node.tagName.toLowerCase();
          const id = node.id ? `#${node.id}` : "";
          const cls = node.className ? `.${node.className.trim().split(/\s+/).join(".")}` : "";
          const part = `${tag}${id}${cls}`;
          // Check if this matches the target
          const matches = (target: any): boolean => {
            if (!target) return false;
            if (target.css && node.matches(target.css)) return true;
            if (target.id && node.id === target.id) return true;
            if (target.testid && node.getAttribute("data-testid") === target.testid) return true;
            if (target.role && node.getAttribute("role") === target.role) return true;
            if (target.nameAttr && node.getAttribute("name") === target.nameAttr) return true;
            return false;
          };
          if (matches(t)) return path.concat(part).join(" > ");
          // Check shadow children
          for (const child of (node.shadowRoot ? Array.from(node.shadowRoot.children) : [])) {
            const r = walk(child, path.concat(part));
            if (r) return r;
          }
          return null;
        };
        return walk(root, []);
      }, target);
      if (sel) return this.queryOne({ ...target, css: sel }, fallback, scope);
    } catch {
      // fallback to normal query
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
    if (this._captureBodies) await this.page.setRequestInterception(true).catch(() => {});
    else await this.page.setRequestInterception(false).catch(() => {});
  }
  async disableNetworkCapture(): Promise<void> {
    this._networkEnabled = false;
    this._captureBodies = false;
    await this.page.setRequestInterception(false).catch(() => {});
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
      case "closed-shadow-pierce": return true; // via CDP DOM.getDocument
      case "document-start-injection": return false; // needs extension
      case "bot-detection-evasion": return true; // launch flags
      case "native-input-os-level": return false;
      case "iframe-crossorigin-eval": return true; // Puppeteer handles this
      case "request-modification": return true;
      default: return false;
    }
  }
}
