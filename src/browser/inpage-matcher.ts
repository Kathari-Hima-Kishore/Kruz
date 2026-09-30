/**
 * inpage-matcher — THE single source of element identity.
 *
 * Every consumer of "which element does this target mean?" goes through the
 * matcher below: `page.probe`, `page.click`, `page.fill`, `page.select`,
 * `page.check/uncheck`, `page.scroll`, and overlay discovery. That is the whole
 * point of this module — the reported defects all came from there being several
 * independent matchers with different semantics (probe understood only `css`
 * and `text`; the engine understood `::-p-aria()` and `[placeholder*=]`; the
 * overlay scanner understood a private list of class-name tokens). A ref
 * produced by one of them was meaningless to the others.
 *
 * The matcher runs INSIDE the page as a single evaluate, so probe and the
 * action path execute byte-identical matching code. Parity is structural, not
 * maintained by hand.
 *
 * It also separates the states an agent must be able to tell apart:
 *
 *     exists   the node is in the document
 *     visible  it is rendered (non-zero box, not display:none / visibility:hidden)
 *     enabled  it is not disabled / aria-disabled
 *     inViewport  it currently intersects the viewport
 *     actionable  it could be interacted with right now
 *
 * `page.probe` reports all of them, and actions require the one their mode
 * needs. That is what turns Bug 2 ("probe sees it, click says TARGET_NOT_FOUND")
 * into a truthful, actionable answer instead of a guess.
 */

import type { BrowserEngine, EvalResult } from "./engine.js";
import type { Target, Fallback } from "../types/schema.js";
import { MATCHER_SRC, matcherCall } from "./inpage-scripts.js";

/** Attribute used to hand a resolved node to the engine's handle layer. */
export const MARK_ATTR = "data-kruz-pick";

/** Attribute used to identify a node across the act of clicking it. */
export const EFFECT_ATTR = "data-kruz-fx";

/** What a consumer requires of a match. Mirrors Puppeteer Locator semantics. */
export type MatchMode = "query" | "clickable" | "fillable";

export interface MatchSpec {
  css?: string | null;
  role?: string | null;
  name?: string | null;
  label?: string | null;
  placeholder?: string | null;
  text?: string | null;
  testid?: string | null;
  nameAttr?: string | null;
  id?: string | null;
  /**
   * Canonical destination match: the absolute URL the link must RESOLVE to.
   *
   * Matching on `a[href="…"]` cannot express this, because the attribute may be
   * relative (`3.13.html`) while the identity is absolute
   * (`https://site/dir/3.13.html`). Resolution happens in-page against
   * `document.baseURI`, so relative, root-relative, `../`, fragment, query and
   * `<base href>` forms all compare correctly.
   */
  resolvedHref?: string | null;
  /** CSS scope; the match must be inside it. */
  scope?: string | null;
  /** Which target field produced the primary strategy (for diagnostics). */
  strategy?: string;
}

export interface MatchDescriptor {
  /** Ordinal within this match run. Stable only for the same matcher + spec. */
  i: number;
  /** Shadow-piercing CSS path back to the node (Tier-1 identity). */
  path: string;
  tag: string;
  role: string;
  name: string;
  /** Which rule produced `name` — 'aria-label' | 'label' | 'placeholder' | 'text' | 'title'. */
  name_source: string;
  /** Resolved absolute URL (`el.href`) — the canonical destination. */
  href: string | null;
  /** The raw `href` attribute exactly as authored ("3.13.html"), for diagnostics. */
  raw_href?: string | null;
  placeholder: string | null;
  type: string | null;
  name_attr: string | null;
  testid: string | null;
  value: string | null;
  checked: boolean | null;
  visible: boolean;
  enabled: boolean;
  in_viewport: boolean;
  editable: boolean;
  actionable: boolean;
  /** Why the node is not actionable, for the model. */
  blocked_reason: string | null;
  /** Nearest dialog/banner/overlay container signature — used to verify dismissal. */
  container: string | null;
  rect: { x: number; y: number; w: number; h: number } | null;
  context: string | null;
}

export interface MatchResult {
  count: number;
  actionable_count: number;
  matches: MatchDescriptor[];
  /** Set when the cap hid matches. */
  truncated?: boolean;
  total?: number;
  strategy?: string;
  error?: string;
}

