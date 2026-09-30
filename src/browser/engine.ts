/**
 * BrowserEngine — the abstraction layer that sits between Kruz's BrowserController
 * and the underlying automation driver. Replaces Playwright's `Page` and `Locator`
 * types with Kruz-native handles so the rest of the codebase doesn't have to know
 * which driver is underneath.
 *
 * The only implementation that ships is:
 *   1. PuppeteerEngine — uses puppeteer-core connected to a Chrome launched with
 *      `--remote-debugging-port`.
 *
 * The handle returned by `query*` is a `KruzElement`, NOT a Locator. Kruz
 * elements are stable across re-renders (resolved lazily on each action call),
 * so re-running `page.click(target)` after a SPA route change works without
 * the model having to re-observe.
 */

import type { Target, Fallback } from "../types/schema.js";

/** A reference to an element in the page DOM. Opaque to the controller. */
export interface KruzElement {
  /** Opaque engine-specific handle (CSS selector string, CDP nodeId, etc.) */
  readonly handle: string;
  /** Strategy used to resolve this element (for diagnostics). */
  readonly strategy: string;
  /** Original target the model supplied (for re-resolution). */
  readonly target: Target;
  /** Optional fallback chain. */
  readonly fallback?: Fallback;
  /** Optional scope selector. */
  readonly scope?: string;
  /** Resolution timestamp — used for cache invalidation. */
  readonly resolvedAt: number;
  /**
   * Pre-resolved live node, when the element was pinned in-page.
   *
   * When present it is authoritative: re-resolving by `handle` would re-run a
   * query and could land on a different node (or fail entirely inside a shadow
   * root). Carrying the node removes that whole class of drift.
   */
  readonly node?: unknown;
}

export interface KruzFrame {
  readonly id: string;
  readonly url: string;
  readonly name: string | null;
  readonly isMain: boolean;
}

/** Result of running JS in the page. */
export interface EvalResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Network request envelope (matches what controller exposes today). */
export interface NetworkEvent {
  url: string;
  method: string;
  status?: number;
  contentType?: string;
  body?: string;
  truncated?: boolean;
}

/** Page-side dialog (alert/confirm/prompt). */
export interface DialogEvent {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
}

/** Console message. */
export interface ConsoleEvent {
  type: string;
  text: string;
  location?: { url: string; lineNumber: number };
}

/**
 * The engine contract — every implementation must satisfy this. The controller
 * holds one `BrowserEngine` instance per session and never references a driver
 * library type directly.
 */
export interface BrowserEngine {
  /** Identity + diagnostics. */
  readonly kind: "puppeteer" | "cdp";
  readonly connected: boolean;

  /** Page-level. */
  url(): Promise<string>;
  title(): Promise<string>;
  viewportSize(): Promise<{ width: number; height: number }>;
  setViewportSize(w: number, h: number): Promise<void>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  content(): Promise<string>;

  /** Navigation. */
  navigate(url: string, waitFor: "load" | "domcontentloaded" | "networkidle" | "commit", timeoutMs: number): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", timeoutMs: number): Promise<void>;
  /** Poll-for-real-content wait: evaluate a JS predicate in-page every intervalMs until truthy or timeout (K30). */
  waitFor(predicateJs: string, timeoutMs?: number, intervalMs?: number): Promise<boolean>;
  /** Settled-aware wait (P0-A): returns early when the predicate is false but the page has stopped mutating. */
  waitForSettled(predicateJs: string, opts?: { timeoutMs?: number; intervalMs?: number; settleMs?: number; minWaitMs?: number }): Promise<{ met: boolean; settled: boolean; attempts: number; elapsedMs: number }>;

  /** Tab management. */
  newTab(url?: string): Promise<KruzTab>;
  /** Own a new page without changing the session's active page. Close with close(), never shutdown(). */
  createIsolatedPage(): Promise<BrowserEngine>;
  listTabs(): Promise<KruzTab[]>;
  closeTab(tabId: string): Promise<void>;
  switchTab(tabId: string): Promise<void>;

  /** Eval JS in the active page. */
  evaluate<T = unknown>(expression: string): Promise<EvalResult>;
  readVariable<T = unknown>(name: string): Promise<T | undefined>;

  /** Screenshots. */
  screenshot(opts: { fullPage?: boolean; path?: string }): Promise<Buffer>;

  /** Frames. */
  frames(): Promise<KruzFrame[]>;
  frameBy(name?: string, urlPattern?: string): Promise<KruzFrame | null>;
  evaluateInFrame<T = unknown>(frameId: string, expression: string): Promise<EvalResult>;

  /** Element queries (return opaque handles; resolve on action). */
  queryOne(target: Target, fallback?: Fallback, scope?: string, timeoutMs?: number): Promise<KruzElement | null>;
  queryAll(target: Target, fallback?: Fallback, scope?: string): Promise<KruzElement[]>;
  /**
   * Wrap the node the last `markScript` stashed on the page into a handle.
   *
   * An in-page `document.querySelector` cannot address a node inside an open
   * shadow root, so a selector-based handle is not enough for component-rendered
   * controls. Taking the live node object is the only route, and it also removes
   * any index/selector drift between "found it" and "act on it".
   */
  takeMarkedNode(fallbackCss: string, target: Target): Promise<KruzElement | null>;

