/**
 * ref-registry — the ref contract.
 *
 * A ref handed to the model is a PROMISE: "you may act on this". Bugs 1, 2 and 3
 * in the manual report were all breaches of that promise, and the cause was
 * structural rather than incidental:
 *
 *   page.observe   minted `e<n>` refs into the Observer's private refMap  ✓
 *   page.probe     minted `c<n>` refs inside a throwaway in-page evaluate ✗
 *   page.click     read only the Observer's private refMap                ✗
 *
 * So probe advertised handles that no action could ever resolve, and the model
 * had to rediscover the same element by CSS — which is exactly what the closed
 * loop is supposed to prevent.
 *
 * This module is the single mint/resolve authority:
 *
 *   mint()   observe, probe and ambiguity candidates all register here
 *   resolve() click, fill, select, check, uncheck and scroll all read here
 *
 * "Single" is the load-bearing word, and it means ONE INSTANCE per session.
 * The class used to be instantiated twice per session — once by the Observer and
 * once by the SessionManager — so `page.observe` minted its `e<n>` refs into the
 * Observer's copy while every action resolved against the session's copy, and
 * every ref `page.observe` returned came back as UNKNOWN_REFERENCE. Two
 * instances also meant two independent counters, so the same public id could name
 * two different nodes depending on which producer issued it. There is now exactly
 * one allocator per session; `tests/integration/observe-ref-contract.test.ts`
 * guards both the wiring and the end-to-end behaviour.
 *
 * Resolution is a three-tier ladder, and it never degrades into "act on whatever
 * happens to be first":
 *
 *   Tier 1  the exact live node, re-identified by its recorded path AND verified
 *           against its recorded fingerprint (path-only hits are positional and
 *           can silently rebind to a stranger after a re-render)
 *   Tier 2  exact semantic identity (css / role+name / placeholder / href) that
 *           resolves to exactly one node
 *   Tier 3  bounded re-resolution inside the original match set, which must also
 *           resolve to exactly one node
 *
 * Anything less is a structured failure with the true reason — STALE_REFERENCE,
 * DOCUMENT_CHANGED, AMBIGUOUS_TARGET — never a silent wrong-element action.
 */

import type { BrowserEngine, KruzElement } from "./engine.js";
import type { Target } from "../types/schema.js";
import {
  runMatch, markScript, markSelector, clearMarksScript, readEffect,
  specFromTarget, type MatchDescriptor, type MatchSpec, type ElementEffect, type MatchMode,
} from "./inpage-matcher.js";
import { ErrCode, kruzError, type KruzError } from "../errors.js";

/** Where a ref came from — kept for diagnostics, never for behaviour. */
export type RefProducer = "observe" | "probe" | "ambiguity" | "hint";

export interface RefEntry {
  ref: string;
  producer: RefProducer;
  /** Tab the ref was minted in. */
  pageId: string;
  /** Document identity (performance.timeOrigin): guards against cross-document reuse. */
  documentId: string;
  /** Frame identity; the main document is "main". */
  frameId: string;
  /** Tier-1 identity: shadow-piercing CSS path recorded at mint time. */
  path: string;
  /** Semantic fingerprint — Tier 2/3 identity and the tie-breaker for Tier 1. */
  role: string;
  name: string;
  tag: string;
  /** Canonical destination: the RESOLVED absolute URL (`el.href`). */
  href: string | null;
  /** The raw attribute as authored ("3.13.html"), when the producer captured it. */
  rawHref: string | null;
  placeholder: string | null;
  type: string | null;
  nameAttr: string | null;
  testid: string | null;
  /** Container signature, so a dismissal can be verified against its overlay root. */
  container: string | null;
  /** Actionability as observed at mint time (what the model was told). */
  observed: { visible: boolean; enabled: boolean; inViewport: boolean; editable: boolean; actionable: boolean };
  /** The exact spec that produced this match, so it can be re-resolved. */
  spec: MatchSpec;
  /** Scope the match was taken under, if any. */
  scope?: string;
  /** Observation revision the ref was minted at. */
  revision: number;
}

export type ResolveOutcome =
  | { kind: "ok"; el: KruzElement; entry: RefEntry; tier: 1 | 2 | 3; token: string }
  | { kind: "fail"; error: KruzError; evidence: Record<string, unknown> };