// The matcher program itself lives in inpage-scripts.ts as explicit source
// (a serialised TS function breaks under transpilers that inject keepNames helpers).

/** Build the canonical match spec from a Target, using the documented precedence. */
export function specFromTarget(target: Target, fallback?: Fallback, scope?: string): MatchSpec {
  const s: MatchSpec = { scope: scope ?? null };
  if (target.css) { s.css = target.css; s.strategy = "css"; return s; }
  if (target.role) { s.role = target.role; s.name = target.name ?? null; s.strategy = target.name ? "role+name" : "role"; return s; }
  if (target.label) { s.label = target.label; s.strategy = "label"; return s; }
  if (target.placeholder) { s.placeholder = target.placeholder; s.strategy = "placeholder"; return s; }
  if (target.text) { s.text = target.text; s.strategy = "text"; return s; }
  if (target.testid) { s.testid = target.testid; s.strategy = "testid"; return s; }
  if (target.nameAttr) { s.nameAttr = target.nameAttr; s.strategy = "nameAttr"; return s; }
  if (target.id) { s.id = target.id; s.strategy = "id"; return s; }
  if (fallback?.css) { s.css = fallback.css; s.strategy = "fallback.css"; return s; }
  if (fallback?.text) { s.text = fallback.text; s.strategy = "fallback.text"; return s; }
  s.strategy = "none";
  return s;
}

/** Run the matcher against the current DOM. Never waits — this is current state. */
export async function runMatch(engine: BrowserEngine, spec: MatchSpec, limit = 50): Promise<MatchResult> {
  const r: EvalResult = await engine.evaluate(matcherCall(spec, limit)).catch(() => ({ ok: false as const, error: "evaluate failed" }));
  if (!r.ok || !r.result || typeof r.result !== "object") {
    return { count: 0, actionable_count: 0, matches: [], strategy: spec.strategy, error: r.error ?? "matcher failed" };
  }
  return r.result as MatchResult;
}

/**
 * Mark the match at `ordinal` with a unique token and return the selector that
 * addresses exactly that node.
 *
 * The mark is the hand-off between "this is the element" and the engine's handle
 * layer. Re-resolving by an in-page mark (rather than carrying a CSS path or an
 * index across a render) is what makes the identity survive a re-render: if the
 * node was replaced, the re-run of the same matcher simply marks the new node at
 * the same ordinal, and the caller re-verifies its fingerprint before acting.
 */
/**
 * Mark the match at `ordinal` and hand the exact node to the engine.
 *
 * The matcher returns the live nodes alongside their descriptors, so the mark
 * lands on precisely the element that was described — no index is carried
 * across a re-render, and no CSS path has to be re-parsed (a path cannot address
 * a node inside a shadow root at all). The node is also stashed on the window so
 * the engine can wrap it in a real handle, which is the only way to drive a
 * shadow-DOM element through CDP.
 */
export function markScript(spec: MatchSpec, ordinal: number, token: string): string {
  return `(() => { try {
    const res = ${matcherCall(spec, Math.max(ordinal + 1, 50), true)};
    const m = res.matches && res.matches[${ordinal}];
    if (!m) return { ok: false, reason: 'no-match' };
    // The matcher stashed the live nodes on the window (they cannot cross the
    // CDP boundary). Taking THAT node is what lets a control inside an open
    // shadow root be reached, and it removes any index drift between "found it"
    // and "act on it".
    const list = (window).__kruzMatchNodes || [];
    const node = list[${ordinal}];
    if (!node) return { ok: false, reason: 'unmarkable' };
    try { window.__kruzMarkedNode = node; } catch (e) { }
    // Clear stale marks across open shadow roots too, so a mark left inside a
    // web component cannot be re-read as this action's postcondition.
    const clearOld = (root) => {
      root.querySelectorAll('[${EFFECT_ATTR}]').forEach(n => n.removeAttribute('${EFFECT_ATTR}'));
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) clearOld(el.shadowRoot); });
    };
    try { clearOld(document); } catch (e) { }
    node.setAttribute('${EFFECT_ATTR}', ${JSON.stringify(token)});
    return { ok: true, reason: 'marked', fingerprint: { role: m.role, name: m.name, href: m.href, tag: m.tag, container: m.container } };
  } catch (e) { return { ok: false, reason: String(e) }; } })()`;
}

