/**
 * resolve — the one target resolver.
 *
 * Both halves of the closed loop come through here:
 *
 *     page.probe   → runMatch(...)            "what matches right now?"
 *     page.click   → resolveForAction(...)    "act on exactly that"
 *     page.fill    → resolveForAction(..., "fillable")
 *     select/check/uncheck/scroll → resolveForAction(...)
 *
 * Identity comes from the shared matcher; actionability is the only thing a
 * caller may vary. When an action cannot proceed it returns the TRUE reason
 * (hidden / disabled / stale / ambiguous / not-found) instead of one collapsed
 * TARGET_NOT_FOUND, and when it can, it hands back an effect token so the caller
 * can verify what actually changed.
 */

import type { BrowserEngine, KruzElement } from "./engine.js";
import type { Target, Fallback } from "../types/schema.js";
import { RefRegistry } from "./ref-registry.js";
import { runMatch, specFromTarget, markScript, markSelector } from "./inpage-matcher.js";
import type { MatchDescriptor, MatchMode, MatchSpec } from "./inpage-matcher.js";
import { kruzError, ErrCode, type KruzError } from "../errors.js";

export interface ResolveSuccess {
  ok: true;
  el: KruzElement;
  token: string;
  /** The ref that identifies this element, minted through the shared registry. */
  ref: string;
  /** 1-3 for ref targets (which ladder tier resolved it), 0 for descriptor targets. */
  tier: number;
  descriptor: MatchDescriptor;
}

export interface ResolveFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  help?: string;
  evidence: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
}

export type ResolveResult = ResolveSuccess | ResolveFailure;

export interface ResolverContext {
  engine: BrowserEngine;
  registry: RefRegistry;
  pageId: string;
  documentId: string;
  revision: number;
}

/** Compact, model-facing description of a match. */
export function brief(d: MatchDescriptor): Record<string, unknown> {
  return {
    role: d.role,
    name: d.name,
    tag: d.tag,
    visible: d.visible,
    enabled: d.enabled,
    actionable: d.actionable,
    blocked_reason: d.blocked_reason ?? undefined,
  };
}

export function describeTarget(target: Target, fallback?: Fallback): string {
  const parts: string[] = [];
  if (target.ref) parts.push(`ref=${target.ref}`);
  if (target.role) parts.push(`role=${target.role}`);
  if (target.name) parts.push(`name="${target.name}"`);
  if (target.text) parts.push(`text="${target.text}"`);
  if (target.css) parts.push(`css=${target.css}`);
  if (target.label) parts.push(`label="${target.label}"`);
  if (target.placeholder) parts.push(`placeholder="${target.placeholder}"`);
  if (target.testid) parts.push(`testid=${target.testid}`);
  if (target.id) parts.push(`id=${target.id}`);
  if (target.nameAttr) parts.push(`name=${target.nameAttr}`);
  if (!parts.length && fallback?.css) parts.push(`fallback.css=${fallback.css}`);
  return parts.length === 0 ? "element" : parts.join(" ");
}

function fail(code: string, message: string, evidence: Record<string, unknown>, extra: Partial<ResolveFailure> = {}): ResolveFailure {
  const e = kruzError(code, { subsystem: "controller", message });
  return {
    ok: false,
    code,
    message,
    retryable: e.retryable,
    help: e.help,
    evidence,
    ...extra,
  };
}

/**
 * Resolve a target to a live element.
 *
 * `mode` is the actionability bar:
 *   "query"     identity only (existence checks, scroll bookkeeping)
 *   "clickable" rendered and enabled
 *   "fillable"  rendered, enabled, and an editable field
 */