/** Per-session registry. One instance per active browser session. */
export class RefRegistry {
  private entries = new Map<string, RefEntry>();
  private counters = { e: 0, c: 0, x: 0 };
  private mintToken = 0;

  /**
   * Cap on simultaneously-live refs.
   *
   * Refs are minted per observation — a `full` observe on a dense page is ~2000
   * — and a re-render mints a fresh set every time. Without a bound, a long
   * session grew this map without limit (measured: 1440 entries after 12
   * re-renders in ONE document, +400 per navigation), which is a slow memory
   * leak and makes the `known_refs` diagnostic meaningless.
   *
   * Eviction is oldest-first, so the most recent observation — the one the
   * model is actually acting from — is never the thing that disappears. An
   * evicted ref resolves to `UNKNOWN_REFERENCE`, which is the honest answer:
   * it was minted many observations ago and is no longer offered.
   */
  private static readonly MAX_ENTRIES = 6000;

  nextRef(prefix: "e" | "c" | "x"): string {
    this.counters[prefix] += 1;
    return `${prefix}${this.counters[prefix]}`;
  }

  get(ref: string): RefEntry | undefined { return this.entries.get(ref); }
  has(ref: string): boolean { return this.entries.has(ref); }
  size(): number { return this.entries.size; }

  /** Number of live refs. Exposed so tests can assert the registry stays bounded. */
  stats(): { entries: number; counters: { e: number; c: number; x: number } } {
    return { entries: this.entries.size, counters: { ...this.counters } };
  }

  /** Register a matcher descriptor as an actionable ref. */
  mint(
    producer: RefProducer,
    d: MatchDescriptor,
    ctx: { pageId: string; documentId: string; frameId?: string; spec: MatchSpec; scope?: string; revision: number },
  ): RefEntry {
    const prefix = producer === "probe" ? "c" : producer === "hint" ? "x" : "e";
    const ref = this.nextRef(prefix);
    const entry: RefEntry = {
      ref,
      producer,
      pageId: ctx.pageId,
      documentId: ctx.documentId,
      frameId: ctx.frameId ?? "main",
      path: d.path,
      role: d.role,
      name: d.name,
      tag: d.tag,
      href: d.href ?? null,
      rawHref: d.raw_href ?? null,
      placeholder: d.placeholder ?? null,
      type: d.type ?? null,
      nameAttr: d.name_attr ?? null,
      testid: d.testid ?? null,
      container: d.container ?? null,
      observed: {
        visible: d.visible,
        enabled: d.enabled,
        inViewport: d.in_viewport,
        editable: d.editable,
        actionable: d.actionable,
      },
      spec: ctx.spec,
      scope: ctx.scope,
      revision: ctx.revision,
    };
    this.entries.set(ref, entry);
    this.evictIfNeeded();
    return entry;
  }

  /**
   * Keep the map bounded, dropping the OLDEST entries.
   *
   * `Map` preserves insertion order, so the first keys are the oldest refs.
   * Counters are deliberately NOT reset: a ref id must never be reused for a
   * different node inside a live document, or a stale id would silently rebind
   * to a stranger. That is the exact failure the whole ladder exists to
   * prevent, and it is why eviction (which yields UNKNOWN_REFERENCE) is the
   * correct trade rather than recycling ids.
   */
  private evictIfNeeded(): void {
    const over = this.entries.size - RefRegistry.MAX_ENTRIES;
    if (over <= 0) return;
    let dropped = 0;
    for (const ref of this.entries.keys()) {
      if (dropped >= over) break;
      this.entries.delete(ref);
      dropped++;
    }
  }

  /**
   * Drop every ref that belonged to a different page or document.
   *
   * A ref is only meaningful inside the document that minted it: CDP node ids
   * and captured paths have no meaning across a navigation, so silently
   * re-resolving one against the new document could land on a stranger. This is
   * what turns a post-navigation ref use into DOCUMENT_CHANGED instead of an
   * accidental click.
   */
  invalidateForeign(pageId: string, documentId: string): string[] {
    const dropped: string[] = [];
    for (const [ref, e] of this.entries) {
      if (e.pageId !== pageId || e.documentId !== documentId) { this.entries.delete(ref); dropped.push(ref); }
    }
    // Refs are document-scoped: once every foreign ref is gone, NOTHING that the
    // counters previously issued can still resolve, so the id space can start
    // over in the new document. Without this, ids kept climbing across
    // navigations (e1…e400, then e401…e800, …) purely because the counter was
    // never reset, and a long session ran into 5-digit refs for no reason.
    //
    // Recycling is safe HERE and only here, because the map was just emptied of
    // the old document: no live ref can collide with a reused id.
    if (dropped.length > 0 && this.entries.size === 0) this.resetCounters();
    return dropped;
  }