  /** Element operations (resolve-on-call). */
  click(el: KruzElement, opts?: { button?: "left" | "right" | "middle"; clickCount?: number; force?: boolean; timeoutMs?: number; visual?: boolean; speed?: "instant" | "fast" | "normal" | "slow" }): Promise<void>;
  dblclick(el: KruzElement, opts?: { timeoutMs?: number }): Promise<void>;
  hover(el: KruzElement, opts?: { timeoutMs?: number; dwellMs?: number }): Promise<void>;
  /** Install the virtual cursor + control glow (idempotent, survives navigation). */
  installControlIndicator(opts?: { status?: string | null; glow?: boolean }): Promise<void>;
  /** Remove the visual control layer. */
  removeControlIndicator(): Promise<void>;
  /** Last known virtual-cursor position, or the viewport centre on first use. */
  virtualCursorPos(): Promise<{ x: number; y: number }>;
  scrollIntoView(el: KruzElement, opts?: { timeoutMs?: number }): Promise<void>;
  boundingBox(el: KruzElement): Promise<{ x: number; y: number; width: number; height: number } | null>;
  isVisible(el: KruzElement): Promise<boolean>;
  isEnabled(el: KruzElement): Promise<boolean>;
  isChecked(el: KruzElement): Promise<boolean>;
  innerText(el: KruzElement): Promise<string>;
  textContent(el: KruzElement): Promise<string>;
  attribute(el: KruzElement, name: string): Promise<string | null>;
  evaluateOn<T = unknown>(el: KruzElement, expression: string): Promise<EvalResult>;
  tagName(el: KruzElement): Promise<string>;

  /** Form interactions. */
  fill(el: KruzElement, value: string, opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  type(el: KruzElement, text: string, opts?: { delayMs?: number; clear?: boolean; timeoutMs?: number }): Promise<void>;
  press(el: KruzElement | undefined, key: string, opts?: { timeoutMs?: number }): Promise<void>;
  selectOption(el: KruzElement, value: string | string[]): Promise<void>;
  check(el: KruzElement, opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  uncheck(el: KruzElement, opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  setFiles(el: KruzElement, paths: string[]): Promise<void>;
  submitForm(el?: KruzElement): Promise<void>;
  setSliderValue(el: KruzElement, value: number): Promise<void>;

  /** Mouse / keyboard raw input (page-level). */
  mouseClick(x: number, y: number, opts?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  mouseDown(): Promise<void>;
  mouseUp(): Promise<void>;
  keyboardPress(key: string): Promise<void>;
  keyboardType(text: string, opts?: { delayMs?: number }): Promise<void>;

  /** Scroll helpers (page-level). */
  scrollPage(direction: "up" | "down" | "left" | "right", amount: number): Promise<void>;
  /** Scroll a scrollable container (the element itself or its nearest scrollable ancestor) by amount in direction. */
  scrollElement(el: KruzElement, direction: "up" | "down" | "left" | "right", amount: number): Promise<void>;
  scrollToTop(): Promise<void>;
  scrollHeight(): Promise<number>;
  scrollY(): Promise<number>;

  /** Wait helpers. */
  waitForSelector(target: Target, opts: { state: "visible" | "hidden" | "attached"; timeoutMs: number }): Promise<KruzElement | null>;
  waitMs(ms: number): Promise<void>;
  waitForNavigation(timeoutMs: number): Promise<void>;

  /** Form value reading. */
  inputValue(el: KruzElement): Promise<string>;

  /** Element counting. */
  countElements(target: Target, scope?: string): Promise<number>;

  /** Element-level screenshot. */
  screenshotElement(el: KruzElement, opts?: { path?: string }): Promise<Buffer>;

  /** Frame-scoped element queries. */
  queryOneInFrame(frameId: string, target: Target, fallback?: Fallback): Promise<KruzElement | null>;
  queryAllInFrame(frameId: string, target: Target, fallback?: Fallback): Promise<KruzElement[]>;

  /** Scope a query within a resolved parent element. */
  queryOneInScope(parent: KruzElement, target: Target, fallback?: Fallback, timeoutMs?: number): Promise<KruzElement | null>;

  /** HTTP fetch using browser context (inherits cookies, bypasses CORS). */
  contextFetch(url: string, opts?: { method?: string; timeoutMs?: number }): Promise<{ ok: boolean; status: number; headers: Record<string, string>; text: string }>;

  /** Page load event subscription. */
  onPageLoad(callback: () => void): void;

  /** Drag & drop. */
  dragPointer(srcBox: { x: number; y: number }, dstBox: { x: number; y: number }): Promise<void>;
  html5Drag(src: KruzElement, dst: KruzElement): Promise<void>;

  /** Shadow DOM piercing (engine-level capability). */
  queryOnePiercing(target: Target, fallback?: Fallback, scope?: string): Promise<KruzElement | null>;

  /** Network capture. */
  enableNetworkCapture(opts: { captureBodies?: boolean }): Promise<void>;
  disableNetworkCapture(): Promise<void>;
  drainNetworkEvents(): NetworkEvent[];
  getResponseBody(filter: string): NetworkEvent | null;

  /** Console capture. */
  drainConsoleEvents(): ConsoleEvent[];
  enableConsoleCapture(): Promise<void>;
  disableConsoleCapture(): Promise<void>;

  /** Dialog. */
  handleDialog(action: "accept" | "dismiss", promptText?: string): Promise<void>;
  nextDialog(): Promise<DialogEvent | null>;
  setDialogPolicy(action: "accept" | "dismiss", value?: string): void;

  /** Engine-specific: check whether the underlying driver supports a capability. */
  hasCapability(name: EngineCapability): boolean;
}

export type EngineCapability =
  | "closed-shadow-pierce"
  | "document-start-injection"
  | "bot-detection-evasion"
  | "native-input-os-level"
  | "iframe-crossorigin-eval"
  | "request-modification";

/** Tab handle returned by newTab/listTabs. */
export interface KruzTab {
  id: string;
  url: string;
  title: string;
  isActive: boolean;
  openerId?: string;
}