export async function resolveForAction(
  ctx: ResolverContext,
  target: Target,
  fallback: Fallback | undefined,
  scope: string | undefined,
  mode: MatchMode,
  opts: { allowHidden?: boolean; waitMs?: number } = {},
): Promise<ResolveResult> {
  const { engine: e, registry } = ctx;
  const allowHidden = opts.allowHidden === true;

  // ── ref targets: the ref contract ─────────────────────────────────────────
  if (target.ref) {
    const outcome = await registry.resolve(e, target.ref, mode, {
      pageId: ctx.pageId,
      documentId: ctx.documentId,
      revision: ctx.revision,
      allowHidden,
    });
    if (outcome.kind === "ok") {
      return {
        ok: true,
        el: outcome.el,
        token: outcome.token,
        ref: target.ref,
        tier: outcome.tier,
        descriptor: {
          i: -1, path: outcome.entry.path, tag: outcome.entry.tag, role: outcome.entry.role,
          name: outcome.entry.name, name_source: "", href: outcome.entry.href,
          placeholder: outcome.entry.placeholder, type: outcome.entry.type,
          name_attr: outcome.entry.nameAttr, testid: outcome.entry.testid, value: null,
          checked: null, visible: true, enabled: true, in_viewport: true,
          editable: mode !== "fillable", actionable: true, blocked_reason: null,
          container: outcome.entry.container, rect: null, context: null,
        },
      };
    }
    const err = outcome.error as KruzError;
    return {
      ok: false,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      help: err.help,
      evidence: { ref: target.ref, ...outcome.evidence },
    };
  }

  // ── descriptor targets: exactly the matcher probe uses ────────────────────
  const spec = specFromTarget(target, fallback, scope);
  if (spec.strategy === "none") {
    return fail(ErrCode.INVALID_TARGET, "No target specified. Pass ref, css, role+name, label, placeholder, text, testid, nameAttr or id.", {});
  }

  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
  let m = await runMatch(e, spec, 24);
  if (m.error) return fail(ErrCode.INVALID_TARGET, `Target could not be evaluated (${spec.strategy}): ${m.error}`, { strategy: spec.strategy });

  // A SHORT bounded actionability wait, only for a target that is genuinely
  // expected to exist: §27 allows a live-but-unstable target a moment to
  // settle, and forbids waiting out an assumed target. We only wait when the
  // caller explicitly asked AND the page is still mutating.
  if (m.count === 0 && (opts.waitMs ?? 0) > 0) {
    m = await waitForMatch(e, spec, deadline);
  }

  if (m.count === 0) {
    // The in-page matcher sees one document. A control can also live inside a
    // SAME-ORIGIN child frame, which no in-page matcher can reach — so before
    // declaring the target absent, ask the engine, which does search frames and
    // deep selectors. This keeps the shared matcher primary without making it a
    // capability regression.
    const framed = await e.queryOne(target, fallback, scope, Math.min(opts.waitMs ?? 500, 1500)).catch(() => null);
    if (framed) {
      const entry = registry.mint("ambiguity", {
        i: -1, path: "", tag: "unknown", role: "generic", name: "", name_source: "",
        href: null, placeholder: null, type: null, name_attr: null, testid: null,
        value: null, checked: null, visible: true, enabled: true, in_viewport: true,
        editable: mode !== "fillable", actionable: true, blocked_reason: null,
        container: null, rect: null, context: null,
      }, { pageId: ctx.pageId, documentId: ctx.documentId, frameId: "main", spec, scope, revision: ctx.revision });
      return { ok: true, el: framed, token: "", ref: entry.ref, tier: 4, descriptor: {
        i: -1, path: "", tag: "unknown", role: "generic", name: "", name_source: "",
        href: null, placeholder: null, type: null, name_attr: null, testid: null,
        value: null, checked: null, visible: true, enabled: true, in_viewport: true,
        editable: mode !== "fillable", actionable: true, blocked_reason: null,
        container: null, rect: null, context: null,
      } };
    }
    return fail(
      ErrCode.TARGET_NOT_FOUND,
      `No element matches ${describeTarget(target, fallback)} (matched by ${spec.strategy}) in this document or any same-origin frame.`,
      { strategy: spec.strategy, matched: 0, scope: scope ?? null },
    );
  }

  const usable = m.matches.filter((h) => (mode === "query" ? true : h.actionable) || allowHidden);

  if (usable.length === 0) return notActionable(m, target, fallback, mode, spec);

  if (usable.length > 1) {
    // Refuse, but make the refusal actionable: every returned candidate carries a
    // REAL ref minted through the same registry, so picking one and acting on it
    // works without re-declaring CSS.
    const candidates = m.matches.slice(0, 6).map((h) => {
      const entry = registry.mint("ambiguity", h, {
        pageId: ctx.pageId, documentId: ctx.documentId, frameId: "main", spec, scope, revision: ctx.revision,
      });
      return {
        ref: entry.ref,
        role: h.role,
        name: h.name,
        href: h.href ?? undefined,
        context: h.context ?? undefined,
        visible: h.visible,
        enabled: h.enabled,
        actionable: h.actionable,
        blocked_reason: h.blocked_reason ?? undefined,
      };
    });
    return fail(
      ErrCode.AMBIGUOUS_TARGET,
      `${usable.length} actionable element(s) match ${describeTarget(target, fallback)}. Kruz will not guess between them.`,
      { strategy: spec.strategy, matched: m.count, actionable: usable.length },
      { candidates },
    );
  }

  // Exactly one actionable match: pin the actual node in-page and hand it to
  // the engine. Taking the live node (rather than a CSS handle) is what lets a
  // control inside an open shadow root be clicked at all, and it removes any
  // drift between "found it" and "act on it".
  const chosen = usable[0];
  const ordinal = m.matches.indexOf(chosen);
  const token = registry.newToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const marked = await e.evaluate(markScript(spec, ordinal, token)).catch(() => null);
    if (!marked?.ok) continue;
    const fp = (marked.result as any)?.fingerprint;
    if (fp && (fp.tag !== chosen.tag || String(fp.name || "").trim() !== String(chosen.name || "").trim() || (chosen.href && fp.href !== chosen.href))) {
      continue; // the ordinal moved under us; re-mark once
    }
    const el = await e.takeMarkedNode(markSelector(token), target).catch(() => null);
    if (el) {
      const entry = registry.mint("ambiguity", chosen, {
        pageId: ctx.pageId, documentId: ctx.documentId, frameId: "main", spec, scope, revision: ctx.revision,
      });
      return { ok: true, el, token, ref: entry.ref, tier: 0, descriptor: chosen };
    }
  }
  return fail(
    ErrCode.STALE_ELEMENT,
    `The element matching ${describeTarget(target, fallback)} changed while Kruz was pinning it. Re-probe and act on a fresh ref.`,
    { strategy: spec.strategy, matched: m.count },
  );
}