  private resetCounters(): void { this.counters = { e: 0, c: 0, x: 0 }; }

  clear(): void { this.entries.clear(); this.resetCounters(); }

  newToken(): string { return `t${(++this.mintToken).toString(36)}${Date.now().toString(36)}`; }

  // ── resolution ────────────────────────────────────────────────────────────

  /**
   * Resolve a ref to a live, actionable element handle.
   *
   * `mode` is the actionability bar the caller needs (a click needs a rendered,
   * enabled node; a fill additionally needs an editable one). Identity is always
   * resolved the same way — only the acceptance test differs.
   */
  async resolve(
    engine: BrowserEngine,
    ref: string,
    mode: MatchMode,
    ctx: { pageId: string; documentId: string; revision: number; allowHidden?: boolean },
  ): Promise<ResolveOutcome> {
    const entry = this.entries.get(ref);
    if (!entry) {
      return {
        kind: "fail",
        // An unknown ref is a malformed input, not a transient browser state:
        // replaying it can never succeed, so it must not invite a retry loop.
        error: kruzError(ErrCode.UNKNOWN_REFERENCE, {
          subsystem: "selector",
          retryable: false,
          // Deliberately not claiming "never minted": a ref can also have been
          // evicted once the session holds more than MAX_ENTRIES live refs, and
          // the model needs to know it must re-observe rather than hunt for a
          // typo in the id.
          message: `Unknown reference '${ref}'. It is not currently valid: it was never minted, was invalidated by a navigation, or has been retired as one of the oldest refs (this session keeps the ${RefRegistry.MAX_ENTRIES} most recent).`,
          help: "Re-observe (page.observe) or re-probe to mint a fresh ref, then use the new ref.",
        }),
        evidence: { ref, known_refs: this.recentRefs() },
      };
    }

    if (entry.pageId !== ctx.pageId || entry.documentId !== ctx.documentId) {
      return {
        kind: "fail",
        error: kruzError(ErrCode.DOCUMENT_CHANGED, {
          subsystem: "selector",
          retryable: false,
          message: `Reference '${ref}' belongs to a different document than the one now open (the page navigated or was replaced).`,
          help: "Re-observe or re-probe in the current document to get refs that are valid here.",
        }),
        evidence: { ref, ref_document: entry.documentId, current_document: ctx.documentId },
      };
    }

    // Tier 1 — the exact live node, verified by fingerprint.
    const tier1 = await this.resolveByPath(engine, entry);
    if (tier1 && tier1 !== "miss" && tier1 !== "document-changed") {
      return this.finish(engine, entry, tier1.el, 1, mode, ctx.allowHidden === true, tier1.token);
    }
    if (tier1 === "document-changed") {
      return {
        kind: "fail",
        error: kruzError(ErrCode.DOCUMENT_CHANGED, {
          subsystem: "selector", retryable: false,
          message: `Reference '${ref}' lost its document while being resolved.`,
        }),
        evidence: { ref },
      };
    }

    // Tier 2 — exact semantic identity, must be unique.
    const spec2 = identitySpec(entry);
    if (spec2) {
      const m = await runMatch(engine, spec2, 12);
      const hits = m.matches;
      if (hits.length === 1) {
        const picked = await this.markAndHandle(engine, spec2, 0, entry, hits[0]);
        if (picked) return this.finish(engine, entry, picked.el, 2, mode, ctx.allowHidden === true, picked.token);
      } else if (hits.length > 1) {
        const usable = hits.filter((h) => acceptable(h, mode, ctx.allowHidden === true));
        if (usable.length === 1) {
          const ordinal = hits.indexOf(usable[0]);
          const picked = await this.markAndHandle(engine, spec2, ordinal, entry, usable[0]);
          if (picked) return this.finish(engine, entry, picked.el, 2, mode, ctx.allowHidden === true, picked.token);
        }
        return await this.ambiguity(engine, entry, usable.length, hits, spec2);
      }
    }

    // Tier 3 — bounded re-resolution inside the original match set.
    const spec3 = { ...entry.spec, scope: entry.scope ?? null };
    const m3 = await runMatch(engine, spec3, 24);
    const narrowed = m3.matches.filter((h) => sameLogicalElement(h, entry));
    if (narrowed.length === 1) {
      const ordinal = m3.matches.indexOf(narrowed[0]);
      const picked = await this.markAndHandle(engine, spec3, ordinal, entry, narrowed[0]);
      if (picked) return this.finish(engine, entry, picked.el, 3, mode, ctx.allowHidden === true, picked.token);
    }
    if (narrowed.length > 1) return await this.ambiguity(engine, entry, narrowed.length, narrowed, spec3, entry.scope);

    // The node is gone and nothing provably identical replaced it.
    const code = m3.count > 0 ? ErrCode.TARGET_NOT_ACTIONABLE : ErrCode.STALE_REFERENCE;
    return {
      kind: "fail",
      error: kruzError(code, {
        subsystem: "selector",
        // We have already exhausted the safe re-resolution ladder internally, so
        // replaying the identical ref cannot succeed. Retryability must say so.
        retryable: false,
        message: m3.count > 0
          ? `Reference '${ref}' no longer resolves to an actionable element (${m3.count} match(es) for the original target, none identical to the observed one).`
          : `Reference '${ref}' is stale: the element it identified no longer exists in this document.`,
        help: m3.count > 0
          ? "Re-probe the target to see what is there now, or pass a more specific selector."
          : "The element is gone. Re-probe or re-observe to mint a fresh ref.",
      }),
      evidence: {
        ref,
        tier1: tier1,
        original_target: describeEntry(entry),
        current_matches: m3.count,
        current_actionable: m3.actionable_count,
      },
    };
  }