/** Selector that addresses the node carrying `token`. */
export function markSelector(token: string): string {
  return `[${EFFECT_ATTR}="${token.replace(/"/g, '\\"')}"]`;
}

/** Remove every live mark, including marks inside open shadow roots. */
export function clearMarksScript(): string {
  return `(() => { try {
    const strip = (root) => {
      root.querySelectorAll('[${MARK_ATTR}],[${EFFECT_ATTR}]').forEach(n => { n.removeAttribute('${MARK_ATTR}'); n.removeAttribute('${EFFECT_ATTR}'); });
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) strip(el.shadowRoot); });
    };
    strip(document);
    return true;
  } catch (e) { return false; } })()`;
}

/**
 * Read the effect of an action on the node that was acted on: is it still
 * connected, still rendered, and is its overlay container still present?
 * This is the generic postcondition that Bug 6 was missing — a click that
 * removes the thing it clicked is an observable effect, even with no navigation
 * and no text change in the first 2000 characters of the body.
 */
export function effectScript(token: string): string {
  const sel = `[${EFFECT_ATTR}="${token.replace(/"/g, '\\"')}"]`;
  return `(() => {
    // The marked node can live inside an OPEN shadow root (a web-component search
    // box, a custom select). A plain document.querySelector cannot see it, so the
    // postcondition read reported present:false and every action on a component
    // control was reported STALE_REFERENCE even though the click/fill had landed.
    // Walk open roots before concluding the node is gone.
    const deep = (s) => {
      try { const n = document.querySelector(s); if (n) return n; } catch (e) { }
      const visit = (root) => {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (!el.shadowRoot) continue;
          try { const hit = el.shadowRoot.querySelector(s); if (hit) return hit; } catch (e) { }
          const deeper = visit(el.shadowRoot);
          if (deeper) return deeper;
        }
        return null;
      };
      return visit(document);
    };
    const node = deep(${JSON.stringify(sel)});
    if (!node) return { present: false, visible: false, container: null };
    const r = node.getBoundingClientRect();
    const s = getComputedStyle(node);
    const container = node.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i], [class*="banner" i], [id*="banner" i], [class*="notice" i], [class*="popup" i], [class*="modal" i]');
    let containerVisible = null;
    if (container) {
      const cr = container.getBoundingClientRect();
      const cs = getComputedStyle(container);
      containerVisible = cr.width > 0 && cr.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    }
    return {
      present: true,
      visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
      enabled: (node.disabled !== true) && node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('disabled'),
      editable: (node instanceof HTMLInputElement) ? (node.type !== 'hidden' && !node.disabled && !node.readOnly)
        : (node instanceof HTMLTextAreaElement) ? (!node.disabled && !node.readOnly)
        : (node instanceof HTMLSelectElement) ? !node.disabled
        : node.isContentEditable === true,
      checked: (node instanceof HTMLInputElement) ? node.checked : null,
      aria_checked: node.getAttribute('aria-checked'),
      aria_expanded: node.getAttribute('aria-expanded'),
      aria_pressed: node.getAttribute('aria-pressed'),
      value: (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) ? node.value : null,
      container: container ? (container.id ? '#' + container.id : container.tagName.toLowerCase()) : null,
      container_visible: containerVisible,
    };
  })()`;
}

export interface ElementEffect {
  present: boolean;
  visible: boolean;
  enabled?: boolean;
  editable?: boolean;
  container?: string | null;
  container_visible?: boolean | null;
  checked?: boolean | null;
  aria_checked?: string | null;
  aria_expanded?: string | null;
  aria_pressed?: string | null;
  value?: string | null;
}

/** Read the post-action effect of the marked node. */
export async function readEffect(engine: BrowserEngine, token: string): Promise<ElementEffect> {
  const r = await engine.evaluate(effectScript(token)).catch(() => null);
  if (!r?.ok || !r.result) return { present: false, visible: false };
  return r.result as ElementEffect;
}
