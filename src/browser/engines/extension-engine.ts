/**
 * ExtensionEngine — minimal working stub.
 *
 * The Kruz Ctrl MV3 extension provides bot evasion and DOM access on JS-heavy
 * websites. The ExtensionEngine wraps the extension portal when available,
 * and falls back to PuppeteerEngine when it isn't.
 *
 * This is a minimal compile-clean version. The full implementation with
 * shadow DOM piercing, live MutationObserver streaming, and the portal
 * API can be layered on once the rest of the codebase is stable.
 */

import { type Page, type Browser } from "puppeteer-core";
import type {
  BrowserEngine, KruzElement, KruzFrame, EvalResult, NetworkEvent,
  ConsoleEvent, DialogEvent, KruzTab, EngineCapability,
} from "../engine.js";
import type { Target, Fallback } from "../../types/schema.js";
import type { P1Config } from "../../config.js";
import { PuppeteerEngine } from "./puppeteer-engine.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ExtensionEngine implements BrowserEngine {
  readonly kind = "extension" as const;
  private _puppeteer: PuppeteerEngine;
  private _portalReady = false;
  private _extensionPath?: string;

  constructor() {
    this._puppeteer = new PuppeteerEngine(true);
  }

  get connected(): boolean { return this._puppeteer.connected; }

  async boot(config: P1Config, profileDir: string, extensionPath?: string): Promise<void> {
    this._extensionPath = extensionPath;
    await this._puppeteer.boot(config, profileDir);
    // Best-effort: wait briefly for the Kruz Ctrl content script to set
    // window.__kruz_extension_ready__ on the first page. If the extension
    // isn't loaded, we just fall back to plain Puppeteer operations.
    if (extensionPath) {
      try {
        const page = (this._puppeteer as any)._page as Page | undefined;
        if (page) {
          for (let i = 0; i < 25; i++) {
            const ready = await page.evaluate(
              () => !!(window as any).__kruz_extension_ready__
            ).catch(() => false);
            if (ready) { this._portalReady = true; break; }
            await sleep(200);
          }
        }
      } catch { /* ignore — fall back */ }
    }
  }

  async shutdown(): Promise<void> { await this._puppeteer.shutdown(); }

  // ── Extension portal fast path ─────────────────────────────────────
  // The MV3 content script exposes window.__kruz__ (MAIN world, document_start):
  // trusted-event clicks and piercing queries that sail through bot-walled
  // portals where CDP-synthesized input gets swallowed. Previously _portalReady
  // only gated capability flags and every op fell through to Puppeteer — the
  // extension did nothing at runtime. Now click/scroll prefer the portal and
  // fall back to Puppeteer on any failure.

  /** A plain CSS selector usable by the in-page portal, or null (fall back). */
  private portalSelector(el: KruzElement): string | null {
    // A queryAll handle identifies a particular match; target.css does not.
    if (el.handle.includes(".nth(")) return null;
    const h = el.handle;
    if (typeof h === "string" && !h.includes(".nth(") && !h.startsWith("::-p-")
      && !/:text\(|:has-text\(|>>/.test(h)) return h;
    return null;
  }

  private async portalCall(method: "click" | "scrollIntoView", sel: string): Promise<boolean> {
    try {
      const r = await this._puppeteer.evaluate(
        `(() => { try { const api = (window).__kruz__; if (!api || !api.${method}) return { ok: false, error: "no-api" }; return api.${method}(${JSON.stringify(sel)}); } catch (e) { return { ok: false, error: String(e) }; } })()`
      );
      this._portalReady = !!(r.ok && (r.result as any)?.ok);
      return this._portalReady;
    } catch { return false; }
  }
  async url() { return this._puppeteer.url(); }
  async title() { return this._puppeteer.title(); }
  async viewportSize() { return this._puppeteer.viewportSize(); }
  async setViewportSize(w: number, h: number) { return this._puppeteer.setViewportSize(w, h); }
  async bringToFront() { return this._puppeteer.bringToFront(); }
  async close() { return this._puppeteer.close(); }
  async content() { return this._puppeteer.content(); }

  async navigate(url: string, waitFor: string, timeoutMs: number) {
    await this._puppeteer.navigate(url, waitFor, timeoutMs);
    const ready = await this._puppeteer.evaluate('!!window.__kruz_extension_ready__');
    this._portalReady = ready.ok && ready.result === true;
  }
  async back() { return this._puppeteer.back(); }
  async forward() { return this._puppeteer.forward(); }
  async reload() { return this._puppeteer.reload(); }
  async waitForLoadState(state: string, timeoutMs: number) {
    return this._puppeteer.waitForLoadState(state, timeoutMs);
  }
  async waitFor(predicateJs: string, timeoutMs?: number, intervalMs?: number) {
    return this._puppeteer.waitFor(predicateJs, timeoutMs, intervalMs);
  }

  async newTab(url?: string) { return this._puppeteer.newTab(url); }
  async createIsolatedPage() { return this._puppeteer.createIsolatedPage(); }
  async listTabs() { return this._puppeteer.listTabs(); }
  async closeTab(tabId: string) { return this._puppeteer.closeTab(tabId); }
  async switchTab(tabId: string) { return this._puppeteer.switchTab(tabId); }

  async evaluate<T = unknown>(expression: string): Promise<EvalResult> {
    return this._puppeteer.evaluate<T>(expression);
  }
  async readVariable<T = unknown>(name: string): Promise<T | undefined> {
    return this._puppeteer.readVariable<T>(name);
  }

  async screenshot(opts: { fullPage?: boolean; path?: string }) {
    return this._puppeteer.screenshot(opts);
  }

  async frames() { return this._puppeteer.frames(); }
  async frameBy(name?: string, urlPattern?: string) {
    return this._puppeteer.frameBy(name, urlPattern);
  }
  async evaluateInFrame<T = unknown>(frameId: string, expression: string) {
    return this._puppeteer.evaluateInFrame<T>(frameId, expression);
  }

  async queryOne(target: Target, fallback?: Fallback, scope?: string, timeoutMs?: number) {
    return this._puppeteer.queryOne(target, fallback, scope, timeoutMs);
  }
  async queryAll(target: Target, fallback?: Fallback, scope?: string) {
    return this._puppeteer.queryAll(target, fallback, scope);
  }

  async click(el: KruzElement, opts?: { button?: "left" | "right" | "middle"; clickCount?: number; force?: boolean; timeoutMs?: number }) {
    // Use the same actionability checks and native-dialog lifecycle in both engines.
    return this._puppeteer.click(el, opts);
  }

  async dblclick(el: KruzElement, opts?: { timeoutMs?: number }) {
    return this._puppeteer.dblclick(el, opts);
  }
  async hover(el: KruzElement, opts?: { timeoutMs?: number; dwellMs?: number }) {
    return this._puppeteer.hover(el, opts);
  }
  async scrollIntoView(el: KruzElement, opts?: { timeoutMs?: number }) {
    const sel = this.portalSelector(el);
    if (sel && (await this.portalCall("scrollIntoView", sel))) return;
    return this._puppeteer.scrollIntoView(el, opts);
  }
  async boundingBox(el: KruzElement) { return this._puppeteer.boundingBox(el); }
  async isVisible(el: KruzElement) { return this._puppeteer.isVisible(el); }
  async isEnabled(el: KruzElement) { return this._puppeteer.isEnabled(el); }
  async isChecked(el: KruzElement) { return this._puppeteer.isChecked(el); }
  async innerText(el: KruzElement) { return this._puppeteer.innerText(el); }
  async textContent(el: KruzElement) { return this._puppeteer.textContent(el); }
  async attribute(el: KruzElement, name: string) {
    return this._puppeteer.attribute(el, name);
  }
  async evaluateOn<T = unknown>(el: KruzElement, expression: string): Promise<EvalResult> {
    return this._puppeteer.evaluateOn<T>(el, expression);
  }
  async tagName(el: KruzElement) { return this._puppeteer.tagName(el); }

  async fill(el: KruzElement, value: string, opts?: { force?: boolean; timeoutMs?: number }) {
    return this._puppeteer.fill(el, value, opts);
  }
  async type(el: KruzElement, text: string, opts?: { delayMs?: number; clear?: boolean; timeoutMs?: number }) {
    return this._puppeteer.type(el, text, opts);
  }
  async press(el: KruzElement | undefined, key: string, opts?: { timeoutMs?: number }) {
    return this._puppeteer.press(el, key, opts);
  }
  async selectOption(el: KruzElement, value: string | string[]) {
    return this._puppeteer.selectOption(el, value);
  }
  async check(el: KruzElement, opts?: { force?: boolean; timeoutMs?: number }) {
    return this._puppeteer.check(el, opts);
  }
  async uncheck(el: KruzElement, opts?: { force?: boolean; timeoutMs?: number }) {
    return this._puppeteer.uncheck(el, opts);
  }
  async setFiles(el: KruzElement, paths: string[]) {
    return this._puppeteer.setFiles(el, paths);
  }
  async submitForm(el?: KruzElement) { return this._puppeteer.submitForm(el); }
  async setSliderValue(el: KruzElement, value: number) {
    return this._puppeteer.setSliderValue(el, value);
  }

  async mouseClick(x: number, y: number, opts?: { button?: "left" | "right" | "middle"; clickCount?: number }) {
    return this._puppeteer.mouseClick(x, y, opts);
  }
  async mouseMove(x: number, y: number) { return this._puppeteer.mouseMove(x, y); }
  async mouseDown() { return this._puppeteer.mouseDown(); }
  async mouseUp() { return this._puppeteer.mouseUp(); }
  async keyboardPress(key: string) { return this._puppeteer.keyboardPress(key); }
  async keyboardType(text: string, opts?: { delayMs?: number }) {
    return this._puppeteer.keyboardType(text, opts);
  }

  async scrollPage(direction: "up" | "down" | "left" | "right", amount: number) {
    return this._puppeteer.scrollPage(direction, amount);
  }
  async scrollElement(el: KruzElement, direction: "up" | "down" | "left" | "right", amount: number) {
    return this._puppeteer.scrollElement(el, direction, amount);
  }
  async scrollToTop() { return this._puppeteer.scrollToTop(); }
  async scrollHeight() { return this._puppeteer.scrollHeight(); }
  async scrollY() { return this._puppeteer.scrollY(); }

  async waitForSelector(target: Target, opts: { state: "visible" | "hidden" | "attached"; timeoutMs: number }) {
    return this._puppeteer.waitForSelector(target, opts);
  }
  async waitMs(ms: number) { await sleep(ms); }
  async waitForNavigation(timeoutMs: number) { return this._puppeteer.waitForNavigation(timeoutMs); }
  async inputValue(el: KruzElement) { return this._puppeteer.inputValue(el); }
  async countElements(target: Target, scope?: string) { return this._puppeteer.countElements(target, scope); }
  async screenshotElement(el: KruzElement, opts?: { path?: string }) { return this._puppeteer.screenshotElement(el, opts); }
  async queryOneInFrame(frameId: string, target: Target, fallback?: Fallback) { return this._puppeteer.queryOneInFrame(frameId, target, fallback); }
  async queryAllInFrame(frameId: string, target: Target, fallback?: Fallback) { return this._puppeteer.queryAllInFrame(frameId, target, fallback); }
  async queryOneInScope(parent: KruzElement, target: Target, fallback?: Fallback, timeoutMs?: number) { return this._puppeteer.queryOneInScope(parent, target, fallback, timeoutMs); }
  async contextFetch(url: string, opts?: { method?: string; timeoutMs?: number }) { return this._puppeteer.contextFetch(url, opts); }
  onPageLoad(callback: () => void) { this._puppeteer.onPageLoad(callback); }

  async dragPointer(srcBox: { x: number; y: number }, dstBox: { x: number; y: number }) {
    return this._puppeteer.dragPointer(srcBox, dstBox);
  }
  async html5Drag(src: KruzElement, dst: KruzElement) {
    return this._puppeteer.html5Drag(src, dst);
  }

  async queryOnePiercing(target: Target, fallback?: Fallback, scope?: string) {
    return this._puppeteer.queryOnePiercing(target, fallback, scope);
  }
  async enableNetworkCapture(opts: { captureBodies?: boolean }) {
    return this._puppeteer.enableNetworkCapture(opts);
  }
  async disableNetworkCapture() { return this._puppeteer.disableNetworkCapture(); }
  drainNetworkEvents(): NetworkEvent[] { return this._puppeteer.drainNetworkEvents(); }
  getResponseBody(filter: string): NetworkEvent | null {
    return this._puppeteer.getResponseBody(filter);
  }

  async enableConsoleCapture() { return this._puppeteer.enableConsoleCapture(); }
  async disableConsoleCapture() { return this._puppeteer.disableConsoleCapture(); }
  drainConsoleEvents(): ConsoleEvent[] { return this._puppeteer.drainConsoleEvents(); }

  handleDialog(action: "accept" | "dismiss", promptText?: string) {
    return this._puppeteer.handleDialog(action, promptText);
  }
  nextDialog(): Promise<DialogEvent | null> { return this._puppeteer.nextDialog(); }
  setDialogPolicy(action: "accept" | "dismiss", value?: string) {
    this._puppeteer.setDialogPolicy(action, value);
  }

  hasCapability(name: EngineCapability): boolean {
    if (this._portalReady) {
      switch (name) {
        case "closed-shadow-pierce": return true;
        case "document-start-injection": return true;
        case "bot-detection-evasion": return true;
        case "iframe-crossorigin-eval": return true;
        case "request-modification": return true;
        case "native-input-os-level": return false;
      }
    }
    return this._puppeteer.hasCapability(name);
  }
}