  private async ambiguity(
    engine: BrowserEngine,
    entry: RefEntry,
    actionableCount: number,
    hits: MatchDescriptor[],
    spec: MatchSpec,
    scope?: string,
  ): Promise<ResolveOutcome> {
    // Each candidate is minted as a REAL ref. The help text tells the caller to
    // act on "its fresh ref", so returning a list without refs would advertise a
    // recovery the caller cannot actually take — the same class of broken
    // promise as an unusable observe ref.
    const candidates = hits.slice(0, 6).map((h) => {
      const minted = this.mint("ambiguity", h, {
        pageId: entry.pageId,
        documentId: entry.documentId,
        frameId: entry.frameId,
        spec,
        scope,
        revision: entry.revision,
      });
      return {
        ref: minted.ref,
        role: h.role,
        name: h.name,
        href: h.href,
        actionable: h.actionable,
        blocked_reason: h.blocked_reason,
      };
    });
    return {
      kind: "fail",
      error: kruzError(ErrCode.AMBIGUOUS_TARGET, {
        subsystem: "selector",
        retryable: false,
        message: `Reference '${entry.ref}' re-resolved to ${actionableCount} candidate(s) and Kruz will not guess between them.`,
        help: "Act on one of the returned candidate refs, or narrow the target with a scope or a more specific selector.",
      }),
      evidence: { ref: entry.ref, count: hits.length, candidates },
    };
  }

  /** Tier 1: resolve the recorded path, but only accept it if the identity holds. */
  private async resolveByPath(engine: BrowserEngine, entry: RefEntry): Promise<{ el: KruzElement; token: string } | "miss" | "document-changed"> {
    if (!entry.path) return "miss";
    const spec: MatchSpec = { css: entry.path, scope: null };
    const m = await runMatch(engine, spec, 4);
    if (m.matches.length === 0) return "miss";
    // A path that resolves to a DIFFERENT element is a positional artefact of a
    // re-render. Treat it as a miss so Tier 2/3 can recover by identity.
    const hit = m.matches.find((h) => sameLogicalElement(h, entry));
    if (!hit) return "miss";
    return (await this.markAndHandle(engine, spec, m.matches.indexOf(hit), entry, hit)) ?? "miss";
  }