/** Distinguish "matched but unusable" from "did not match" with the real reason. */
function notActionable(
  m: { count: number; matches: MatchDescriptor[] },
  target: Target,
  fallback: Fallback | undefined,
  mode: MatchMode,
  spec: MatchSpec,
): ResolveFailure {
  const all = m.matches;
  const hidden = all.filter((h) => !h.visible);
  const disabled = all.filter((h) => h.visible && !h.enabled);
  const d = describeTarget(target, fallback);
  if (hidden.length === all.length) {
    return fail(
      ErrCode.ELEMENT_NOT_VISIBLE,
      `${all.length} element(s) match ${d} but none is rendered (display:none, visibility:hidden, a hidden ancestor, or zero size).`,
      { strategy: spec.strategy, matched: all.length, actionable: 0, blocked: hidden.slice(0, 4).map(brief) },
    );
  }
  if (disabled.length === all.length) {
    return fail(
      ErrCode.ELEMENT_DISABLED,
      `${all.length} element(s) match ${d} but every one is disabled.`,
      { strategy: spec.strategy, matched: all.length, actionable: 0, blocked: disabled.slice(0, 4).map(brief) },
    );
  }
  if (mode === "fillable") {
    return fail(
      ErrCode.ELEMENT_NOT_EDITABLE,
      `${d} matches ${all.length} element(s) but none is an editable field.`,
      { strategy: spec.strategy, matched: all.length, blocked: all.slice(0, 4).map(brief) },
    );
  }
  return fail(
    ErrCode.TARGET_NOT_ACTIONABLE,
    `${all.length} element(s) match ${d} but none is actionable right now.`,
    { strategy: spec.strategy, matched: all.length, actionable: 0, blocked: all.slice(0, 4).map(brief) },
  );
}

/**
 * Bounded, mutation-aware wait for a target to appear.
 *
 * Deliberately NOT a blind poll: it gives up as soon as the page stops
 * mutating, because a quiet document cannot produce an element that is not
 * there yet. This keeps the "guessed selector should fail fast" discipline.
 */
async function waitForMatch(e: BrowserEngine, spec: MatchSpec, deadline: number) {
  const m = await runMatch(e, spec, 24);
  if (m.count > 0) return m;
  let lastMutations = -1;
  let quietSince = Date.now();
  for (;;) {
    const now = Date.now();
    if (now >= deadline) return m;
    const r = await e.evaluate(`(() => { try { return { mut: (window).__p1MutationCount ? (window).__p1MutationCount() : null, ready: document.readyState }; } catch (e) { return null; } })()`).catch(() => null) as any;
    if (r?.ok && r.result && typeof r.result.mut === "number") {
      if (r.result.mut !== lastMutations) { lastMutations = r.result.mut; quietSince = now; }
      // A settled document will not conjure the element; stop instead of burning
      // the rest of the budget (this is the settled-aware rule the rest of the
      // codebase already follows).
      if (now - quietSince > 700 && r.result.ready !== "loading") return m;
    }
    const again = await runMatch(e, spec, 24);
    if (again.count > 0) return again;
    await e.waitMs(120);
  }
}