  /**
   * Mark the chosen match in-page and return a handle addressed by that mark.
   *
   * Re-running the matcher to place the mark (rather than trusting a selector
   * built earlier) is what makes the hand-off safe across a render between
   * resolution and dispatch: the mark lands on whatever the matcher just
   * described, and the fingerprint is re-checked before it is trusted.
   */
  private async markAndHandle(
    engine: BrowserEngine,
    spec: MatchSpec,
    ordinal: number,
    entry: RefEntry,
    expected: MatchDescriptor,
  ): Promise<{ el: KruzElement; token: string } | null> {
    const token = this.newToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const marked = await engine.evaluate(markScript(spec, ordinal, token)).catch(() => null);
      if (!marked?.ok) continue;
      const fp = (marked.result as any)?.fingerprint;
      if (fp && !fingerprintAgrees(fp, entry)) {
        // The matcher returned a different element at that ordinal (the DOM
        // moved between describe and mark). One bounded retry, then give up
        // rather than act on a stranger.
        continue;
      }
      const el = await engine.takeMarkedNode(markSelector(token), { css: spec.css ?? "" }).catch(() => null);
      if (el) return { el, token };
    }
    return null;
  }

  /**
   * Apply the actionability bar to the node that was actually pinned.
   *
   * The state is read from the mark itself rather than by re-running the
   * ORIGINAL target. That distinction matters: after a React re-render the
   * original selector often no longer matches anything (the id changed, the
   * list re-ordered), and re-deriving from it would report a perfectly good,
   * correctly re-resolved control as stale.
   */
  private async finish(
    engine: BrowserEngine,
    entry: RefEntry,
    el: KruzElement,
    tier: 1 | 2 | 3,
    mode: MatchMode,
    allowHidden: boolean,
    token: string,
  ): Promise<ResolveOutcome> {
    const state = await readEffect(engine, token);

    if (!state.present) {
      return {
        kind: "fail",
        error: kruzError(ErrCode.STALE_REFERENCE, {
          subsystem: "selector", retryable: false,
          message: `Reference '${entry.ref}' was re-resolved to a node that was immediately replaced (tier ${tier}).`,
        }),
        evidence: { ref: entry.ref, tier },
      };
    }
    if (!state.visible && !allowHidden) {
      return {
        kind: "fail",
        error: kruzError(ErrCode.ELEMENT_NOT_VISIBLE, {
          subsystem: "selector",
          retryable: true,
          message: `Reference '${entry.ref}' resolves to an element that exists in the DOM but is not rendered (<${entry.tag}>${entry.name ? ` "${entry.name}"` : ""}): display:none, visibility:hidden, a hidden ancestor, or zero size.`,
          help: "It is present but hidden. Reveal it (scroll, expand the section, open the tab), or pass ignore_visibility:true to act on it anyway.",
        }),
        evidence: { ref: entry.ref, tier, matched_original: entry.spec.strategy },
      };
    }
    if (mode !== "query" && state.enabled === false && !allowHidden) {
      return {
        kind: "fail",
        error: kruzError(ErrCode.ELEMENT_DISABLED, {
          subsystem: "selector", retryable: true,
          message: `Reference '${entry.ref}' resolves to a disabled control (<${entry.tag}>${entry.name ? ` "${entry.name}"` : ""}).`,
        }),
        evidence: { ref: entry.ref, tier },
      };
    }
    if (mode === "fillable" && state.editable === false && !allowHidden) {
      return {
        kind: "fail",
        error: kruzError(ErrCode.ELEMENT_NOT_EDITABLE, {
          subsystem: "selector", retryable: false,
          message: `Reference '${entry.ref}' resolves to a <${entry.tag}>, which is not an editable field.`,
          help: "Target the input/textarea/contenteditable itself, not a wrapper.",
        }),
        evidence: { ref: entry.ref, tier },
      };
    }

    // The element carries `token` from the mark step, so post-action
    // verification can ask what happened to THIS node instead of inferring it
    // from a body-text diff (that inference is what made Bug 6 report a
    // successful cookie dismissal as unverified).
    return { kind: "ok", el, entry, tier, token };
  }

  /** Read what happened to the element an action was performed on. */
  effect(token: string | undefined, engine: BrowserEngine): Promise<ElementEffect> {
    if (!token) return Promise.resolve({ present: false, visible: false });
    return readEffect(engine, token);
  }

  async clearMarks(engine: BrowserEngine): Promise<void> {
    await engine.evaluate(clearMarksScript()).catch(() => null);
  }

  private recentRefs(): string[] {
    return Array.from(this.entries.keys()).slice(0, 20);
  }
}

// ── module-level helpers ─────────────────────────────────────────────────────

function acceptable(d: MatchDescriptor, mode: MatchMode, allowHidden: boolean): boolean {
  if (mode === "query") return d.visible || d.actionable;
  if (!d.actionable) return allowHidden;
  if (mode === "fillable") return d.editable || allowHidden;
  return true;
}

/**
 * Tier-2 identity: the strongest exact selector that provably names the same
 * element.
 *
 * A destination is matched by its RESOLVED URL, never by an
 * `a[href="<absolute>"]` selector. The href recorded at mint time is the resolved
 * absolute URL, but the DOM attribute is usually relative ("3.13.html"), so that
 * selector matched nothing and a ref whose positional path had been invalidated
 * by a re-render degraded to STALE_REFERENCE even though the identical link was
 * still present. `resolvedHref` is resolved in-page against `document.baseURI`,
 * which also makes `<base href>` behave the way a user's browser does.
 *
 * A name is a description, not an identity, and is only used when the tag/type
 * narrow it to a single plausible control.
 */
function identitySpec(entry: RefEntry): MatchSpec | null {
  const base: MatchSpec = { scope: null, strategy: "identity" };
  if (entry.href) return { ...base, resolvedHref: entry.href, css: null };
  if (entry.testid) return { ...base, testid: entry.testid };
  if (entry.nameAttr && entry.tag) return { ...base, css: `${entry.tag}[name="${entry.nameAttr.replace(/"/g, '\\"')}"]` };
  if (entry.placeholder) return { ...base, placeholder: entry.placeholder, css: `${entry.tag}[placeholder="${entry.placeholder.replace(/"/g, '\\"')}"]` };
  if (entry.name && entry.role) return { ...base, role: entry.role, name: entry.name };
  return null;
}

/**
 * Two descriptors are the same logical element when their identity fields agree.
 *
 * An EMPTY recorded name is treated as "no name was recorded", not as "this
 * element is named the empty string". The two producers legitimately compute
 * accessible names differently — the Observer deliberately does not derive a
 * name from text content for a `<select>`, while the matcher's rule falls through
 * to the option text — so demanding that an unnamed element match a derived name
 * rejected genuinely identical nodes and turned an observe ref to any unlabelled
 * `<select>` into TARGET_NOT_ACTIONABLE. A non-empty recorded name is still
 * required to match, so real identity is not weakened.
 */
export function sameLogicalElement(h: MatchDescriptor, entry: RefEntry): boolean {
  if (h.tag !== entry.tag) return false;
  // A recorded destination is a REAL identity and is never relaxed: two links
  // with identical text but different hrefs are different elements, and a
  // recorded href must still match after resolution. `h.href` is resolved the
  // same way `entry.href` was, so this compares like with like.
  if (entry.href && canonHref(h.href) !== canonHref(entry.href)) return false;
  if (entry.testid && h.testid !== entry.testid) return false;
  if (entry.nameAttr && h.name_attr !== entry.nameAttr) return false;
  if (entry.placeholder && h.placeholder !== entry.placeholder) return false;
  if (entry.name && h.name !== entry.name) return false;
  if (entry.role && h.role !== entry.role) return false;
  return true;
}

/**
 * Normalise a URL for identity comparison.
 *
 * Both sides are already absolute (recorded from `el.href`, matched from
 * `el.href`), so this only strips the fragment for the SAME-document case and
 * normalises trailing noise. It deliberately does NOT weaken comparison between
 * two different destinations.
 */
function canonHref(u: string | null | undefined): string {
  if (!u) return "";
  try {
    const x = new URL(u);
    // A pure-fragment link addresses this document; compare it as such.
    if (x.hash && x.pathname === "/" && !x.search && x.href !== u) return x.origin + x.pathname + x.hash;
    return x.href;
  } catch {
    return String(u);
  }
}

function fingerprintAgrees(fp: { role: string; name: string; href: string | null; tag: string }, entry: RefEntry): boolean {
  if (fp.tag !== entry.tag) return false;
  if (entry.href && canonHref(fp.href) !== canonHref(entry.href)) return false;
  // Same reasoning as sameLogicalElement: only a recorded name can disagree.
  if (entry.name && String(fp.name || "").trim() !== String(entry.name || "").trim()) return false;
  return true;
}

function describeEntry(e: RefEntry): Record<string, unknown> {
  return { role: e.role, name: e.name, tag: e.tag, href: e.href, placeholder: e.placeholder, path: e.path, producer: e.producer, minted_at_revision: e.revision };
}
