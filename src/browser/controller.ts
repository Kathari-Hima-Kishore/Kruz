function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch {
    return u.split("#")[0].replace(/\/$/, "");
  }
}

import type { BrowserEngine, KruzElement } from "./engine.js";
import type { Target, Fallback } from "../types/schema.js";
import { resolveElement, resolveElementWithRef, tryResolveElement } from "./selectors.js";
import { RefRegistry } from "./ref-registry.js";
import { resolveForAction } from "./resolve.js";
import { runMatch, specFromTarget } from "./inpage-matcher.js";
import type { MatchDescriptor, MatchMode, MatchSpec } from "./inpage-matcher.js";
import type { SessionManager, SessionState } from "../session/manager.js";
import type { Observation } from "../types/observation.js";
import { extractExperienceSignals } from "./ats-tools.js";

import { bulkHarvest, type TargetCompany } from "./ats-json.js";
import { kruzError, kruzErrorFromThrown, ErrCode, withRetry, type Subsystem } from "../errors.js";

/**
 * Diagnostic timing for an action. Metadata only: never consulted when deciding
 * what to do next, and measured from inside the process rather than by a caller
 * wrapping the call in a timer. Fields are omitted when not applicable.
 */
export interface ActionTiming {
  total_ms?: number;
  identity_ms?: number;
  resolve_ms?: number;
  action_ms?: number;
  verify_ms?: number;
  observe_ms?: number;
}

export interface ActionResult {
  ok: boolean;
  ref?: string;
  result?: any;
  timing?: ActionTiming;
  error?: { code: string; message: string; retryable: boolean; subsystem?: string; help?: string; trace?: string[]; cause?: string };
  observation?: Observation;
}

/**
 * Compact, decision-grade page state attached to mutating actions (P1-A). Deliberately
 * small — never a full observation; just enough for the model to decide the next
 * dependent action without a second observe round trip.
 */
export interface PageFeedback {
  url: string;
  title: string;
  document_id?: number;
  navigation?: "completed" | "none_observed";
  url_changed?: boolean;
  old_url?: string;
  document_changed?: boolean;
  dom_changed?: boolean;
  focus?: string | null;
  interactive_added?: string[];
  appeared_text?: string[];
  settled?: boolean;
  page_mutated?: boolean;
  signature?: string;
}

/**
 * Map a control's dismissal intent back to the overlay kind it belongs to.
 * `regionKind` (cookie / newsletter / chat / app / dialog / edge-panel) is
 * preferred when discovery identified one, because that is what callers mean by
 * "an overlay of type X".
 */
function kindOfIntent(intent: string, regionKind?: string): string {
  if (regionKind && regionKind !== "edge-panel" && regionKind !== "dialog") return regionKind;
  return intent === "accept" || intent === "reject" ? "cookie" : intent === "close" ? "overlay" : intent;
}

export class BrowserController {
  private sessionManager: SessionManager;
  private consoleLogs: string[] = [];
  private networkRequests: { url: string; method: string; status?: number; contentType?: string; body?: string; truncated?: boolean }[] = [];
  private captureResponseBodies = false;
  private responseBodyHits = 0;
  private dialogDefaultAction: "accept" | "dismiss" = "accept";
  private dialogDefaultValue: string | undefined;
  private activePageId = "p1";
  private engineCaptureEnabled = false;

  constructor(sm: SessionManager) { this.sessionManager = sm; }

  clearCapture(): void { this.consoleLogs = []; this.networkRequests = []; }
  clearNetworkLogs(): void { this.networkRequests = []; }
  isBrowserConnected(): boolean { return this.getActiveSession()?.engine?.connected ?? false; }

  // ═══ NAVIGATION ═══════════════════════════════════════════════════════════

  async open(url: string, waitFor: "load" | "domcontentloaded" | "networkidle" | "commit" = "domcontentloaded", timeoutMs?: number): Promise<ActionResult> {
    const engine = this.engine();
    if (!engine) return this.noSession();
    // BUG-4: Clear network logs from previous navigation to avoid cumulative dumps
    this.clearNetworkLogs();
    // The caller's actual argument, preserved verbatim. It used to be overwritten
    // with the coerced value before being reported back as `requested`, so the
    // response described a request that was never made.
    const requestedWait = waitFor;
    // K1: `networkidle` is not honoured as a browser lifecycle event — it never
    // resolves on SPAs with WebSockets (Oracle HCM, Snowflake, Workday). It is
    // implemented instead as a BOUNDED in-page quiescence check below, so the
    // caller still gets the semantics they asked for, and an honest answer when
    // quiescence was not reached within the budget.
    const lifecycleWait = waitFor === "networkidle" ? "domcontentloaded" : waitFor;
    // Career portals (Siemens/Phenom, Oracle HCM, SuccessFactors) need 12-25s for edge
    // CDN + bot-mitigation before domcontentloaded fires — default 45s, honor caller
    // timeout_ms up to 60s. No more 15s hard cap.
    const rawTimeout = Math.min(timeoutMs || 45000, 60000);
    const effectiveWait = lifecycleWait;
    const effectiveTimeout = effectiveWait === "commit" ? Math.min(rawTimeout, 30000) : rawTimeout;
    // K30: Do NOT gate readiness on the DOMContentLoaded/load lifecycle event.
    // The goto below is capped at 20s so it can never deadlock the routing thread
    // for 45-55s on portals that never fire load; readiness is then decided by
    // pollForContent — a real check of what is actually rendered (body text > 100
    // chars OR a real title AND the target host), polled every 400ms up to 15s.
    // This matches what the user sees on screen and reports the true observed
    // state (via _ready/_waited_ms/body_length) instead of a lifecycle guess.
    try {
      const t0 = Date.now();
      // Speed: bringToFront + listener attach run concurrently with navigation
      // instead of serially — saves 1-2 round-trips per page.open.
      await this.listen(engine).catch(() => {});
      const tNav0 = Date.now();
      // BUG-005: the lifecycle event and the readiness poll were SERIALISED, so
      // a page that is fully rendered and usable while `domcontentloaded` never
      // fires cost the whole 20s navigate cap before the poll even started. That
      // is what produced a flat ~20.2s navigate_ms followed by an ~11ms poll on
      // ordinary storefronts: the time was spent waiting for an event nobody
      // needed, not for the page.
      //
      // Readiness is decided by pollForContent — a real check of what is
      // rendered — so the two are raced instead. snapshotPage verifies the target
      // host, so polling cannot be satisfied by the page we are leaving.
      let navSettledMs: number | null = null;
      let navErr: unknown = null;
      const navP = engine.navigate(url, effectiveWait, Math.min(effectiveTimeout, 20000))
        .catch((e) => { navErr = e; })
        .then(() => { navSettledMs = Date.now() - tNav0; });
      await engine.bringToFront().catch(() => {});
      const tPoll0 = Date.now();
      let pic = await this.pollForContent(engine, url, Math.min(rawTimeout, 15000), 250);
      // Bounded network-idle wait. Runs AFTER the content poll on purpose: run
      // earlier it would sample a page that has not loaded yet and declare
      // "idle" instantly, which is worse than not offering the option.
      let networkIdleMs: number | null = null;
      let networkIdleReached: boolean | null = null;
      if (requestedWait === "networkidle") {
        const tNi = Date.now();
        const budgetMs = Math.min(Math.max(rawTimeout, 1000), 8000);
        const QUIET_MS = 500;
        while (Date.now() - tNi < budgetMs) {
          const q = await this.networkQuiescence(engine);
          if (q && q.pending === 0 && q.quietForMs >= QUIET_MS) { networkIdleReached = true; break; }
          await engine.waitMs(200).catch(() => {});
        }
        if (networkIdleReached === null) networkIdleReached = false;
        networkIdleMs = Date.now() - tNi;
      }
      // A not-ready verdict is only trustworthy once the navigation has actually
      // committed. Before that, pollForContent is reading the pre-navigation
      // document (empty body, no mutation tracker), which its thin-page shortcut
      // treats as settled — so without this guard a slow page is reported
      // PAGE_NOT_READY after ~2s instead of being waited for. Waiting the
      // navigation out here costs nothing on the fast path: when content really
      // was ready, the branch is never entered.
      if (!pic.loaded && navSettledMs === null) {
        await navP.catch(() => {});
        pic = await this.pollForContent(engine, url, Math.min(rawTimeout, 15000), 250);
      }
      // Let an in-flight lifecycle wait finish in the background rather than
      // leaving a dangling navigation, but never block on it: by now the content
      // poll has already decided readiness one way or the other.
      await Promise.race([navP, engine.waitMs(1500).catch(() => {})]);
      // Distinguish "never resolved" from "still running when we stopped looking".
      // Reporting the latter as a timeout produced a false LIFECYCLE_NOT_RESOLVED
      // on fast navigations whose event simply had not landed inside the grace
      // window — a warning that cries wolf is worse than none.
      const navBudgetMs = Math.min(effectiveTimeout, 20000);
      const navElapsedMs = Date.now() - tNav0;
      const lifecycleState: "resolved" | "pending" | "gave_up" =
        navSettledMs !== null ? "resolved" : navElapsedMs >= navBudgetMs ? "gave_up" : "pending";
      // K31+: A real Chrome crash (renderer OOM / hard process death) must surface as
      // BROWSER_CRASHED so the router's openWithRetry can auto-recreate the session.
      // Without this check the swallowed navigate error reads as PAGE_NOT_READY and the
      // whole session looks wedged. Snapshot first in case we're mid-detrailing.
      if (!engine.connected) {
        return this.err("BROWSER_CRASHED", "Browser disconnected during navigation (renderer crash or process death).", true) as any;
      }
      if (!engine.connected) {
        return this.err("BROWSER_CRASHED", "Browser disconnected during content poll (renderer crash or process death).", true) as any;
      }
      const tFg = Date.now();
      // Accuracy: NO auto cookie-banner dismissal here. Auto-clicking overlays is
      // the same failure class as the Apply-control mis-clicks (wrong-element
      // clicks without an explicit instruction). The caller clears overlays
      // explicitly via page.handleOverlays before interacting.
      this.afterAction(pic.currentUrl || url);
      const tEnd = Date.now();

      const result: any = {
        url: pic.currentUrl || url,
        title: pic.title,
        _ready: pic.loaded,
        _ready_check: "content-based: body text > 100 chars, or a settled document (readyState != 'loading') with a title or interactive elements (P0-B thin-page fix) — polled every 250ms up to 15s",
        _waited_ms: pic.elapsedMs,
        body_length: pic.bodyLength,
        ...(pic.thin ? { _thin_page: true } : {}),
        _timing: {
          listen_ms: tNav0 - t0,
          // Sub-phases inside the former opaque navigate_ms. `lifecycle_ms` is
          // null when the browser never resolved the wait condition at all, which
          // is the signal that distinguishes "slow page" from "stalled event".
          lifecycle_ms: navSettledMs,
          lifecycle_timed_out: lifecycleState === "gave_up",
          lifecycle_state: lifecycleState,
          navigate_ms: tPoll0 - tNav0,
          poll_ms: tFg - tPoll0,
          overlay_ms: tEnd - tFg,
          total_ms: tEnd - t0,
        },
        _wait_condition: {
          // `requested` is the caller's argument verbatim; `lifecycle` is what
          // the browser was actually asked for. They differ exactly when a
          // downgrade happened, which is what makes the downgrade detectable.
          requested: requestedWait,
          lifecycle: effectiveWait,
          downgraded: requestedWait !== effectiveWait,
          ...(networkIdleMs !== null
            ? { network_idle_ms: networkIdleMs, network_idle_reached: networkIdleReached }
            : {}),
        },
      };
      if (lifecycleState === "gave_up") {
        result._warning = "LIFECYCLE_NOT_RESOLVED";
        result._warning_detail = `The '${effectiveWait}' lifecycle event never resolved within ${navBudgetMs}ms. Readiness was decided from rendered content instead (${
          pic.loaded ? "content present" : "no content detected"
        }).`;
      }
      if (!pic.loaded) {
        // The lifecycle wait failing is the likeliest explanation, and it is
        // actionable (retry with wait_for:"commit"), so it must not stay swallowed.
        if (navErr) result._navigate_error = String(navErr).slice(0, 300);
        if (navSettledMs === null) {
          result._navigate_error ??= `The '${effectiveWait}' lifecycle event never resolved within ${navBudgetMs}ms.`;
        }
        result._warning = "PAGE_NOT_READY";
        result.message = `Navigation committed but no real content detected after ${pic.elapsedMs}ms poll (body_length=${pic.bodyLength}). The page may show a bot-challenge, consent wall, or is still hydrating. Call page.observe or extract.text to see what is actually on screen.`;
        result.hint = "Do NOT loop on page.open. Use page.wait with condition:'content' and a predicate (e.g. predicate: 'document.querySelector(\".jobs-list\")') to wait for the specific element you need.";
      }
      return { ok: true, result };
    } catch (e) {
      // Even on hard failure, include a snapshot so the model can see what IS there
      // instead of going blind (e.g. partial SPA render, cookie wall, consent banner).
      const snap = await this.snapshotPage(engine, url).catch(() => null);
      const base = this.err("page.open", `Navigation failed: ${e}`, true) as any;
      if (snap) {
        base.result = { currentUrl: snap.currentUrl, title: snap.title, bodyLength: snap.bodyLength, targetUrl: url };
        base.error.message += ` Current page: ${snap.currentUrl || "(blank)"} (${snap.bodyLength} chars). Call page_observe or extract.text to read what loaded instead of retrying navigate blindly.`;
      }
      return base;
    }
  }

  /** Poll for real rendered content after navigation — lets slow SPAs hydrate without
   *  trusting a lifecycle event. Returns the observed state + how long the poll took. */
  private async pollForContent(engine: BrowserEngine, targetUrl: string, maxMs = 15000, intervalMs = 250): Promise<{ loaded: boolean; currentUrl: string; title: string; bodyLength: number; thin: boolean; elapsedMs: number }> {
    const started = Date.now();
    let snap = await this.snapshotPage(engine, targetUrl);
    if (snap.loaded && !snap.thin) return { ...snap, elapsedMs: Date.now() - started };

    // Issue A (manual report): a React shell reported `_ready: true` with
    // `body_length: 0` while the app was still mounting, so the very next action
    // raced the mount and found nothing. A thin page that is STILL MUTATING is
    // not ready — but neither should a genuinely thin, settled page (login wall,
    // empty state) pay a long wait. So: only keep polling while the DOM is
    // actively changing, under a short bounded window. This is event-driven
    // (mutation counts), not a fixed sleep, and it does not touch normal pages.
    const thinWindow = 3000;
    let lastMut = -1;
    let lastChangeAt = Date.now();
    for (let elapsed = 0; elapsed < maxMs; elapsed += intervalMs) {
      await engine.waitMs(intervalMs).catch(() => {});
      snap = await this.snapshotPage(engine, targetUrl);
      if (snap.loaded && !snap.thin) return { ...snap, elapsedMs: Date.now() - started };
      if (!snap.thin) return { ...snap, elapsedMs: Date.now() - started };
      const mut = await this.mutationCount(engine);
      const now = Date.now();
      // No tracker means no evidence of continued mounting: without a positive
      // signal that the page is still growing, a thin page is taken at face
      // value. This is what keeps a settled thin page (login wall, empty state)
      // from paying any wait at all.
      if (mut === null) return { ...snap, elapsedMs: Date.now() - started };
      if (mut !== lastMut) { lastMut = mut; lastChangeAt = now; }
      // Settled thin document: nothing more is coming, so stop waiting.
      if (now - lastChangeAt > 500) return { ...snap, elapsedMs: Date.now() - started };
      if (now - started > thinWindow) return { ...snap, elapsedMs: Date.now() - started };
    }
    return { ...snap, elapsedMs: Date.now() - started };
  }

  /**
 * In-flight request count and how long the network has been quiet, from the
 * Resource Timing buffer. `responseEnd === 0 && duration === 0` is a request
 * the browser started but has not finished.
 *
 * This is what makes `networkidle` implementable at all: the browser's own
 * networkidle lifecycle event never fires on a page holding a WebSocket or a
 * long-poll, which is why the option used to be silently coerced away. Resource
 * Timing is per-request rather than per-connection, so a permanently open socket
 * does not prevent quiescence from being detected.
 */
  private async networkQuiescence(engine: BrowserEngine): Promise<{ pending: number; quietForMs: number; total: number } | null> {
    const r = await engine.evaluate(`(() => {
      try {
        var rs = performance.getEntriesByType("resource");
        var pending = 0, lastStart = 0;
        for (var i = 0; i < rs.length; i++) {
          var e = rs[i];
          if (e.responseEnd === 0 && e.duration === 0) pending++;
          if (e.startTime > lastStart) lastStart = e.startTime;
        }
        return { pending: pending, quietForMs: Math.round(performance.now() - lastStart), total: rs.length };
      } catch (x) { return null; }
    })()`).catch(() => null);
    const v = r?.ok ? (r.result as any) : null;
    return v && typeof v.pending === "number" ? v : null;
  }

  /** Current DOM mutation count, or null when no tracker is installed. */
  private async mutationCount(engine: BrowserEngine): Promise<number | null> {
    const r = await engine.evaluate(`(() => { try { const f = (window).__p1MutationCount; return typeof f === 'function' ? f() : null; } catch (e) { return null; } })()`).catch(() => null);
    const v = r?.ok ? (r.result as number | null) : null;
    return typeof v === "number" ? v : null;
  }

  /** Lightweight snapshot: is there anything rendered, even if the load event never fired?
   *  P0-B: readiness no longer requires >100 chars of body text. A settled document with a
   *  title or usable interactive DOM counts as ready, so legitimate thin pages (login walls,
   *  canvas apps, empty states, small utilities) never pay the full readiness poll. */
  private async snapshotPage(engine: BrowserEngine, targetUrl: string): Promise<{ loaded: boolean; currentUrl: string; title: string; bodyLength: number; thin: boolean }> {
    try {
      const currentUrl: string = await engine.url();
      // One evaluate for title/body/interactive/ready instead of three round trips.
      const r = await engine.evaluate(`(() => {
        const bodyLen = document.body ? (document.body.innerText || '').trim().length : 0;
        const interactive = document.querySelectorAll('a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]').length;
        return { bodyLen, interactive, ready: document.readyState !== 'loading', title: document.title || '' };
      })()`).catch(() => ({ ok: false as const }));
      const v = (r.ok ? r.result : null) as { bodyLen?: number; interactive?: number; ready?: boolean; title?: string } | null;
      const bodyLength = v?.bodyLen ?? 0;
      const title = v?.title ?? "";
      const interactive = v?.interactive ?? 0;
      const docReady = v?.ready === true;
      const isHttpBlank = !currentUrl || currentUrl === "about:blank" || currentUrl.startsWith("chrome://");
      // Real content is the strong signal; a settled document with a title or any usable
      // interactive control is the thin-page fallback (P0-B).
      const meaningful = bodyLength > 100;
      const thinButUsable = docReady && !meaningful && (title.trim().length > 0 || interactive > 0);
      const loaded = !isHttpBlank && (meaningful || thinButUsable);
      return { loaded, currentUrl, title, bodyLength, thin: thinButUsable };
    } catch {
      return { loaded: false, currentUrl: "", title: "", bodyLength: 0, thin: false };
    }
  }

  async back(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try { await e.back(); await e.waitForLoadState("domcontentloaded", 30000).catch(() => {}); this.afterAction(await e.url()); return { ok: true }; }
    catch (err) { return this.err("page.back", `Go back failed: ${err}`, true); }
  }

  async forward(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try { await e.forward(); await e.waitForLoadState("domcontentloaded", 30000).catch(() => {}); this.afterAction(await e.url()); return { ok: true }; }
    catch (err) { return this.err("page.forward", `Go forward failed: ${err}`, true); }
  }

  async reload(waitFor: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try { await e.reload(); await e.waitForLoadState(waitFor === "networkidle" ? "domcontentloaded" : waitFor, 30000).catch(() => {}); this.afterAction(await e.url()); return { ok: true }; }
    catch (err) { return this.err("page.reload", `Reload failed: ${err}`, true); }
  }

  // ═══ CLICK VARIANTS ══════════════════════════════════════════════════════

  async click(target: Target, fallback?: Fallback, scope?: string, timeoutMs = 5000, _strict = true, button: "left" | "right" | "middle" = "left", clickCount: 1 | 2 | 3 = 1, opts: { force?: boolean; ignoreVisibility?: boolean; visual?: boolean; speed?: "instant" | "fast" | "normal" | "slow" } = {}): Promise<ActionResult> {
    const t0 = Date.now();
    let tResolved = 0;
    const e = this.engine(); if (!e) return this.noSession();
    if (!this.hasTarget(target, fallback)) return { ok: false, error: kruzError(ErrCode.INVALID_TARGET, { subsystem: "controller", message: "No target specified. Wrap ref in target object: {\"target\": {\"ref\": \"e...\"}}.", trace: ["controller"] }).toJSON() };

    const forceClick = !!(opts.force || opts.ignoreVisibility);
    let resolved = false;
    try {
      // One resolver, one meaning of "this target". The old path resolved with
      // one matcher and then re-measured ambiguity with a second, private
      // in-page script; that divergence is why the manual report could see a
      // node through `page.probe` and then get TARGET_NOT_FOUND from `page.click`.
      await this.refreshIdentity(e);
      const r = await resolveForAction(
        { engine: e, registry: this.refs(), pageId: this.activePageId, documentId: this.docIdCache, revision: this.revisionCache },
        target, fallback, scope, "clickable",
        { allowHidden: forceClick, waitMs: _strict && !target.ref ? 0 : Math.min(timeoutMs, 1200) },
      );
      if (!r.ok) {
        return {
          ok: false,
          // Diagnostic only: a failed resolution is measured too, because that
          // is where a latency regression would hide.
          timing: { total_ms: Date.now() - t0, resolve_ms: Date.now() - t0, action_ms: 0 },
          error: kruzError(r.code, { subsystem: "controller", message: r.message, retryable: r.retryable, help: r.help }).toJSON(),
          result: r.candidates ? { count: r.candidates.length, candidates: r.candidates, resolution: r.evidence } : r.evidence,
        };
      }
      const el = r.el;
      resolved = true;
      tResolved = Date.now() - t0;
      const tDispatch = Date.now();
      await e.click(el, {timeoutMs, button, clickCount, force:forceClick, visual: opts.visual, speed: opts.speed});
      const tAction = Date.now() - tDispatch;
      this.bump();
      const tVerify = Date.now();
      const dialog = await e.nextDialog();
      const timing = { total_ms: Date.now() - t0, resolve_ms: tResolved, action_ms: tAction, verify_ms: Date.now() - tVerify };
      if (dialog) return {ok:true,timing,result:{dialog_pending:true,dialog}};
      // The effect token lets post-click verification ask what happened to THIS
      // element (Bug 6: a banner dismissal is a real effect even when the body
      // text signature is unchanged).
      return { ok: true, timing, result: { effect_token: r.token, ref: r.ref, resolution_tier: r.tier } };
    } catch (err) {
      // Refs are invalidated only when the failure came AFTER resolution, i.e.
      // dispatch may have mutated the page. A resolution failure leaves the DOM
      // untouched, and clearing the ref map there made every other ref on the
      // page unusable — one failed click destroyed the whole observation.
      if (resolved) this.invalidateAllRefs();
      const env = kruzErrorFromThrown(err);
      const recoverable = [ErrCode.ELEMENT_OBSCURED, ErrCode.STALE_ELEMENT, ErrCode.ELEMENT_NOT_VISIBLE, ErrCode.ELEMENT_DISABLED].includes(env.code as any);
      return this.err(env.code, env.message, recoverable, {
        subsystem: env.subsystem,
        help: env.help,
      });
    }
  }


  // ═══ OBSERVATION / FEEDBACK (P1-A) ══════════════════════════════════════

  /**
   * Compact post-action page state. One in-page pass (no full observation), bounded
   * payload — the model uses it to choose the next dependent action without a
   * separate observe round trip. When `before` is supplied it also reports whether
   * the URL/document changed since that snapshot.
   */
  async pageFeedback(
    e: BrowserEngine,
    before?: PageFeedback | null,
    opts: { settled?: boolean; includeLists?: boolean } = {},
  ): Promise<PageFeedback> {
    const script = `(() => {
      try {
        const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'; };
        const bodyLen = document.body ? (document.body.innerText || '').trim().length : 0;
        const interactiveCount = document.querySelectorAll("button,a,input,select,textarea,[role=button],[role=link],[role=textbox],[role=option],[role=menuitem]").length;
        let mutations = 0;
        try { const f = window.__p1MutationCount; if (typeof f === 'function') mutations = f(); } catch (e) {}
        const out = {
          url: location.href,
          title: document.title,
          document_id: performance.timeOrigin,
          focus: (document.activeElement && (document.activeElement.id || document.activeElement.getAttribute('data-testid') || document.activeElement.tagName || null)) || null,
          signature: bodyLen + ':' + mutations + ':' + interactiveCount,
          interactive_added: [],
          appeared_text: [],
        };
        if (${opts.includeLists !== false}) {
          out.interactive_added = Array.from(document.querySelectorAll("button,a,input,select,textarea,[role=button],[role=link],[role=textbox],[role=option],[role=menuitem]"))
            .filter(visible)
            .slice(0, 12)
            .map(n => ((n.getAttribute('aria-label') || (n.textContent || '').trim()).slice(0, 60)).trim())
            .filter(s => s.length > 0 && s.length < 60);
          out.appeared_text = (document.body ? document.body.innerText.split('\\n').map(s => s.trim()).filter(s => s.length > 2 && s.length < 90).slice(0, 8) : []);
        }
        return out;
      } catch (e) { return { url: '', title: '', document_id: 0, focus: null, signature: '', interactive_added: [], appeared_text: [] }; }
    })()`;
    const r = await e.evaluate(script).catch(() => ({ ok: false as const }));
    const v = r.ok ? (r.result as any) : null;
    const clip = (s: string, n: number) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s ?? "");
    const fb: PageFeedback & { signature?: string } = {
      url: clip(v?.url ?? "", 300),
      title: clip(v?.title ?? "", 200),
      document_id: typeof v?.document_id === "number" ? Math.round(v.document_id) : undefined,
      focus: v?.focus ?? null,
    };
    (fb as any).signature = v?.signature ?? "";
    if (opts.includeLists !== false) {
      fb.interactive_added = (v?.interactive_added ?? []).map((s: string) => clip(s, 120));
      fb.appeared_text = (v?.appeared_text ?? []).map((s: string) => clip(s, 120));
    }
    if (before) {
      fb.url_changed = !!before.url && fb.url !== before.url;
      fb.document_changed = !!before.document_id && fb.document_id !== before.document_id;
      // Only echo the previous URL when it actually changed — a 200-char data:/query
      // URL duplicated on every mutate would otherwise dominate the payload.
      if (fb.url_changed) fb.old_url = clip(before.url, 300);
      fb.dom_changed = fb.url_changed || fb.document_changed ||
        (fb as any).signature !== (before as any).signature ||
        JSON.stringify({ t: fb.title, f: fb.focus }) !== JSON.stringify({ t: before.title, f: before.focus });
      fb.navigation = (fb.url_changed || fb.document_changed) ? "completed" : "none_observed";
      // §20C/§27: explicit mutation verdict (parity with state.dom_changed) so callers
      // can gate on a single obvious field.
      fb.page_mutated = fb.dom_changed;
    }
    if (opts.settled !== undefined) fb.settled = opts.settled;
    return fb;
  }

  /**
   * Candidates for a target, minted as REAL refs through the shared registry.
   *
   * This used to hand the model synthetic `c1..cN` labels produced inside a
   * throwaway evaluate, which no action tool could resolve (manual report Bugs
   * 1-3). Every candidate here is registered in the same identity system the
   * actions read, so `page.click({ref})` on a returned candidate just works.
   *
   * It also runs the SAME matcher the action path uses, so a candidate that is
   * reported here is an element a click could actually land on.
   */
  private async targetCandidates(
    e: BrowserEngine,
    target: Target,
    fallback?: Fallback,
    scope?: string,
    limit = 6,
    producer: "ambiguity" | "probe" = "ambiguity",
  ): Promise<Array<Record<string, unknown>>> {
    const spec = specFromTarget(target, fallback, scope);
    if (spec.strategy === "none") return [];
    const m = await runMatch(e, spec, 40);
    if (m.error) return [];
    await this.refreshIdentity(e);
    const registry = this.refs();
    // Actionable candidates first: for an agent, a visible+enabled element is
    // what it can act on. Hidden matches are still reported, but honestly
    // labelled, so "probe saw it" can never imply "you can click it".
    const ordered = [...m.matches].sort((a, b) => Number(b.actionable) - Number(a.actionable));
    return ordered.slice(0, limit).map((h) => {
      const entry = registry.mint(producer, h, {
        pageId: this.activePageId, documentId: this.docIdCache, frameId: "main",
        spec, scope, revision: this.revisionCache,
      });
      return {
        ref: entry.ref,
        role: h.role,
        name: h.name,
        href: h.href ?? undefined,
        context: h.context ?? undefined,
        visible: h.visible,
        enabled: h.enabled,
        in_viewport: h.in_viewport,
        actionable: h.actionable,
        blocked_reason: h.blocked_reason ?? undefined,
      };
    });
  }

  /** Compact candidate list for an ambiguous target (P1-C), bounded. */
  private async ambiguityCandidates(
    e: BrowserEngine,
    target: Target,
    fallback?: Fallback,
    scope?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.targetCandidates(e, target, fallback, scope, 6, "ambiguity");
  }

  /**
   * page.probe — "what matches the CURRENT DOM right now?".
   *
   * Never waits (spec 26). Reports count, actionable_count, and per-candidate
   * actionability, so the model can tell matched-but-hidden apart from
   * actionable, and every candidate carries a usable ref.
   */
  async probeTarget(e: BrowserEngine, target: Target, fallback?: Fallback, scope?: string): Promise<{
    count: number; actionable_count: number; strategy: string; candidates: Array<Record<string, unknown>>;
    _timing?: { probe_ms: number }; error?: string;
  }> {
    const spec = specFromTarget(target, fallback, scope);
    if (spec.strategy === "none") {
      return { count: 0, actionable_count: 0, strategy: "none", candidates: [] };
    }
    const started = Date.now();
    const m = await runMatch(e, spec, 40);
    const candidates = await this.targetCandidates(e, target, fallback, scope, 8, "probe");
    return {
      count: m.count,
      actionable_count: m.actionable_count,
      strategy: spec.strategy ?? "none",
      candidates,
      // Never hide a matcher failure behind a bare 0: "nothing matched" and
      // "the check itself failed" are different answers, and conflating them is
      // how a page gets misdiagnosed as empty.
      ...(m.error ? { error: m.error } : {}),
      _timing: { probe_ms: Date.now() - started },
    };
  }

  // ═══ KEYBOARD & TEXT ═════════════════════════════════════════════════════

  async type(target: Target, text: string, fallback?: Fallback, scope?: string, delayMs?: number, clear = false, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    // Recovery ladder, executed by the shared retry policy: on a resolution or
    // actionability failure, re-observe (SPA churn invalidates refs) and retry the
    // value write directly, which is the path that survives React controlled
    // inputs that ignore synthesised key events.
    const reobserve = async (): Promise<boolean> => {
      const s = this.getActiveSession();
      if (!s?.engine) return false;
      await s.observer.observe(s.engine, scope, "minimal", true);
      return true;
    };
    const writeDirectly = async (): Promise<boolean> => {
      // Escalation grace, not a second full budget: an impossible target must not
      // pay timeout_ms once per escalation (measured 3x = 15s at the default).
      const grace = Math.min(timeoutMs, 800);
      const { el } = await this.resolve(target, fallback, scope, grace);
      await e.waitForSelector(el.target, { state: "visible", timeoutMs: grace });
      await e.fill(el, text, { timeoutMs });
      return true;
    };

    const attempt = async (): Promise<ActionResult> => {
      const { el } = await this.resolve(target, fallback, scope, timeoutMs);
      await e.waitForSelector(el.target, { state: "visible", timeoutMs });
      await e.fill(el, "", { timeoutMs }).catch(() => {});
      await e.type(el, text, { delayMs, clear, timeoutMs });
      // Verify the value actually registered (React/ATS controlled inputs
      // sometimes ignore key events). If not, fall back to fill() directly.
      try {
        const got = await e.inputValue(el).catch(() => "");
        if (got !== text) { await e.fill(el, text, { timeoutMs }); }
      } catch { /* non-input element; skip verification */ }
      this.bump();
      return { ok: true };
    };

    try {
      return await withRetry(attempt, {
        retryOn: [ErrCode.TARGET_NOT_FOUND, ErrCode.ELEMENT_NOT_FOUND, ErrCode.STALE_ELEMENT, ErrCode.ELEMENT_NOT_VISIBLE],
        escalations: [{ name: "re-observe", run: reobserve }, { name: "direct-fill", run: writeDirectly }],
      });
    } catch (err) {
      const env = kruzErrorFromThrown(err, { subsystem: "controller" });
      return this.err(env.code, `Type failed for ${this.desc(target)}: ${env.message}`, env.retryable, { subsystem: env.subsystem, help: env.help });
    }
  }

  async fill(target: Target, value: string, fallback?: Fallback, scope?: string, timeoutMs = 5000, opts: { force?: boolean; ignoreVisibility?: boolean } = {}): Promise<ActionResult> {
    const t0 = Date.now();
    const e = this.engine(); if (!e) return this.noSession();

    // BUG-G2 fix: Support force/ignoreVisibility for hidden inputs
    const forceFill = opts.force || opts.ignoreVisibility;

    try {
      await this.refreshIdentity(e);
      // `fillable` mode: the resolver itself now distinguishes "no match" from
      // "matched but not an input", so a probe ref for a textbox and a click ref
      // for a button are resolved by the same code with a different bar.
      const r = await resolveForAction(
        { engine: e, registry: this.refs(), pageId: this.activePageId, documentId: this.docIdCache, revision: this.revisionCache },
        target, fallback, scope, "fillable",
        { allowHidden: forceFill, waitMs: Math.min(timeoutMs, 1500) },
      );
      if (!r.ok) {
        return {
          ok: false,
          timing: { total_ms: Date.now() - t0, resolve_ms: Date.now() - t0, action_ms: 0 },
          error: kruzError(r.code, {
            subsystem: "controller",
            message: `Fill failed for ${this.desc(target)}: ${r.message}`,
            retryable: r.retryable,
            help: r.help,
          }).toJSON(),
          result: r.candidates ? { count: r.candidates.length, candidates: r.candidates } : r.evidence,
        };
      }
      const tResolved = Date.now() - t0;
      this.lastResolveTiming = { resolve_ms: tResolved };
      let el = r.el;

      // BUG-G2: Try to reveal hidden elements before filling
      if (!forceFill) {
        try {
          const isHiddenRes = await e.evaluateOn(el, "(() => { const style = getComputedStyle(this); return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0'; })()").catch(() => ({ ok: false as const }));
          const isHidden = isHiddenRes?.ok ? !!isHiddenRes.result : false;

          if (isHidden) {
            // Look for reveal triggers near the element
            const revealTrigger = await this.findRevealTrigger(e, target, scope);
            if (revealTrigger) {
              await e.click(revealTrigger, { timeoutMs: 1000 }).catch(() => {});
              await e.waitMs(500).catch(() => {}); // Allow reveal animation
            }
          }
        } catch {
          // Ignore reveal detection errors, proceed with original fill
        }
      }

      const editableRes = await e.evaluateOn(el, "(() => (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this.isContentEditable))()").catch(() => ({ ok: false as const }));
      let editable = editableRes?.ok ? !!editableRes.result : false;
      if (!editable) {
        // Twin-element recovery (spotted live in Canva): frameworks render an
        // editable field plus a readonly mirror twin; the resolver may land on
        // the wrong twin while the editable sibling sits next to it. Scan the
        // sibling matches for the first actually-editable one before failing.
        try {
          const cands = await e.queryAll(target, fallback, scope);
          for (const cand of cands.slice(0, 5)) {
            const r2 = await e.evaluateOn(cand, "(() => { const n = this; if (n instanceof HTMLInputElement) return n.type !== 'hidden' && !n.disabled && !n.readOnly; if (n instanceof HTMLTextAreaElement) return !n.disabled && !n.readOnly; return !!n.isContentEditable; })()").catch(() => ({ ok: false as const }));
            if (r2?.ok && !!r2.result) { el = cand; editable = true; break; }
          }
        } catch { /* keep original element, fail below */ }
      }
      if (!editable) {
        return this.err(ErrCode.ELEMENT_NOT_EDITABLE, `Fill failed for ${this.desc(target)}: target resolved to a non-editable element (hidden/disabled/containers are not fillable). Try a target that resolves to an <input>, <textarea>, or [contenteditable].`, false, { subsystem: "controller" });
      }
      await e.fill(el, value, { timeoutMs, force: forceFill });
      this.bump();
      return { ok: true, timing: { total_ms: Date.now() - t0, resolve_ms: tResolved, action_ms: Date.now() - t0 - tResolved }, result: { ref: r.ref, effect_token: r.token } };
    } catch (err) {
      // Recovery ladder via the shared retry policy: re-observe to refresh refs
      // (SPA churn), then re-resolve and write. A non-editable target is terminal
      // and must NOT be retried into a wrong-element write.
      const reobserve = async (): Promise<boolean> => {
        const s = this.getActiveSession();
        if (!s?.engine) return false;
        await s.observer.observe(s.engine, scope, "minimal", true);
        // Escalation budget: re-observe already refreshed refs, so the element is
        // either there now or it isn't. Re-spending the caller's full budget here
        // made an impossible target cost 2x timeout_ms (10s at the default).
        await this.refreshIdentity(e);
        const again = await resolveForAction(
          { engine: e, registry: this.refs(), pageId: this.activePageId, documentId: this.docIdCache, revision: this.revisionCache },
          target, fallback, scope, "fillable", { allowHidden: forceFill, waitMs: Math.min(timeoutMs, 800) },
        );
        if (!again.ok) return false;
        const editable2 = await e.evaluateOn(again.el, "(() => (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this.isContentEditable))()").catch(() => ({ ok: false as const }));
        if (!(editable2?.ok && !!editable2.result)) return false;
        await e.fill(again.el, value, { timeoutMs, force: forceFill });
        this.bump();
        return true;
      };
      try {
        return await withRetry(async () => { throw err; }, {
          retryOn: [ErrCode.TARGET_NOT_FOUND, ErrCode.ELEMENT_NOT_FOUND, ErrCode.STALE_ELEMENT, ErrCode.ELEMENT_NOT_VISIBLE, ErrCode.STALE_REFERENCE, ErrCode.DOCUMENT_CHANGED],
          escalations: [{ name: "re-observe-and-fill", run: reobserve }],
        });
      } catch (final) {
        const env = kruzErrorFromThrown(final, { subsystem: "controller" });
        return this.err(env.code, `Fill failed for ${this.desc(target)}: ${env.message}`, env.retryable, { subsystem: env.subsystem, help: env.help });
      }
    }
  }


  async press(key: string, target?: Target, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      // P1-A correction: an Enter that submits a form (or activates a link) commits
      // its navigation asynchronously. Capturing feedback the instant the key lands
      // reports url_changed=false for a navigation that really is happening — which
      // teaches the model the key "did nothing". Gate on HTML implicit-submission
      // semantics so Enters that CANNOT navigate (textarea newline, non-submittable
      // form, plain typing) pay zero cost, then wait only until the URL actually moves.
      let grace = false;
      let graceFrom = "";
      let resolved: { el: KruzElement } | undefined;
      if (target) resolved = await this.resolve(target, fallback, scope, timeoutMs);
      if (/enter/i.test(key)) {
        grace = resolved ? await this.enterCanNavigate(e, resolved.el) : await this.enterCanNavigate(e);
        if (grace) graceFrom = await e.evaluate("location.href").then(r => (r.ok ? String(r.result) : "")).catch(() => "");
      }
      if (resolved) await e.press(resolved.el, key, { timeoutMs });
      else await e.keyboardPress(key);
      this.bump();
      if (grace && graceFrom) await this.awaitUrlChange(e, graceFrom, 1000);
      return { ok: true };
    } catch (err) { return this.actionErr(`Press "${key}"`, err); }
  }

  /**
   * True when an Enter on this element can navigate, per HTML implicit submission:
   * link activation, submit-button activation, Enter in a text field of a form that
   * has a submit button, or the single-field no-button case. TEXTAREA (newline) and
   * non-submittable forms return false so they never pay the effect-grace window.
   */
  private async enterCanNavigate(e: BrowserEngine, on?: KruzElement): Promise<boolean> {
    const js = `(() => { try {
      const ae = ${on ? "this" : "document.activeElement"};
      if (!ae) return false;
      if (ae.tagName === 'A' && ae.hasAttribute('href')) return true;
      if (ae.tagName !== 'INPUT' && ae.tagName !== 'BUTTON') return false;
      const type = (ae.type || '').toLowerCase();
      if (ae.tagName === 'INPUT' && ['hidden','checkbox','radio','file','reset','button','image','range','color'].includes(type)) return false;
      const form = ae.form || (ae.closest && ae.closest('form'));
      if (!form) return false;
      if (ae.tagName === 'BUTTON' || type === 'submit' || type === 'image') return true;
      const hasSubmit = !!form.querySelector('input[type=submit], input[type=image], button[type=submit], button:not([type])');
      if (hasSubmit) return true;
      const fields = Array.from(form.querySelectorAll('input, textarea, select')).filter(el => { const t = ((el as any).type || '').toLowerCase(); return t !== 'hidden' && !(el as any).disabled; });
      return fields.length === 1;
    } catch { return false; } })()`;
    if (on) { const r = await e.evaluateOn(on, js).catch(() => null); return (r as any)?.result === true; }
    const r = await e.evaluate(js).catch(() => null);
    return (r as any)?.result === true;
  }

  /** Poll until the document URL leaves `initial` (or the cap expires). Best-effort. */
  private async awaitUrlChange(e: BrowserEngine, initial: string, capMs: number): Promise<void> {
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      const r = await e.evaluate("location.href").catch(() => null);
      const href = r && (r as any).ok ? String((r as any).result) : null;
      // A throwing evaluate during teardown still means a navigation is underway —
      // keep polling; the new document will answer with the committed URL.
      if (href && href !== initial) return;
      await e.waitMs(40);
    }
  }

  async pressSequence(keys: string, delayMs = 50): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      for (const key of keys.split(/\s+/).filter(k => k.length > 0)) {
        await e.keyboardPress(key);
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
      this.bump();
      return { ok: true };
    } catch (err) { return this.actionErr("Key sequence", err); }
  }

  // ═══ FORM ═══════════════════════════════════════════════════════════════

  async select(target: Target, options: { value?: string; label?: string; index?: number }, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const criterion = options.value !== undefined ? { value: options.value }
      : options.label !== undefined ? { label: options.label }
      : options.index !== undefined ? { index: options.index }
      : null;
    if (!criterion) return this.err("page.select", "No selection criteria (value, label, or index)", false);

    const applyNative = async (el: KruzElement): Promise<boolean> => {
      // Check whether the resolved element is a native <select>. If it is not,
      // selectOption throws; we detect that and route to the SPA fallback.
      const isNativeRes = await e.evaluateOn(el, "(() => this instanceof HTMLSelectElement)()").catch(() => ({ ok: false as const }));
      const isNative = isNativeRes?.ok ? !!isNativeRes.result : false;
      if (!isNative) return false;
      if (options.value !== undefined) await e.selectOption(el, options.value);
      else if (options.label !== undefined) await e.selectOption(el, options.label);
      else if (options.index !== undefined) {
        const picked = await e.evaluateOn(el, `(() => { const s = this; if (!(s instanceof HTMLSelectElement)) return null; const w = window; w.__kruzAutomationBypass = true; try { const o = s.options[${options.index}]; if (!o || o.disabled) return null; s.selectedIndex = ${options.index}; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); return s.selectedIndex === ${options.index}; } finally { w.__kruzAutomationBypass = false; } })()`).catch(() => ({ ok: false as const }));
        if (!picked?.ok || !(picked.result)) throw new Error(`Option index ${options.index} not found`);
      }
      return true;
    };

    // SPA (react-select / custom combobox) selection: open the menu, then click the
    // matching [role=option]. react-select renders its options in a portal appended to
    // <body>, so search the whole document, not just under the combobox element.
    const applySpa = async (el: KruzElement): Promise<boolean> => {
      const wanted = options.label ?? options.value;
      const expanded = await e.attribute(el, "aria-expanded").catch(() => null);
      if (expanded !== "true") await e.click(el, { timeoutMs });
      let chosen: KruzElement | undefined;
      const deadline = Date.now() + Math.min(timeoutMs, 3000);
      do {
        const controls = await e.attribute(el, 'aria-controls').catch(() => null);
        const candidates = await e.queryAll({ css: '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]' });
        const matches: KruzElement[] = [];
        let visibleIndex = 0;
        for (const candidate of candidates) {
          if (!await e.isVisible(candidate) || !await e.isEnabled(candidate)) continue;
          if (controls) {
            const belongs = await e.evaluateOn(candidate, `(() => { const ids = ${JSON.stringify(controls)}.split(/\\s+/); for (let n=this; n; n=n.parentElement || n.getRootNode()?.host) if(ids.includes(n.id)) return true; return false; })()`);
            if (belongs.result !== true) continue;
          }
          const data = await e.evaluateOn(candidate, "({text:(this.getAttribute('aria-label') || this.textContent || '').trim(),value:this.getAttribute('data-value') || this.getAttribute('value')})");
          const info = data.result as { text?: string; value?: string } | undefined;
          if (wanted !== undefined ? info?.text?.toLowerCase() === wanted.trim().toLowerCase() || info?.value === wanted : visibleIndex === options.index) matches.push(candidate);
          visibleIndex++;
        }
        if (matches.length > 1) throw new Error("Ambiguous dropdown option; use a unique value");
        chosen = matches[0];
        if (chosen) break;
        await e.waitMs(100);
      } while (Date.now() < deadline);
      if (!chosen) return false;
      const chosenData = await e.evaluateOn(chosen, "({text:(this.getAttribute('aria-label') || this.textContent || '').trim(),value:this.getAttribute('data-value') || this.getAttribute('value')})");
      const chosenInfo = chosenData.result as { text?: string; value?: string } | undefined;
      // Radio/check menus can already be selected. Do not toggle them off.
      if (await e.attribute(chosen, 'aria-checked') === 'true') return true;
      await e.click(chosen, { timeoutMs });
      // Dispatch is not proof that a controlled component accepted the selection.
      for (let i = 0; i < 10; i++) {
        const selected = await e.attribute(chosen, "aria-selected").catch(() => null);
        const checked = await e.attribute(chosen, 'aria-checked').catch(() => null);
        const state = await e.evaluateOn(el, "({value:this.value,text:(this.innerText || this.textContent || '').trim()})").catch(() => ({ ok: false, result: null }));
        const info = state.result as { value?: string; text?: string } | null;
        const expected = [wanted, chosenInfo?.value, chosenInfo?.text].filter((v): v is string => v !== undefined && v !== null);
        if (selected === "true" || checked === 'true' || [info?.value, info?.text].some(v => expected.some(w => v?.trim().toLowerCase() === w.trim().toLowerCase()))) { this.bump(); return true; }
        await e.waitMs(100);
      }
      throw new Error("Option click dispatched but selection could not be verified; inspect before retrying");
    };

    try {
      const sel = await this.unified(target, fallback, scope, "clickable", timeoutMs);
      if (!sel.ok) return sel.result;
      const el = sel.el;
      if (await applyNative(el)) { this.bump(); return { ok: true, result: { ref: sel.ref } }; }
      if (await applySpa(el)) return { ok: true, result: { method: "spa-option-click" } };
      const tagRes = await e.tagName(el).catch(() => "");
      return this.actionErr("Select", `target resolved to ${tagRes}; no matching visible option or radio/check menu item was found.`);
    } catch (err) {
      return this.actionErr("Select", err);
    }
  }

  async check(target: Target, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      // Same resolver as click/fill: a probe ref for a checkbox is actionable here.
      const r = await this.unified(target, fallback, scope, "clickable", timeoutMs);
      if (!r.ok) return r.result;
      await e.check(r.el, { timeoutMs });
      this.bump();
      return { ok: true, result: { ref: r.ref } };
    } catch (err) {
      if (target.ref || target.role || target.name || target.text) { try { const s = this.getActiveSession(); if (s?.engine) { await s.observer.observe(this.engine() as any, scope, "minimal", true); const r = await this.unified(target, fallback, scope, "clickable", timeoutMs); if (r.ok) { await e.check(r.el, { timeoutMs }); this.bump(); return { ok: true, result: { ref: r.ref } }; } } } catch { /* fall through */ } }
      return this.actionErr("Check", err, "Tip: if this is a custom SPA checkbox (not <input type=checkbox>), try page_click instead.");
    }
  }

  async uncheck(target: Target, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const un = await this.unified(target, fallback, scope, "clickable", timeoutMs);
      if (!un.ok) return un.result;
      const el = un.el;
      // Try native uncheck first; if it fails (non-native checkbox like custom SPAs),
      // fall back to click + visual toggle detection.
      try {
        await e.uncheck(el, { timeoutMs });
      } catch (uncheckErr) {
        // Detect if element is a non-native checkbox (custom SPA element with checkbox role)
        const isNativeRes = await e.evaluateOn(el, "(() => this instanceof HTMLInputElement && (this.type === 'checkbox' || this.type === 'radio'))()").catch(() => ({ ok: false as const }));
        const isNativeCheckbox = isNativeRes?.ok ? !!isNativeRes.result : false;
        if (!isNativeCheckbox) {
          // SPA "checkbox" — check if it's already unchecked, otherwise click it
          const wasCheckedRes = await e.evaluateOn(el, "(() => { if (this instanceof HTMLInputElement) return this.checked; return this.getAttribute('aria-checked') === 'true' || this.classList.contains('checked'); })()").catch(() => ({ ok: false as const }));
          const wasChecked = wasCheckedRes?.ok ? !!wasCheckedRes.result : false;
          if (wasChecked) {
            await e.click(el, { timeoutMs });
            await e.waitMs(300).catch(() => {});
          }
          this.bump();
          return { ok: true, result: { toggled: wasChecked, was_checked: wasChecked } };
        }
        throw uncheckErr;
      }
      this.bump();
      return { ok: true };
    } catch (err) {
      if (target.ref || target.role || target.name || target.text) { try { const s = this.getActiveSession(); if (s?.engine) { await s.observer.observe(this.engine() as any, scope, "minimal", true); const { el } = await this.resolve(target, fallback, scope, timeoutMs); await e.uncheck(el, { timeoutMs }); this.bump(); return { ok: true }; } } catch { /* fall through */ } }
      return this.actionErr("Uncheck", err, "Tip: if this is a custom SPA checkbox (not <input type=checkbox>), try page_click instead.");
    }
  }

  async submit(target?: Target, fallback?: Fallback, scope?: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      if (target) {
        const { el } = await this.resolve(target, fallback, scope, 3000);
        // Single evaluate: detect type + submit in one round trip
        const resultRes = await e.evaluateOn(el, "(() => { const isSubmit = (this instanceof HTMLButtonElement || this instanceof HTMLInputElement) && this.type === 'submit'; const form = this.closest('form'); if (form) { form.requestSubmit(isSubmit ? this : undefined); return 'submitted'; } return isSubmit ? 'click' : 'enter'; })()").catch(() => ({ ok: false as const }));
        const result = resultRes?.ok ? resultRes.result : "click";
        if (result === "click") await e.click(el, { timeoutMs: 5000 }).catch(() => {});
        else if (result === "enter") await e.press(el, "Enter").catch(() => {});
        this.bump();
        return { ok: true };
      }
      const formEl = await e.queryOne({ css: "form" });
      if (formEl) await e.evaluateOn(formEl, "(() => this.requestSubmit ? this.requestSubmit() : (this.closest('form'))?.requestSubmit?.())()").catch(() => {});
      this.bump();
      return { ok: true };
    } catch (err) {
      if (/navigation|Target page|frame was detached/.test(String(err))) return { ok: true };
      return this.err("page.submit", `Submit failed: ${err}`, true);
    }
  }

  async setSliderValue(target: Target, value: number, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const { el } = await this.resolve(target, fallback, scope, timeoutMs);
      // Range inputs need value set via JS property + native event dispatch
      await e.setSliderValue(el, value);
      this.bump();
      return { ok: true };
    } catch (err) { return this.err("page.setSliderValue", `Slider failed: ${err}`, true); }
  }

  async stepper(target: Target, direction: "up" | "down", fallback?: Fallback, scope?: string, _timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const el = await this.resolveEl(e, target, "input[type='number']", fallback, scope);
      await e.press(el, direction === "up" ? "ArrowUp" : "ArrowDown");
      this.bump();
      return { ok: true };
    } catch (err) { return this.err("page.stepper", `Stepper failed: ${err}`, true); }
  }

  // ═══ SCROLL ═════════════════════════════════════════════════════════════

  async scroll(direction: "up" | "down" | "left" | "right" = "down", amount?: number, target?: Target, fallback?: Fallback): Promise<ActionResult> {
    const t0 = Date.now();
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const amt = amount ?? 500;
      if (target) {
        // Scroll the target's container (itself or nearest scrollable ancestor),
        // not just into view — portal result lists live in inner scroll panes
        // where window scrolling and scroll-into-view do nothing.
        // "query" mode: a scroll target must merely exist, not be clickable, so a
        // probe ref for an off-screen element works here exactly as it does for a
        // click that will scroll to it.
        const sc = await this.unified(target, fallback, undefined, "query", 5000, true);
        if (!sc.ok) return sc.result;
        const tResolved = Date.now() - t0;
        await e.scrollElement(sc.el, direction, amt);
        return { ok: true, timing: { total_ms: Date.now() - t0, resolve_ms: tResolved, action_ms: Date.now() - t0 - tResolved } };
      }
      await e.scrollPage(direction, amt);
      return { ok: true, timing: { total_ms: Date.now() - t0, action_ms: Date.now() - t0 } };
    } catch (err) { return this.err("page.scroll", `Scroll failed: ${err}`, true); }
  }

  async scrollToBottom(sentinelSelector?: string, maxScrolls = 50, waitMs = 1000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      let scrollCount = 0;
      let lastHeight = 0;
      let stableCount = 0;
      const loadMoreClicked: string[] = [];
      const paginationClicked: string[] = [];

      while (scrollCount < maxScrolls) {
        // Scroll down one viewport
        await e.evaluate("(() => window.scrollBy(0, window.innerHeight * 0.8))()").catch(() => {});
        scrollCount++;

        await e.waitMs(waitMs);

        // Check for load more buttons and pagination controls
        const interactionsRes = await e.evaluate(`(() => {
          const results = { loadMoreClicked: [], paginationClicked: [] };
          const loadMoreSelectors = [
            'button:has-text("Load More")', 'button:has-text("Show More")', 'button:has-text("Load more")',
            'button:has-text("See More")', 'button:has-text("View More")', 'a:has-text("Load More")',
            '.load-more', '.show-more', '.view-more', '[data-testid*="load-more" i]',
            'button[class*="load-more" i]', 'button[aria-label*="load more" i]',
          ];
          const paginationSelectors = [
            'button:has-text("Next")', 'a:has-text("Next")', 'button:has-text(">")', 'a:has-text(">")',
            '.pagination .next', '.pager .next', 'button[aria-label*="next" i]',
            '[data-testid*="next" i]', '.next-page', '.page-next',
          ];
          for (const selector of loadMoreSelectors) {
            try {
              const elements = document.querySelectorAll(selector);
              for (const el of elements) {
                const rect = el.getBoundingClientRect();
                const inViewport = rect.top >= 0 && rect.top <= window.innerHeight && rect.bottom >= 0;
                const isVisible = el.offsetParent !== null;
                const isEnabled = !el.disabled;
                if (inViewport && isVisible && isEnabled) {
                  const text = el.textContent?.trim() || selector;
                  try { el.click(); results.loadMoreClicked.push(text); } catch {}
                }
              }
            } catch {}
          }
          for (const selector of paginationSelectors) {
            try {
              const elements = document.querySelectorAll(selector);
              for (const el of elements) {
                const rect = el.getBoundingClientRect();
                const inViewport = rect.top >= 0 && rect.top <= window.innerHeight;
                const isVisible = el.offsetParent !== null;
                const isEnabled = !el.disabled;
                if (inViewport && isVisible && isEnabled) {
                  const text = el.textContent?.trim() || selector;
                  try { el.click(); results.paginationClicked.push(text); } catch {}
                }
              }
            } catch {}
          }
          return results;
        })()`).catch(() => ({ ok: false as const }));
        const interactions = interactionsRes?.ok ? (interactionsRes.result as any) : { loadMoreClicked: [], paginationClicked: [] };

        loadMoreClicked.push(...(interactions?.loadMoreClicked ?? []));
        paginationClicked.push(...(interactions?.paginationClicked ?? []));

        // If we clicked something, wait longer for content to load
        if ((interactions?.loadMoreClicked?.length ?? 0) > 0 || (interactions?.paginationClicked?.length ?? 0) > 0) {
          await e.waitMs(Math.max(waitMs, 2000));
          stableCount = 0; // Reset stability counter
          continue;
        }

        // Check height stability
        const currentHeight = await e.scrollHeight();
        if (currentHeight === lastHeight) {
          stableCount++;
          if (stableCount >= 3) break;
        } else {
          stableCount = 0;
          lastHeight = currentHeight;
        }

        // Check for sentinel element
        if (sentinelSelector) {
          try {
            const sentinelEl = await e.queryOne({ css: sentinelSelector } as any);
            const sentinelVisible = sentinelEl ? await e.isVisible(sentinelEl).catch(() => false) : false;
            if (sentinelVisible) break;
          } catch {} // Continue if sentinel check fails
        }

        // Check if actually at bottom
        const atBottom = await e.evaluate("(() => (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 100))()").then(r => r.ok && !!r.result).catch(() => false);
        if (atBottom && stableCount >= 2) break;
      }

      const finalHeightRes = await e.evaluate("(() => document.body.scrollHeight)()").catch(() => ({ ok: false as const }));
      return {
        ok: true,
        result: {
          scrollsPerformed: scrollCount,
          finalHeight: finalHeightRes?.ok ? finalHeightRes.result : 0,
          loadMoreClicked: loadMoreClicked.length,
          paginationClicked: paginationClicked.length,
          interactions: { loadMore: loadMoreClicked, pagination: paginationClicked },
        },
      };
    } catch (err) { return this.err("page.scrollToBottom", `Scroll to bottom failed: ${err}`, true); }
  }

  // ═══ HOVER ═════════════════════════════════════════════════════════════

  async hover(target: Target, fallback?: Fallback, scope?: string, timeoutMs = 5000, dwellMs = 0): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const { el } = await this.resolve(target, fallback, scope, timeoutMs);
      await e.hover(el, { timeoutMs, dwellMs });
      if (dwellMs > 0) await new Promise(r => setTimeout(r, dwellMs));
      return { ok: true };
    } catch (err) { return this.err("page.hover", `Hover failed: ${err}`, true); }
  }

  // ═══ WAIT ══════════════════════════════════════════════════════════════

  async wait(condition: string, target?: Target, fallback?: Fallback, scope?: string, timeoutMs = 30000, predicate?: string, intervalMs = 250): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    // K1: networkidle NEVER resolves on SPAs with WebSockets. Convert to domcontentloaded.
    // K18: networkidle NEVER resolves on SPAs with WebSockets (Oracle HCM, Snowflake, Workday).
    // Cap at 10s to prevent MCP SDK -32001 timeout. Convert to domcontentloaded which always completes.
    const effectiveCondition = condition === "networkidle" ? "domcontentloaded" : condition;
    const effectiveTimeout = effectiveCondition === "domcontentloaded" ? Math.min(timeoutMs, 10000) : timeoutMs;
    try {
      switch (effectiveCondition) {
        case "load": case "domcontentloaded":
          // K30: waitForLoadState now polls document.readyState — a real state check — instead of
          // waitForNavigation, which could never resolve on an already-loaded page.
          await e.waitForLoadState(effectiveCondition as any, effectiveTimeout); break;
        case "content": {
          // K30: poll-for-real-content — repeatedly evaluate a JS predicate in-page every
          // `intervalMs` until truthy or timeout.
          // P0-A: settled-aware. If the predicate stays false while the page has stopped
          // mutating (document interactive + no DOM mutations for the settle window), fail
          // EARLY instead of burning the full budget — the page is not transitioning toward
          // the requested state. The hard timeout is now the last resort, not the norm.
          const js = predicate || "document.body?.innerText?.trim().length > 10";
          const r = await e.waitForSettled(js, { timeoutMs, intervalMs, settleMs: 700, minWaitMs: 1500 });
          if (!r.met) {
            if (r.settled) {
              return {
                ok: false,
                error: kruzError(ErrCode.CONDITION_NOT_MET, {
                  subsystem: "controller",
                  retryable: false,
                  message: `Content predicate not met after ${r.elapsedMs}ms and the page has settled (no DOM mutations for 700ms): ${js}`,
                  help: "The page is not transitioning toward this condition. Re-observe what IS present, or use page.probe to check the current DOM. Do not re-wait for the same predicate.",
                  trace: ["controller"],
                }).toJSON(),
                result: { attempts: r.attempts, elapsed_ms: r.elapsedMs, settled: true },
              };
            }
            throw new Error(`Content predicate not satisfied within ${timeoutMs}ms: ${js}`);
          }
          break;
        }
        case "element": {
          if (!target) return this.err("page.wait", "Target required for element wait", false);
          const el = await tryResolveElement(e, target, fallback, scope, timeoutMs);
          if (!el) throw new Error("Element not visible");
          break;
        }
        case "hidden": {
          if (!target) return this.err("page.wait", "Target required for hidden wait", false);
          await e.waitForSelector(target, { state: "hidden", timeoutMs }); break;
        }
        case "navigation": await e.waitForNavigation(timeoutMs); break;
        case "timeout": await new Promise(r => setTimeout(r, timeoutMs)); break;
        default: return this.err("page.wait", `Unknown condition: ${condition}`, false);
      }
      return { ok: true };
    } catch (err) { return this.err("page.wait", `Wait failed (${condition}): ${err}`, true); }
  }

  // ═══ DRAG & DROP ════════════════════════════════════════════════════════

  async drag(s: Target, d: Target, sf?: Fallback, df?: Fallback, scope?: string, _timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const rm = this.getRefMap();
      const srcEl = (await resolveElementWithRef(e, s, rm, sf, scope)).el;
      const dstEl = (await resolveElementWithRef(e, d, rm, df, scope)).el;
      if (!srcEl || !dstEl) return this.err("page.drag", "Source or dest not visible", false);
      const [src, dst] = await Promise.all([e.boundingBox(srcEl), e.boundingBox(dstEl)]);
      if (!src || !dst) return this.err("page.drag", "Source or dest not visible", false);
      const sx = src.x + src.width / 2, sy = src.y + src.height / 2;
      const dx = dst.x + dst.width / 2, dy = dst.y + dst.height / 2;
      await e.mouseMove(sx, sy);
      await e.mouseDown();
      for (let i = 1; i <= 10; i++) {
        await e.mouseMove(sx + (dx - sx) * (i / 10), sy + (dy - sy) * (i / 10));
        await new Promise(r => setTimeout(r, 20));
      }
      await e.mouseUp();
      this.bump();
      return { ok: true };
    } catch (err) { return this.err("page.drag", `Drag failed: ${err}`, true); }
  }

  async html5Drag(s: Target, d: Target, sf?: Fallback, df?: Fallback, scope?: string, _timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const rm = this.getRefMap();
      const srcEl = (await resolveElementWithRef(e, s, rm, sf, scope)).el;
      const dstEl = (await resolveElementWithRef(e, d, rm, df, scope)).el;
      if (!srcEl || !dstEl) return this.err("page.html5Drag", "Source or dest not visible", false);
      await e.html5Drag(srcEl, dstEl);
      this.bump();
      return { ok: true };
    } catch (err) { return this.err("page.html5Drag", `HTML5 drag failed: ${err}`, true); }
  }

  // ═══ DIALOGS ═══════════════════════════════════════════════════════════

  async dialog(action: "accept" | "dismiss", value?: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const pending = await e.nextDialog().catch(() => null);
    if (pending) {
      try {
        await e.handleDialog(action, action === "accept" && pending.type === "prompt" ? value : undefined);
        return { ok: true, result: { type: pending.type, message: pending.message } };
      } catch (err) { return this.err("page.dialog", `Dialog handling failed: ${err}`, false); }
    }
    return { ok: true, result: { pending: false, message: "No pending dialog." } };
  }

  // ═══ JS EVALUATION ═════════════════════════════════════════════════════

  async evaluate(expression: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const r = await e.evaluate(expression);
      this.bump();
      return r.ok ? { ok: true, result: r.result } : this.err("page.evaluate", r.error || "Evaluation failed", false);
    } catch (err) { return this.err("page.evaluate", `JS eval failed: ${err}`, true); }
  }

  async readVariable(name: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const partsJson = JSON.stringify(name.split("."));
      const r = await e.evaluate(`(() => { const parts = ${partsJson}; let val = window; for (const part of parts) { if (val == null) return null; val = val[part]; } if (val === undefined || val === null) return null; if (typeof val === "function") return val.toString(); if (typeof val === "object") { try { return JSON.parse(JSON.stringify(val)); } catch { return String(val); } } return val; })()`);
      const result = r.ok ? r.result : null;
      return { ok: true, result: result ?? null };
    } catch (err) { return this.err("page.readVariable", `Failed to read "${name}": ${err}`, true); }
  }

  // ═══ CONSOLE & NETWORK ═════════════════════════════════════════════════

  /** Merge engine-captured console/network events into the controller's local arrays. */
  private syncCapture(engine?: BrowserEngine | null): void {
    if (!engine) return;
    try {
      for (const ev of engine.drainConsoleEvents() ?? []) {
        this.consoleLogs.push(`[${ev.type}] ${ev.text}`);
        if (this.consoleLogs.length > 500) this.consoleLogs.splice(0, this.consoleLogs.length - 500);
      }
    } catch { /* ignore */ }
    try {
      for (const ev of engine.drainNetworkEvents() ?? []) {
        this.networkRequests.push({ url: ev.url, method: ev.method, status: ev.status, contentType: ev.contentType, body: ev.body, truncated: ev.truncated });
        if (this.networkRequests.length > 500) this.networkRequests.splice(0, this.networkRequests.length - 500);
      }
    } catch { /* ignore */ }
  }

  getConsoleLogs(filter?: string): string[] {
    this.syncCapture(this.engine());
    if (!filter) return this.consoleLogs;
    const re = new RegExp(filter, "i");
    return this.consoleLogs.filter(l => re.test(l));
  }

  getNetworkRequests(filter?: string) {
    this.syncCapture(this.engine());
    if (!filter) return this.networkRequests;
    const re = new RegExp(filter, "i");
    return this.networkRequests.filter(r => re.test(r.url));
  }

  /**
   * Return the captured response body for a network URL matching the filter.
   * Returns the first match that has a body; otherwise returns the request/status
   * metadata for the first URL match so the caller knows the request happened.
   */
  getNetworkBody(filter: string) {
    this.syncCapture(this.engine());
    const re = new RegExp(filter, "i");
    const hit = this.networkRequests.find(r => re.test(r.url) && r.body !== undefined);
    if (hit) return { url: hit.url, method: hit.method, status: hit.status, contentType: hit.contentType, truncated: hit.truncated ?? false, body: hit.body };
    const meta = this.networkRequests.find(r => re.test(r.url));
    if (meta) return { url: meta.url, method: meta.method, status: meta.status, contentType: meta.contentType, body: undefined, note: "Request seen but no JSON/XML body captured for this URL." };
    return null;
  }

  /** Enable/disable automatic capture of JSON/XML response bodies (for ATS feed enumeration). */
  setCaptureBodies(on: boolean): void {
    this.captureResponseBodies = on;
    const e = this.engine();
    if (e) this.listen(e).catch(() => {});
  }
  getCaptureBodies(): boolean { return this.captureResponseBodies; }

  // ═══ IFRAMES ═══════════════════════════════════════════════════════════

  async getFrames() {
    const e = this.engine();
    if (!e) return [];
    const frames = await e.frames();
    return frames.map((f, i) => ({ index: i, name: f.name, url: f.url, isMain: f.isMain }));
  }

  // ═══ FRAME-SCOPED TOOLS ════════════════════════════════════════════════

  /**
   * Get an engine Frame by name or URL pattern.
   * The engine bypasses same-origin policy for cross-origin frames.
   */
  private async getFrame(e: BrowserEngine, frameName?: string, frameUrl?: string) {
    if (frameName) {
      return e.frameBy(frameName);
    }
    if (frameUrl) {
      return e.frameBy(undefined, frameUrl);
    }
    // Default: find icims_content_iframe if present
    const icimsFrame = await e.frameBy("icims_content_iframe");
    if (icimsFrame) return icimsFrame;
    // Fallback: find first non-main frame
    const frames = await e.frames();
    const nonMain = frames.find(f => !f.isMain);
    return nonMain ?? null;
  }

  /**
   * Execute JavaScript in a specific frame context.
   * The engine bypasses CORS — this works even on cross-origin iframes.
   */
  async frameEvaluate(expression: string, frameName?: string, frameUrl?: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const frame = await this.getFrame(e, frameName, frameUrl);
      if (!frame) return this.err(ErrCode.TARGET_NOT_FOUND, "No matching frame found. Call page.observe to list frames, then pass frame_name or frame_url.", true, { subsystem: "engine" });
      const r = await e.evaluateInFrame(frame.id, expression);
      this.bump();
      return { ok: true, result: { value: r.ok ? r.result : undefined, frame: { name: frame.name, url: frame.url } } };
    } catch (err) {
      return this.actionErr("Frame evaluate", err);
    }
  }

  /**
   * Extract links from a specific frame.
   */
  async frameExtractLinks(frameName?: string, frameUrl?: string, filter?: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const frame = await this.getFrame(e, frameName, frameUrl);
      if (!frame) return this.err(ErrCode.TARGET_NOT_FOUND, "No matching frame found. Call page.observe to list frames, then pass frame_name or frame_url.", true, { subsystem: "engine" });
      const filterJson = JSON.stringify(filter || "");
      const r = await e.evaluateInFrame(frame.id, `(() => { const filt = ${filterJson}; const anchors = Array.from(document.querySelectorAll('a[href]')); return anchors.filter(a => !filt || (a.getAttribute('href') || '').includes(filt)).map(a => ({ text: (a.textContent || '').trim().split('\\n')[0].substring(0, 200), href: a.getAttribute('href') || '', visible: a.offsetParent !== null })); })()`);
      const links = r.ok && Array.isArray(r.result) ? (r.result as any[]) : [];
      this.bump();
      return { ok: true, result: { links, count: links.length, frame: { name: frame.name, url: frame.url } } };
    } catch (err) {
      return this.actionErr("Frame extract links", err);
    }
  }

  /**
   * Observe elements in a specific frame (compact view).
   */
  async frameObserve(frameName?: string, frameUrl?: string, detail: "minimal" | "standard" | "full" = "minimal"): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const frame = await this.getFrame(e, frameName, frameUrl);
      if (!frame) return this.err(ErrCode.TARGET_NOT_FOUND, "No matching frame found. Call page.observe to list frames, then pass frame_name or frame_url.", true, { subsystem: "engine" });
      const r = await e.evaluateInFrame(frame.id, `(() => { const els = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role], h1, h2, h3')); return els.slice(0, 80).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text: (el.textContent || '').trim().substring(0, 120), href: el.href || '', type: el.type || '', name: el.getAttribute('name') || '', visible: el.offsetParent !== null })); })()`);
      const data = r.ok && Array.isArray(r.result) ? (r.result as any[]) : [];
      this.bump();
      return { ok: true, result: { elements: data, count: data.length, frame: { name: frame.name, url: frame.url } } };
    } catch (err) {
      return this.actionErr("Frame observe", err);
    }
  }

  // ═══ FILE UPLOAD ═══════════════════════════════════════════════════════

  async uploadFile(target: Target, filePaths: string[], fallback?: Fallback, scope?: string, _timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const el = await this.resolveEl(e, target, "input[type='file']", fallback, scope);
      await e.setFiles(el, filePaths);
      this.bump();
      return { ok: true };
    } catch (err) { return this.err("page.uploadFile", `File upload failed: ${err}`, true); }
  }

  // ═══ COORDINATE CLICKS ═════════════════════════════════════════════════

  async clickAt(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      await (e as any).rememberCursor?.({ x, y });
      await e.mouseClick(x, y, { button });
      return { ok: true };
    }
    catch (err) { return this.err("page.clickAt", `Click at (${x},${y}) failed: ${err}`, true); }
  }

// ── Computer-use (text-only CUA bridge) ─────────────────────────────
// See src/browser/computer-use.ts. Exposes DOM element coordinates as
  // plain JSON so a text model can ground itself without vision. Pair with
  // page.clickAt / page.type / page.scroll for the actual actions.

  async computerUseList(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const { listTargetsJS } = await import("./computer-use.js");
    const r = await e.evaluate(`(${listTargetsJS.toString()})()`);
    this.bump();
    if (!r.ok) return this.err("page.computerUseList", r.error ?? "eval failed", true);
    return { ok: true, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result };
  }

  async computerUseSnapshot(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const { snapshotJS } = await import("./computer-use.js");
    const r = await e.evaluate(`(${snapshotJS.toString()})()`);
    this.bump();
    if (!r.ok) return this.err("page.computerUseSnapshot", r.error ?? "eval failed", true);
    return { ok: true, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result };
  }

  async computerUseMark(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const { markTargetsJS } = await import("./computer-use.js");
    const r = await e.evaluate(`(${markTargetsJS.toString()})()`);
    this.bump();
    if (!r.ok) return this.err("page.computerUseMark", r.error ?? "eval failed", true);
    return { ok: true, result: { message: r.result } };
  }

  async computerUseClearMarks(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const { clearMarksJS } = await import("./computer-use.js");
    const r = await e.evaluate(`(${clearMarksJS.toString()})()`);
    this.bump();
    if (!r.ok) return this.err("page.computerUseClearMarks", r.error ?? "eval failed", true);
    return { ok: true, result: { message: r.result } };
  }

  async computerUseScrollTo(i: number): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    if (typeof i !== "number" || !Number.isFinite(i) || i < 0) {
      return this.err("page.computerUseScrollTo", `i must be a non-negative integer (got ${i})`, false);
    }
    const { scrollToTargetJS } = await import("./computer-use.js");
    const r = await e.evaluate(`(${scrollToTargetJS.toString()})(${i})`);
    this.bump();
    if (!r.ok) return this.err("page.computerUseScrollTo", r.error ?? "eval failed", true);
    return { ok: true, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result };
  }

  // ═══ NATIVE PICKERS ════════════════════════════════════════════════════

  async setDate(target: Target, date: string, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try { const { el } = await this.resolve(target, fallback, scope, timeoutMs); await e.fill(el, date, { timeoutMs }); this.bump(); return { ok: true }; }
    catch (err) { return this.err("page.setDate", `Date set failed: ${err}`, true); }
  }

  async setColor(target: Target, color: string, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try { const { el } = await this.resolve(target, fallback, scope, timeoutMs); await e.fill(el, color, { timeoutMs }); this.bump(); return { ok: true }; }
    catch (err) { return this.err("page.setColor", `Color set failed: ${err}`, true); }
  }

  // ═══ SCREENSHOT ════════════════════════════════════════════════════════

  async screenshot(target?: Target, fallback?: Fallback, scope?: string, filePath?: string, fullPage = false): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      if (target) {
        const { el } = await this.resolve(target, fallback, scope, 5000);
        const buf = await e.screenshotElement(el, { path: filePath });
        return { ok: true, result: filePath ? { path: filePath } : { base64: buf.toString("base64") } };
      }
      const buf = await e.screenshot({ fullPage, path: filePath });
      return { ok: true, result: filePath ? { path: filePath } : { base64: buf.toString("base64") } };
    } catch (err) { return this.err("page.screenshot", `Screenshot failed: ${err}`, true); }
  }

  /**
   * BUG-G2 helper: Find potential reveal triggers near a hidden element.
   * Common patterns: search icons, expand buttons, click-to-reveal controls.
   */
  private async findRevealTrigger(engine: BrowserEngine, target: Target, scope?: string): Promise<KruzElement | null> {
    try {
      const scopeJson = JSON.stringify(scope ?? "");
      const r = await engine.evaluate(`(() => { const scopeSelector = ${scopeJson} || null; const container = scopeSelector ? document.querySelector(scopeSelector) : document.body; if (!container) return null; const candidates = Array.from(container.querySelectorAll('button[aria-label*="search" i], button[title*="search" i], button[class*="search" i], .search-icon, .search-btn, .search-trigger, [role="button"][aria-label*="search" i], .input-group-btn button, .input-group .btn')); const inputs = Array.from(container.querySelectorAll('input[type="search"], input[type="text"], .search-input')); for (const input of inputs) { const style = getComputedStyle(input); if (style.display === 'none' || style.visibility === 'hidden') { const inputRect = input.getBoundingClientRect(); const nearby = candidates.filter(btn => { const btnRect = btn.getBoundingClientRect(); const d = Math.sqrt(Math.pow(btnRect.x - inputRect.x, 2) + Math.pow(btnRect.y - inputRect.y, 2)); return d <= 100; }); if (nearby.length > 0) return true; } } return candidates.length > 0; })()`).catch(() => ({ ok: false as const }));
      if (r.ok && r.result) {
        return await engine.queryOne({ css: 'button[aria-label*="search" i], button[title*="search" i], .search-icon, .search-btn, .search-trigger, [role="button"][aria-label*="search" i]' }, undefined, scope, 250).catch(() => null);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Explicit bounded overlay dismissal with coherent, evidence-backed reporting.
   *
   * Rewritten after the manual report found the old scanner structurally blind:
   * it recognised a banner only by class/id tokens and a fixed English label
   * regex, so a page whose consent banner never says "cookie" in a class name
   * produced "no safe dismiss control" 9 times, "still visible after dismissal"
   * 6 times and "scan budget reached" 6 times — three contradictory stories in a
   * single response, with no candidates to pivot to.
   *
   * Now:
   *   - discovery is SEMANTIC and shares the observer's notion of an element
   *   - the strategy escalates; it never re-runs a failed one
   *   - a dismissal counts only when the control or its overlay root actually
   *     disappears (so no follow-up `page.probe` is needed)
   *   - a failure returns the candidates it DID find, with real refs
   */
  async handleOverlays(opts: {
    close_cookie_banner?: boolean;
    close_newsletter_popup?: boolean;
    close_chat_widget?: boolean;
    close_app_prompt?: boolean;
    handle_js_alerts?: boolean;
    /** Optional hint: restrict discovery to a region (e.g. a container selector). */
    scope?: string;
    /** Optional hint: the exact control the model already knows about. */
    target?: Target;
  } = {}): Promise<ActionResult> {
    const e = this.engine();
    if (!e) return this.noSession();

    const kinds: string[] = [];
    if (opts.close_cookie_banner !== false) kinds.push("cookie");
    if (opts.close_newsletter_popup !== false) kinds.push("newsletter");
    if (opts.close_chat_widget !== false) kinds.push("chat");
    if (opts.close_app_prompt !== false) kinds.push("app");
    if (kinds.length === 0) kinds.push("cookie");

    const started = Date.now();
    try {
      const { discoverOverlays, dismissViaControl } = await import("./overlays.js");
      const dismissed: string[] = [];
      const dismissedControls: string[] = [];
      const failed: string[] = [];
      const attempts: Array<{ strategy: string; control: string; intent: string; outcome: string; note?: string }> = [];
      let candidates: Array<Record<string, unknown>> = [];
      let regionCandidates: Array<Record<string, unknown>> = [];
      let terminalReason: string | null = null;
      let region: string | null = null;

      if (opts.handle_js_alerts !== false) {
        const pending = await e.nextDialog();
        if (pending) {
          await e.handleDialog("dismiss");
          dismissed.unshift(`JS dialog dismissed: ${pending.message}`);
        }
      }

      // An explicit hint is an escalation, not a replacement: it only runs when
      // automatic discovery came up empty or could not close anything.
      const hinted: string[] = [];
      if (opts.target) {
        const r = await this.unified(opts.target, undefined, opts.scope, "clickable", 1200, true);
        if (r.ok) {
          const label = opts.target.name || opts.target.text || opts.target.css || opts.target.role || "hinted control";
          const out = await dismissViaControl(e, label, "close", "hint");
          attempts.push(...out.attempts);
          if (out.dismissed) { dismissed.push("hint"); dismissedControls.push(label); }
          else failed.push(label);
        }
      } else {
        const discovery = await discoverOverlays(e, kinds);
        region = discovery.region;
        candidates = discovery.candidates as unknown as Array<Record<string, unknown>>;
        // Controls seen inside the region but WITHOUT a dismissal intent. Kept so
        // the refusal path can offer them: a region whose controls are all
        // unrecognised is exactly the case where the caller needs to see them and
        // decide, rather than be told only that nothing was clickable.
        regionCandidates = (discovery.region_controls as unknown as Array<Record<string, unknown>>) ?? [];
        const clearedRegions = new Set<string>();

        // Bounded escalation. Each candidate is a DIFFERENT control, so a failure
        // escalates to new information rather than repeating a strategy that
        // already failed. A control that has vanished means its region is already
        // gone, which closes that region out.
        const usable = candidates.filter((c) => (c as any).actionable !== false).slice(0, 6);
        for (let i = 0; i < usable.length; i++) {
          const c = usable[i];
          const label = String(c.label ?? c.name ?? "");
          if (!label) continue;
          const out = await dismissViaControl(e, label, (c.intent as any) ?? "close", region, i);
          attempts.push(...out.attempts);
          if (out.dismissed) {
            // Report the overlay KIND (the stable contract consumers rely on) and
            // keep the control label alongside it, so the result is both
            // compatible and more useful.
            const kind = kindOfIntent((c.intent as any) ?? "close", (c as any).region_kind);
            if (!dismissed.includes(kind)) dismissed.push(kind);
            dismissedControls.push(label);
            clearedRegions.add(String((c as any).container ?? kind));
            continue;
          }
          if (attempts[attempts.length - 1]?.outcome === "control_not_found") {
            clearedRegions.add(String((c as any).container ?? ""));
          }
          // A control that was clicked and did not dismiss anything is NOT pushed
          // here: the region-level accounting below reports every region still
          // standing, exactly once, so the counts cannot contradict each other.
        }

        // One failure entry per overlay region that is still present, whether or
        // not it exposed a usable control. Keeping the old per-region accounting
        // makes "0 dismissed, N unresolved" mean something.
        for (const r of discovery.regions) {
          if (!clearedRegions.has(r.label) && r.label) failed.push(r.label || r.kind);
        }

        if (dismissed.length === 0 && candidates.length === 0) {
          terminalReason = discovery.detected
            ? "An overlay region was detected but none of its controls has a safe, recognisable dismissal intent (reject / close / dismiss / manage preferences). Nothing was clicked."
            : "No cookie, consent, newsletter, chat or app overlay is present in the current DOM. Nothing was clicked.";
        } else if (dismissed.length === 0) {
          terminalReason = `Found ${candidates.length} overlay control(s) but none of the ${attempts.length} attempted click(s) removed the control or its overlay region.`;
        }
      }

      const discoveryMs = attempts.length ? 0 : 0;
      const summary = `Dismissed ${dismissed.length} overlay(s), ${failed.length} unresolved`;
      return {
        ok: dismissed.length > 0 || (failed.length === 0 && candidates.length === 0),
        // REFUSAL, not failure: the overlay was DETECTED — that part succeeded —
        // but nothing was dismissed safely. Returning a typed envelope here is
        // what lets the agent branch on code/retryable instead of guessing, and
        // it makes the refusal RESOLVE (see isFailure in router.ts) rather than
        // throwing, so `if (!r.ok)` remains reachable.
        error: dismissed.length > 0 || (failed.length === 0 && candidates.length === 0) ? undefined : kruzError(ErrCode.OVERLAY_NO_DISMISS_INTENT, { subsystem: "overlay", retryable: false, message: terminalReason || summary, trace: ["controller:page.handleOverlays"] }).toJSON(),
        result: {
          dismissed,
          dismissed_controls: dismissedControls,
          failed,
          summary,
          detected_overlay: region !== null || candidates.length > 0,
          attempts,
          candidates,
          region_candidates: regionCandidates,
          terminal_reason: terminalReason,
          region,
          discovery_attempts: attempts.length,
          timing: { discovery_ms: discoveryMs, dismissal_ms: Date.now() - started, total_ms: Date.now() - started },
        },
      };
    } catch (err) {
      return this.err("page.handleOverlays", `Overlay handling failed: ${err}`, false);
    }
  }


  /**
   * Enhanced pagination handler specifically for job portals and search results.
   * Handles both infinite scroll and traditional pagination patterns.
   */
  async paginate(opts: { max_pages?: number; wait_ms?: number; load_more_selector?: string; next_selector?: string; infinite_scroll?: boolean; budget_ms?: number } = {}): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const maxPages = opts.max_pages ?? 10;
    const waitMs = opts.wait_ms ?? 1000;
    const useInfiniteScroll = opts.infinite_scroll !== false;
    // P0-C/P1-E: bounded by the caller's route budget, and steps are effect-verified
    // (the interaction snapshot must change) instead of blindly clicking + sleeping.
    const budgetMs = Math.max(1000, opts.budget_ms ?? 20000);
    const started = Date.now();
    const remaining = () => budgetMs - (Date.now() - started);

    try {
      let currentPage = 1;
      const clickedElements: string[] = [];
      let totalResults = 0;
      let reason: "max_pages" | "no_more_content" | "budget_exhausted" | "step_failed" = "no_more_content";

      const interactionSnapshot = async (): Promise<string> => {
        const r = await e.evaluate(`(() => { const b = document.body; return (b ? b.innerText.length : 0) + ':' + document.querySelectorAll('a,button,li,[role="listitem"],[role="row"],tr').length; })()`).catch(() => ({ ok: false as const }));
        return r.ok ? String(r.result) : "unknown";
      };
      const effectConfirmed = async (before: string): Promise<boolean> => {
        const deadline = Date.now() + Math.max(600, waitMs);
        while (Date.now() < deadline) {
          await e.waitMs(150).catch(() => {});
          if (await interactionSnapshot() !== before) return true;
        }
        return false;
      };

      while (currentPage <= maxPages) {
        if (remaining() < (waitMs + 800)) { reason = "budget_exhausted"; break; }
        const before = await interactionSnapshot();

        // Try specific load more selector first
        if (opts.load_more_selector) {
          try {
            const loadMore = await e.queryOne({ css: opts.load_more_selector });
            if (loadMore && await e.isVisible(loadMore)) {
              await e.click(loadMore, { timeoutMs: 3000 });
              const changed = await effectConfirmed(before);
              clickedElements.push(`Load More (${opts.load_more_selector})`);
              currentPage++;
              if (!changed) { reason = "no_more_content"; break; }
              continue;
            }
          } catch { /* fall through to generic detection */ }
        }

        // Try specific next selector
        if (opts.next_selector) {
          try {
            const next = await e.queryOne({ css: opts.next_selector });
            if (next && await e.isVisible(next)) {
              const enabledRes = await e.evaluateOn(next, "(() => !(this.disabled) && !this.classList.contains('disabled'))()");
              const isEnabled = enabledRes.ok && !!enabledRes.result;
              if (isEnabled) {
                await e.click(next, { timeoutMs: 3000 });
                const changed = await effectConfirmed(before);
                clickedElements.push(`Next (${opts.next_selector})`);
                currentPage++;
                if (!changed) { reason = "no_more_content"; break; }
                continue;
              }
            }
          } catch { /* fall through to generic detection */ }
        }

        // Generic pagination detection
        const paginationResultRes = await e.evaluate(`(() => {
          const result = { clicked: false, element: '', method: '' };
          const loadMoreSelectors = [
            'button:has-text("Load More")', 'button:has-text("Show More")',
            '.load-more:not(.disabled)', 'button[data-testid*="load-more" i]',
          ];
          for (const selector of loadMoreSelectors) {
            try {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null && !el.disabled) {
                el.click();
                result.clicked = true;
                result.element = el.textContent?.trim() || selector;
                result.method = 'load_more';
                return result;
              }
            } catch {}
          }
          const nextSelectors = [
            '.pagination .next:not(.disabled)', 'button:has-text("Next"):not(:disabled)',
            'a:has-text("Next")', 'button:has-text(">"):not(:disabled)',
          ];
          for (const selector of nextSelectors) {
            try {
              const el = document.querySelector(selector);
              if (el && el.offsetParent !== null && !el.classList.contains('disabled')) {
                el.click();
                result.clicked = true;
                result.element = el.textContent?.trim() || selector;
                result.method = 'pagination_next';
                return result;
              }
            } catch {}
          }
          return result;
        })()`).catch(() => ({ ok: false as const }));
        const paginationResult = paginationResultRes?.ok ? (paginationResultRes.result as any) : { clicked: false, element: '', method: '' };

        if (paginationResult?.clicked) {
          const changed = await effectConfirmed(before);
          clickedElements.push(`${paginationResult.element} (${paginationResult.method})`);
          currentPage++;
          if (!changed) { reason = "no_more_content"; break; }
        } else {
          if (useInfiniteScroll && currentPage === 1) {
            const scrollResult = await this.scrollToBottom(undefined, 5, waitMs);
            if (scrollResult.ok) break;
          }
          reason = "no_more_content";
          break;
        }
      }
      if (currentPage > maxPages) reason = "max_pages";

      return {
        ok: true,
        result: {
          pagesProcessed: currentPage - 1,
          totalInteractions: clickedElements.length,
          clickedElements,
          terminated: reason,
          partial: reason === "budget_exhausted",
          elapsed_ms: Date.now() - started,
          remaining_budget_ms: Math.max(0, remaining()),
        },
      };
    } catch (err) {
      return this.err("page.paginate", `Pagination failed: ${err}`, true);
    }
  }

  // ═══ v1.6 GENERIC-SITE TOOLS ═══════════════════════════════════════════
  // These are the additions for the v1.6 generic-navigation prompt
  // (kruz-v1.6-generic-navigation.md). Each addresses a real gap found in
  // Part 1's stress-test of the generic tools against non-career-portal sites.

  /**
   * Site-structure probe — Part 2 of the v1.6 prompt. Returns an honest signal
   * to the calling agent about what kind of site it's looking at, so the agent
   * knows whether it can apply the same reliability as a well-tested ATS or
   * whether it should treat results with extra scrutiny.
   */
  async siteStructure(): Promise<ActionResult> {
    const e = this.engine();
    if (!e) return this.noSession();
    try {
      const url = await e.url();
      const html = await e.content().catch(() => "");
      const { detectATS } = await import("./ats-detector.js");
      const atsResult = detectATS(url, html);

      // Lightweight site-classification heuristics — these are deliberately
      // conservative and rely on multiple signals so they don't misfire.
      const probeRes = await e.evaluate(`(() => {
        const body = document.body?.innerText?.trim() ?? "";
        const bodyLen = body.length;
        const links = Array.from(document.querySelectorAll("a[href]"));
        const internalLinks = links.filter((a) => { try { return new URL(a.href).hostname === location.hostname; } catch { return false; } });
        const linkTexts = internalLinks.map((a) => (a.textContent || "").trim().toLowerCase()).filter((t) => t.length > 0);
        const applyCount = linkTexts.filter((t) => /apply|job[- ]?id|posted|view[- ]?job|see[- ]?job/i.test(t)).length;
        const jobCardHeuristics = document.querySelectorAll('[class*="job"], [class*="vacancy"], [class*="posting"], [class*="position"]').length;
        const looksLikeJobBoard = applyCount >= 5 || jobCardHeuristics >= 10;
        const postHeuristics = document.querySelectorAll('article, [class*="post"], [class*="tweet"], [class*="comment"]').length;
        const replyHeuristics = document.querySelectorAll('[class*="reply"], [class*="replie"]').length;
        const looksLikeSocial = postHeuristics >= 5 && applyCount < 2;
        const interactiveCount = document.querySelectorAll("button, input, select, textarea, [role=button]").length;
        const looksLikeKnowledge = bodyLen > 5000 && interactiveCount < 30 && postHeuristics < 5;
        const passwordField = !!document.querySelector('input[type="password"], input[autocomplete="current-password"]');
        const emailField = !!document.querySelector('input[type="email"], input[autocomplete="username"], input[name*="email" i], input[name*="user" i]');
        const looksLikeLoginWall = passwordField && emailField && bodyLen < 2000;
        return {
          bodyLen, linkCount: links.length, internalLinkCount: internalLinks.length,
          interactiveCount, applyCount, jobCardHeuristics, postHeuristics, replyHeuristics,
          passwordField, emailField, looksLikeJobBoard, looksLikeSocial, looksLikeKnowledge, looksLikeLoginWall,
        };
      })()`).catch(() => ({ ok: false as const }));
      const probe = probeRes?.ok ? (probeRes.result as any) : null;

      // Site-class summary — exactly one wins (priority order: login-wall > job-board > social > knowledge > generic).
      let siteClass: "login-wall" | "job-board" | "social" | "knowledge" | "generic" = "generic";
      if (probe?.looksLikeLoginWall) siteClass = "login-wall";
      else if (probe?.looksLikeJobBoard) siteClass = "job-board";
      else if (probe?.looksLikeSocial) siteClass = "social";
      else if (probe?.looksLikeKnowledge) siteClass = "knowledge";

      return {
        ok: true,
        result: {
          url,
          ats: atsResult,
          siteClass,
          signals: {
            looksLikeJobBoard: probe?.looksLikeJobBoard ?? false,
            looksLikeSocial: probe?.looksLikeSocial ?? false,
            looksLikeKnowledge: probe?.looksLikeKnowledge ?? false,
            looksLikeLoginWall: probe?.looksLikeLoginWall ?? false,
          },
          pageStats: {
            bodyLen: probe?.bodyLen ?? 0,
            linkCount: probe?.linkCount ?? 0,
            internalLinkCount: probe?.internalLinkCount ?? 0,
            interactiveCount: probe?.interactiveCount ?? 0,
            applyCount: probe?.applyCount ?? 0,
            jobCardHeuristics: probe?.jobCardHeuristics ?? 0,
            postHeuristics: probe?.postHeuristics ?? 0,
            replyHeuristics: probe?.replyHeuristics ?? 0,
          },
          // The honest confidence signal the prompt asked for.
          genericNavigationMode: atsResult.type === "unknown" && siteClass === "generic",
          note:
            atsResult.type !== "unknown"
              ? `ATS-shaped site (${atsResult.type}, ${atsResult.confidence}) — apply ATS-specific strategy.`
              : siteClass === "login-wall"
                ? "Login wall detected — generic interaction will only reach the auth form. Call human.takeover for credentialed access."
                : siteClass === "job-board"
                  ? "Job-board-shaped DOM but no ATS signature — apply generic navigation with manual result verification."
                  : siteClass === "social"
                    ? "Social/community-shaped DOM (posts, replies, no Apply) — generic navigation works for thread reading; no job-board semantics apply."
                    : siteClass === "knowledge"
                      ? "Knowledge/docs-shaped DOM (long static text, few controls) — generic navigation works for read-only extraction."
                      : "Generic navigation mode: no known structure detected — apply extra scrutiny, re-verify results manually, expect possible gaps.",
        },
      };
    } catch (err) {
      return this.err("page.siteStructure", `Site structure probe failed: ${err}`, true);
    }
  }

  /**
   * Full-page scroll — scroll the entire page from top to bottom, handling
   * lazy-loaded content (intersection observer), infinite-scroll sentinels,
   * and sticky headers/footers. Returns the page's final scroll metrics and
   * any sentinels/nodes that were triggered along the way.
   */
  async scrollAll(opts: { max_steps?: number; step_px?: number; wait_ms?: number; sentinel_selector?: string } = {}): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const maxSteps = opts.max_steps ?? 100;
    const stepPx = opts.step_px ?? 600;
    const waitMs = opts.wait_ms ?? 600;
    const sentinelSelector = opts.sentinel_selector;
    try {
      // Start at the top
      await e.evaluate("(() => window.scrollTo(0, 0))()").catch(() => {});
      await e.waitMs(150).catch(() => {});

      const triggeredNodes: string[] = [];
      let lastHeight = 0;
      let stableCount = 0;
      const heightsSeen: number[] = [];

      for (let i = 0; i < maxSteps; i++) {
        // Scroll one step
        await e.evaluate(`(() => window.scrollBy(0, ${stepPx}))()`).catch(() => {});
        await e.waitMs(waitMs).catch(() => {});

        // Check for infinite-scroll sentinel if provided
        if (sentinelSelector) {
          try {
            const sel = await e.queryOne({ css: sentinelSelector } as any);
            if (sel && await e.isVisible(sel).catch(() => false)) triggeredNodes.push(`step ${i}: sentinel ${sentinelSelector} found`);
          } catch { /* ignore */ }
        }

        // Detect any new "Load more" / "Show more" buttons that have appeared in view
        try {
          const newButtonsRes = await e.evaluate(`(() => {
            const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            const seen = [];
            for (const c of candidates) {
              const t = (c.textContent || "").trim().toLowerCase();
              if (t.length === 0 || t.length > 60) continue;
              if (/load\\s*more|show\\s*more|see\\s*more|view\\s*more/.test(t)) {
                const rect = c.getBoundingClientRect();
                if (rect.top >= 0 && rect.top < window.innerHeight) seen.push(t);
              }
            }
            return Array.from(new Set(seen));
          })()`).catch(() => ({ ok: false as const }));
          const newButtons = newButtonsRes?.ok && Array.isArray(newButtonsRes.result) ? (newButtonsRes.result as string[]) : [];
          for (const b of newButtons) triggeredNodes.push(`step ${i}: load-more button "${b}"`);
        } catch { /* ignore */ }

        const h = await e.scrollHeight();
        heightsSeen.push(h);
        if (h === lastHeight) {
          stableCount++;
          if (stableCount >= 3) break; // page height stable for 3 steps — done
        } else {
          stableCount = 0;
          lastHeight = h;
        }
      }

      const finalY = await e.scrollY().catch(() => 0);
      const finalHeight = await e.scrollHeight().catch(() => 0);
      const finalBodyLenRes = await e.evaluate("(() => document.body?.innerText?.trim().length ?? 0)()").catch(() => ({ ok: false as const }));
      return {
        ok: true,
        result: {
          steps: heightsSeen.length,
          finalScrollY: finalY,
          finalScrollHeight: finalHeight,
          finalBodyLen: finalBodyLenRes?.ok ? finalBodyLenRes.result : 0,
          stableRounds: stableCount,
          triggered: triggeredNodes,
          heightsTrajectory: heightsSeen.length <= 50 ? heightsSeen : heightsSeen.slice(0, 25).concat([...heightsSeen.slice(-25)]),
        },
      };
    } catch (err) {
      return this.err("page.scrollAll", `Full-page scroll failed: ${err}`, true);
    }
  }

  /**
   * Site hierarchy exploration — BFS the site starting from the current page,
   * discovering linked pages and returning a tree of the navigation structure.
   * Stays within the same registrable domain by default.
   */
  async exploreHierarchy(opts: { max_depth?: number; max_pages?: number; same_domain_only?: boolean; include_pattern?: string; exclude_pattern?: string } = {}): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    const maxDepth = Math.min(opts.max_depth ?? 2, 4);
    const maxPages = Math.min(opts.max_pages ?? 30, 100);
    const sameDomainOnly = opts.same_domain_only !== false;
    const includeRe = opts.include_pattern ? new RegExp(opts.include_pattern, "i") : null;
    const excludeRe = opts.exclude_pattern ? new RegExp(opts.exclude_pattern, "i") : null;

    try {
      const startUrl = await e.url().catch(() => "");
      let startHost = "";
      try { startHost = new URL(startUrl).hostname; } catch { /* ignore */ }
      const startOrigin = (() => { try { return new URL(startUrl).origin; } catch { return ""; } })();

      type Node = { url: string; title: string; depth: number; links: string[] };
      const visited = new Set<string>([normalizeUrl(startUrl)]);
      const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
      const tree: Node[] = [];

      while (queue.length > 0 && tree.length < maxPages) {
        const { url, depth } = queue.shift()!;
        if (depth > maxDepth) continue;
        try {
          // For the start page, use the live page; for child pages, use evaluate
          // against the current page (we don't actually visit them — we extract
          // their links from the parent's DOM, which is what a BFS over the
          // sitemap would do without spending navigation time per page).
          const title = depth === 0 ? (await e.title().catch(() => "")) : "(discovered link)";
          const urlJson = JSON.stringify(url);
          const linksRes = await e.evaluate(`(() => { const u = ${urlJson}; const anchors = Array.from(document.querySelectorAll('a[href]')); const out = []; const seen = new Set(); for (const a of anchors) { try { const abs = new URL(a.getAttribute("href") || "", u).toString(); const norm = abs.split("#")[0]; if (norm.length === 0) continue; if (seen.has(norm)) continue; seen.add(norm); out.push(norm); } catch {} } return out; })()`).catch(() => ({ ok: false as const }));
          const links = linksRes?.ok && Array.isArray(linksRes.result) ? (linksRes.result as string[]) : [];
          tree.push({ url, title, depth, links });
          if (depth < maxDepth) {
            for (const link of links) {
              const norm = normalizeUrl(link);
              if (visited.has(norm)) continue;
              if (sameDomainOnly) {
                try { if (new URL(link).hostname !== startHost) continue; } catch { continue; }
              }
              if (includeRe && !includeRe.test(link)) continue;
              if (excludeRe && excludeRe.test(link)) continue;
              visited.add(norm);
              queue.push({ url: link, depth: depth + 1 });
            }
          }
        } catch { /* skip this node */ }
      }

      // Render as a tree
      function render(nodes: Node[]): string {
        const byDepth = new Map<number, Node[]>();
        for (const n of nodes) {
          const list = byDepth.get(n.depth) ?? [];
          list.push(n);
          byDepth.set(n.depth, list);
        }
        const lines: string[] = [];
        for (let d = 0; d <= maxDepth; d++) {
          const list = byDepth.get(d) ?? [];
          if (list.length === 0) continue;
          lines.push(`-- depth ${d} (${list.length} page${list.length === 1 ? "" : "s"}) --`);
          for (const n of list) lines.push(`  ${"  ".repeat(n.depth)}- ${n.title || n.url}`);
        }
        return lines.join("\n");
      }

      return {
        ok: true,
        result: {
          startUrl,
          startHost,
          sameDomainOnly,
          maxDepth,
          maxPages,
          totalDiscovered: tree.length,
          treeAsText: render(tree),
          nodes: tree,
        },
      };
    } catch (err) {
      return this.err("page.exploreHierarchy", `Site exploration failed: ${err}`, true);
    }
  }


  /**
   * Explicit dialog handling — sets the default action for any browser dialog
   * (alert/confirm/prompt) that fires during subsequent page actions. Returns
   * a snapshot of pending dialogs (if any) before the policy is set.
   */
  async setDialogPolicy(action: "accept" | "dismiss", value?: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    this.dialogDefaultAction = action;
    this.dialogDefaultValue = value;
    e.setDialogPolicy(action, action === "accept" ? value : undefined);
    return { ok: true, result: { policy: action, value, pending: 0 } };
  }

  // ═══ ATS-SPECIFIC HELPERS ══════════════════════════════════════════════

  /**
   * Oracle HCM Cloud search helper.
   * Oracle HCM ignores URL keyword params — must fill search input via JS
   * and dispatch native input/change events for the filter to take effect.
   */
  async oracleHCMSearch(keyword: string, waitMs = 2000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      // Find search input (Oracle HCM uses various placeholder patterns)
      const searchSelectors = [
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[placeholder*="keyword"]',
        'input[placeholder*="Keyword"]',
        'input[placeholder*="Job"]',
        'input[name="keyword"]',
        'input[name="search"]',
        'input[type="search"]',
        'input[data-testid*="search"]',
        'input[aria-label*="search" i]',
        'input[aria-label*="keyword" i]',
      ];

      const searchCss = searchSelectors.join(', ');
      await e.waitFor(`Array.from(document.querySelectorAll(${JSON.stringify(searchCss)})).some(el => el.getClientRects().length > 0 && !el.disabled)`, 10000, 250);
      let searchInput: KruzElement | null = null;
      for (const sel of searchSelectors) {
        const cnt = await e.countElements({ css: sel } as any).catch(() => 0);
        if (cnt > 0) {
          searchInput = await e.queryOne({ css: sel } as any);
          if (searchInput) break;
        }
      }

      if (!searchInput) {
        return this.err("page.oracleHCMSearch", "No search input found on Oracle HCM page", false);
      }

      // Clear and fill the search input
      await e.click(searchInput);
      await e.fill(searchInput, "");
      await e.fill(searchInput, keyword);

      // Dispatch native input events (Oracle HCM listens on these)
      await e.evaluateOn(searchInput, `(() => { const v = ${JSON.stringify(keyword)}; this.value = v; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); })()`).catch(() => {});

      // Also try pressing Enter to trigger search
      await e.press(searchInput, "Enter").catch(() => {});

      // Wait for results to update
      await e.waitMs(waitMs);

      const { ORACLE_COUNT_SCRIPT } = await import("./oracle-count.js");
      let count: unknown = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const countRes = await e.evaluate(ORACLE_COUNT_SCRIPT);
        if (countRes.ok && typeof countRes.result === "number") { count = countRes.result; break; }
        await e.waitMs(250);
      }

      this.bump();
      return { ok: true, result: { keyword, count, method: "oracle-hcm-js-evaluate" } };
    } catch (err) {
      return this.err("page.oracleHCMSearch", `Oracle HCM search failed: ${err}`, true);
    }
  }

  /**
   * iCIMS search helper.
   * iCIMS location filter uses internal IDs, not text strings.
   * This method navigates to a country-specific landing page first,
   * then applies keyword search.
   */
  async iCIMSSearch(keyword: string, countryPath: string, waitMs = 2000): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      // Navigate to country-specific landing page (intro page)
      await e.navigate(countryPath, "domcontentloaded", 15000).catch(() => {});
      await e.waitMs(1500);

      // Find search input on main page
      const searchSelectors = [
        'input[type="search"]',
        'input[name="keyword"]',
        'input[name="searchKeyword"]',
        'input[name="search"]',
        'input[placeholder*="Search"]',
        'input[placeholder*="keyword"]',
        'input[aria-label*="search" i]',
      ];

      let searchInput: KruzElement | null = null;
      for (const sel of searchSelectors) {
        const cnt = await e.countElements({ css: sel } as any).catch(() => 0);
        if (cnt > 0) {
          searchInput = await e.queryOne({ css: sel } as any);
          if (searchInput) break;
        }
      }

      if (searchInput) {
        await e.fill(searchInput, keyword);
        await e.press(searchInput, "Enter");
        await e.waitMs(waitMs);
      }

      // iCIMS loads results in an iframe — try to extract links from it
      let jobLinks: { title: string; url: string }[] = [];
      try {
        const frame = await e.frameBy("icims_content_iframe");
        if (frame) {
          const links = await e.queryAllInFrame(frame.id, { css: 'a[href*="/jobs/"]' } as any);
          for (const linkEl of links.slice(0, 20)) {
            const title = (await e.innerText(linkEl).catch(() => '')).trim().split('\n')[0];
            const href = (await e.attribute(linkEl, 'href').catch(() => '')) ?? '';
            if (title && href) {
              const fullUrl = href.startsWith('http') ? href : new URL(href, countryPath).toString();
              jobLinks.push({ title, url: fullUrl });
            }
          }
        }
      } catch {
        // If iframe extraction fails, try main page links
        const links = await e.queryAll({ css: 'a[href*="/jobs/"]' } as any);
        for (const linkEl of links.slice(0, 20)) {
          const title = (await e.innerText(linkEl).catch(() => '')).trim().split('\n')[0];
          const href = (await e.attribute(linkEl, 'href').catch(() => '')) ?? '';
          if (title && href) {
            const fullUrl = href.startsWith('http') ? href : new URL(href, countryPath).toString();
            jobLinks.push({ title, url: fullUrl });
          }
        }
      }

      this.bump();
      return { ok: true, result: { keyword, countryPath, method: "icims-iframe", jobLinks, count: jobLinks.length } };
    } catch (err) {
      return this.err("page.iCIMSSearch", `iCIMS search failed: ${err}`, true);
    }
  }

  /**
   * Detect if page has shell loaded but content area is empty.
   * Useful for identifying SPAs that render header/nav but fail to populate content.
   */
  async detectEmptyContent(): Promise<{ shellLoaded: boolean; contentAppeared: boolean; bodyLength: number }> {
    const e = this.engine();
    if (!e) return { shellLoaded: false, contentAppeared: false, bodyLength: 0 };

    try {
      const resultRes = await e.evaluate(`(() => {
        const shellSelectors = ["header", "nav", '[class*="header"]', '[class*="nav"]', '[class*="shell"]', '[class*="layout"]'];
        const shellLoaded = shellSelectors.some((sel) => document.querySelector(sel) !== null);
        const body = document.body?.innerText?.trim() ?? "";
        const contentAppeared = body.length > 100;
        return { shellLoaded, contentAppeared, bodyLength: body.length };
      })()`).catch(() => ({ ok: false as const }));
      const result = resultRes?.ok ? (resultRes.result as any) : { shellLoaded: false, contentAppeared: false, bodyLength: 0 };

      return result;
    } catch {
      return { shellLoaded: false, contentAppeared: false, bodyLength: 0 };
    }
  }

  /**
   * Auto-detect ATS type from current page URL and DOM.
   */
  async detectATS(): Promise<{ type: string; confidence: string; evidence: string }> {
    const e = this.engine();
    if (!e) return { type: "unknown", confidence: "low", evidence: "No active page" };

    try {
      const { detectATS } = await import("./ats-detector.js");
      const url = await e.url().catch(() => "");
      const html = await e.content().catch(() => "");
      const result = detectATS(url, html);
      return result;
    } catch {
      return { type: "unknown", confidence: "low", evidence: "Detection failed" };
    }
  }

  /** Phases 1.5/3a — enumerate the full ATS feed/sitemap via the live browser. */
  async atsEnumerate(ats: string, portalUrl: string, companySlug?: string): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const { enumerate } = await import("./ats-tools.js");
      const r = await enumerate(e as any, ats as any, portalUrl, companySlug);
      this.bump();
      return { ok: true, result: r };
    } catch (err) { return this.err("ats.enumerate", `Enumerate failed: ${err}`, true); }
  }

  /**
   * Phase 3c — verify a posting-page liveness + capture body/status in one pass.
   * Runs in a dedicated engine tab so N concurrent ats.verifyPosting calls
   * never share navigation state.
   */
  async atsVerifyPosting(postingUrl: string): Promise<ActionResult> {
    const s = this.getActiveSession();
    if (!s?.engine) return this.noSession();
    let isolated: BrowserEngine | undefined;
    try {
      isolated = await s.engine.createIsolatedPage();
      const { verifyPosting } = await import("./ats-tools.js");
      const r = await verifyPosting(isolated, postingUrl);
      return { ok: true, result: r };
    } catch (err) { return this.err("ats.verifyPosting", `Verify failed: ${err}`, true); }
    finally {
      if (isolated) await isolated.close().catch(() => {});
    }
  }

  // ═══ ATS JSON HARVESTERS (v11 medium-product) ═══════════════════════════

  async atsGreenhouseHarvest(company: string, query?: string): Promise<any> {
    try {
      const { greenhouseHarvest } = await import("./ats-json.js");
      let jobs = await greenhouseHarvest(company, query);
      if (jobs.length === 0) {
        // Bug 4 (2026-09-06): handle was a guess — try to discover the real one
        // before giving up. Public Greenhouse handles are credential-free.
        const { discoverGreenhouseHandle } = await import("../mcp/tool-names.js");
        const disc = await discoverGreenhouseHandle(company);
        if (disc.ok && disc.handle && disc.handle !== company) {
          jobs = await greenhouseHarvest(disc.handle, query);
          if (jobs.length > 0) {
            return {
              ok: true, ats: "greenhouse",
              company: disc.handle,
              original_company: company,
              auto_discovered: true,
              count: jobs.length, jobs,
              _hint: `Original handle '${company}' returned 0 jobs. Auto-discovered real board '${disc.handle}' via ${disc.source}. Re-use '${disc.handle}' on subsequent calls to skip the lookup.`,
            };
          }
        }
        return { ok: true, ats: "greenhouse", company, count: 0, jobs, auto_discover_attempted: true, auto_discover_result: disc, _hint: `Original handle '${company}' returned 0 jobs. Auto-discovery ${disc.ok ? `succeeded (${disc.handle}) but also 0 jobs` : "failed"} — ${disc.error ?? ""}` };
      }
      return { ok: true, ats: "greenhouse", company, count: jobs.length, jobs };
    } catch (err) { return this.err("ats.greenhouseHarvest", String(err), true); }
  }
  async atsLeverHarvest(company: string): Promise<any> {
    try { const { leverHarvest } = await import("./ats-json.js"); const jobs = await leverHarvest(company); return { ok: true, ats: "lever", company, count: jobs.length, jobs }; } catch (err) { return this.err("ats.leverHarvest", String(err), true); }
  }
  async atsAshbyHarvest(company: string): Promise<any> {
    try { const { ashbyHarvest } = await import("./ats-json.js"); const jobs = await ashbyHarvest(company); return { ok: true, ats: "ashby", company, count: jobs.length, jobs }; } catch (err) { return this.err("ats.ashbyHarvest", String(err), true); }
  }
  async atsSmartRecruitersHarvest(company: string): Promise<any> {
    try {
      const { smartRecruitersHarvest } = await import("./ats-json.js");
      let jobs = await smartRecruitersHarvest(company);
      if (jobs.length === 0) {
        // Bug 4 (2026-09-06): try public SmartRecruiters API probes before
        // returning an empty result. SmartRecruiters has no public directory,
        // so heuristic-only — for unknown companies fall back to ats.enumerate.
        const { discoverSmartRecruitersHandle } = await import("../mcp/tool-names.js");
        const disc = await discoverSmartRecruitersHandle(company);
        if (disc.ok && disc.handle && disc.handle !== company) {
          jobs = await smartRecruitersHarvest(disc.handle);
          if (jobs.length > 0) {
            return { ok: true, ats: "smartrecruiters", company: disc.handle, original_company: company, auto_discovered: true, count: jobs.length, jobs, _hint: `Original handle '${company}' returned 0 jobs. Auto-discovered '${disc.handle}' via ${disc.source}.` };
          }
        }
        return { ok: true, ats: "smartrecruiters", company, count: 0, jobs, auto_discover_attempted: true, auto_discover_result: disc, _hint: `Original handle '${company}' returned 0 jobs and no public directory exists for SmartRecruiters. For JS-rendered boards, use ats.enumerate(ats='smartrecruiters', portal_url='<careers URL>') which runs a real browser.` };
      }
      return { ok: true, ats: "smartrecruiters", company, count: jobs.length, jobs };
    } catch (err) { return this.err("ats.smartRecruitersHarvest", String(err), true); }
  }
  async atsWorkdayHarvest(tenant: string, site: string, query?: string): Promise<any> {
    try { const { workdayHarvest } = await import("./ats-json.js"); const jobs = await workdayHarvest(tenant, site, query); return { ok: true, ats: "workday", company: tenant, count: jobs.length, jobs }; } catch (err) { return this.err("ats.workdayHarvest", String(err), true); }
  }
  async atsBulkHarvest(companies: any[]): Promise<any> {
    try { const { bulkHarvest } = await import("./ats-json.js"); const results = await bulkHarvest(companies); return { ok: true, count: results.length, results }; } catch (err) { return this.err("ats.bulkHarvest", String(err), true); }
  }

  /** Bug 4 fix — public board-handle discovery (no credentials). */
  async atsDiscoverHandle(ats: "greenhouse" | "smartrecruiters", company: string): Promise<any> {
    try {
      const mod = await import("../mcp/tool-names.js");
      const fn = ats === "greenhouse" ? mod.discoverGreenhouseHandle : mod.discoverSmartRecruitersHandle;
      const r = await fn(company);
      return { ...r };
    } catch (err) { return this.err("ats.discoverHandle", String(err), true); }
  }

  /** Phase 3b batching — one-pass summary of all result-card links/text on a results page. */
  async atsSummarize(): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const { summarize } = await import("./ats-tools.js");
      const r = await summarize(e as any);
      this.bump();
      return { ok: true, result: r };
    } catch (err) { return this.err("ats.summarize", `Summarize failed: ${err}`, true); }
  }

  /** Phase 3 — stable pagination to a terminal "no more results" state. */
  async atsPaginate(o: { max_scrolls?: number; wait_ms?: number; load_more_selector?: string; next_selector?: string; budget_ms?: number } = {}): Promise<ActionResult> {
    const e = this.engine(); if (!e) return this.noSession();
    try {
      const { paginate } = await import("./ats-tools.js");
      const r = await paginate(e as any, { maxScrolls: o.max_scrolls, waitMs: o.wait_ms, loadMoreSelector: o.load_more_selector, nextSelector: o.next_selector, budgetMs: o.budget_ms });
      this.bump();
      return { ok: true, result: r };
    } catch (err) { return this.err("ats.paginate", `Paginate failed: ${err}`, true); }
  }

  /**
   * General-purpose experience/seniority extraction from job title text.
   * Returns inferred level, estimated years, matching signals, and confidence.
   * Delegates body-text scanning to the thorough `extractExperienceSignals`
   * (same patterns used by `ats.verifyPosting` Phase 3b/3c), so this tool
   * actually parses common phrasings like "0-3 years", "2+ years experience",
   * "recent graduate", "entry-level", "fresher", "new grad", etc.
   */
  extractExperience(title: string, bodyText?: string): {
    level: string; years: number; signals: string[]; confidence: "high" | "low" | "none"
  } {
    const titleLower = (title || "").toLowerCase();
    const bodyLower = (bodyText || "").toLowerCase();
    const combined = titleLower + " " + bodyLower;

    // Use the thorough body-text patterns from ats-tools (catches "0-3 years",
    // "2+ years experience", "recent graduate", "entry-level", etc.).
    const bodySignals = bodyText ? extractExperienceSignals(bodyText) : [];

    // Title-only signals: short, high-confidence keywords from the title.
    const titleSignals: string[] = [];
    if (/\b(intern|internship|co-?op|trainee)\b/.test(titleLower)) titleSignals.push("intern");
    if (/\b(junior|jr|entry[- ]level|graduate|fresh|fresher)\b/.test(titleLower)) titleSignals.push("junior");
    if (/\b(mid[- ]?level|intermediate)\b/.test(titleLower)) titleSignals.push("mid");
    if (/\b(senior|sr|lead|principal|staff)\b/.test(titleLower)) titleSignals.push("senior");
    if (/\b(director|head|vp|vice president|chief)\b/.test(titleLower)) titleSignals.push("executive");
    if (/\b(manager)\b/.test(titleLower)) titleSignals.push("manager");

    // Merge, dedupe, cap
    const seen = new Set<string>();
    const signals: string[] = [];
    for (const s of [...titleSignals, ...bodySignals]) {
      if (!seen.has(s)) { seen.add(s); signals.push(s); }
    }
    const cappedSignals = signals.slice(0, 8);

    // Level: prefer title (more reliable), then body seniority-conflict, then years.
    let level = "unknown";
    if (titleSignals.includes("intern")) level = "intern";
    else if (titleSignals.includes("junior")) level = "junior";
    else if (titleSignals.includes("mid")) level = "mid";
    else if (titleSignals.includes("senior")) level = "senior";
    else if (titleSignals.includes("executive")) level = "executive";
    else if (titleSignals.includes("manager")) level = "senior";
    else {
      // Fall back to body-level markers (senior/lead/manager/principal in body = senior-scope).
      if (/\b(senior|lead|principal|staff|architect)\b/.test(bodyLower)) level = "senior";
      else if (/\b(junior|jr|entry[- ]level|graduate|fresh|fresher|associate|new grad|recent graduate|campus)\b/.test(bodyLower)) level = "junior";
      else if (/\b(mid[- ]?level|intermediate)\b/.test(bodyLower)) level = "mid";
    }

    // Years: explicit year range from body wins; otherwise infer from level.
    let years = 0;
    const rangeMatch = bodyLower.match(/(\d+)\s*(?:to|-|–|—)\s*(\d+)\s*\+?\s*years?/);
    const singleMatch = bodyLower.match(/(\d{1,2})\+?\s*years?/);
    if (rangeMatch) {
      // Use the upper bound of the range as the "max years".
      years = parseInt(rangeMatch[2], 10);
    } else if (singleMatch) {
      years = parseInt(singleMatch[1], 10);
    } else {
      // Infer from level
      if (level === "intern") years = 0;
      else if (level === "junior") years = 1;
      else if (level === "mid") years = 3;
      else if (level === "senior") years = 5;
      else if (level === "executive") years = 10;
      else years = -1;
    }

    // Confidence: high = level keyword + year range both found;
    //             low  = only one signal kind present;
    //             none = neither.
    const hasLevel = level !== "unknown";
    const hasYears = years > 0 || rangeMatch !== null;
    let confidence: "high" | "low" | "none";
    if (hasLevel && hasYears) confidence = "high";
    else if (hasLevel || hasYears || bodySignals.length > 0) confidence = "low";
    else confidence = "none";

    return { level, years, signals: cappedSignals, confidence };
  }

  // ═══ SHADOW DOM ════════════════════════════════════════════════════════

  // ═══ PRIVATE HELPERS ═══════════════════════════════════════════════════

  private bump(): void { this.getActiveSession()?.observer.bumpMutation(); }
  private engine(): BrowserEngine | null { return this.sessionManager.getActiveEngine(); }
  private getActiveSession(): SessionState | null { return this.sessionManager.getActive(); }
  private getRefMap(): Map<string, any> { return this.getActiveSession()?.observer.getRefMap() ?? new Map(); }

  // ---- Multi-tab (parallel boards / keep-JD-open-while-verifying) ----

  /** Open a new tab and switch to it (parallel job-board or staging tab). */
  async newTab(url?: string): Promise<ActionResult> {
    const r = await this.sessionManager.newTab(url);
    if (!r) return this.noSession();
    this.invalidateAllRefs();
    // Bring new tab to front so it's visible in headed mode
    await this.engine()?.bringToFront().catch(() => {});
    return { ok: true, result: { new_page: r.id, active: true, url: r.tab.url } };
  }

  /** Close a tab, switching active to the next remaining one. */
  async closeTab(pageId: string): Promise<ActionResult> {
    const ok = await this.sessionManager.closeTab(pageId);
    if (!ok) return { ok: false, error: { code: "NO_TAB", message: `No open tab '${pageId}'.`, retryable: false } };
    this.invalidateAllRefs();
    const tabs = await this.sessionManager.listTabs();
    return { ok: true, result: { closed: pageId, active: tabs.filter(t => t.isActive).map(t => t.id) } };
  }

  /** List all tabs (id/url/title/active). */
  async listTabs(): Promise<ActionResult> {
    const tabs = await this.sessionManager.listTabs();
    if (tabs.length === 0) return this.noSession();
    return { ok: true, result: { tabs, count: tabs.length } };
  }

  /** Switch the active page to another open tab. */
  async switchTab(pageId: string): Promise<ActionResult> {
    const e = this.engine();
    if (!e) return this.noSession();
    try {
      await e.switchTab(pageId);
    } catch {
      return { ok: false, error: { code: "NO_TAB", message: `No open tab '${pageId}'. Use page.listTabs to see open tabs.`, retryable: false } };
    }
    this.invalidateAllRefs();
    try { await e.bringToFront().catch(() => {}); } catch { /* ignore */ }
    const url = await e.url().catch(() => "");
    const title = await e.title().catch(() => "");
    return { ok: true, result: { active: pageId, url, title } };
  }

  /** Attach to an already-running browser via CDP (drive your logged-in browser in place). */
  async attachBrowser(endpoint: string): Promise<ActionResult> {
    try {
      const st = await this.sessionManager.attach(endpoint);
      if (!st) return { ok: false, error: { code: "ATTACH_FAILED", message: `Could not attach to ${endpoint}. Ensure the browser was started with --remote-debugging-port and the endpoint is reachable.`, retryable: true } };
      if (st.engine) await this.listen(st.engine).catch(() => {});
      const tabs = await this.sessionManager.listTabs();
      return { ok: true, result: { attached: true, endpoint, tabs: tabs.length, activeUrl: st.engine ? await st.engine.url().catch(() => null) : null } };
    } catch (err) {
      return { ok: false, error: { code: "ATTACH_FAILED", message: `Attach error: ${err}`, retryable: true } };
    }
  }

  // ═══ PRIVATE HELPERS ═════════════════════════════════════════════════════

  /** No active session — standard error result. */
  private noSession(): ActionResult {
    return { ok: false, error: kruzError(ErrCode.NO_SESSION, { subsystem: "session", message: "No active browser session. Start one with session.create.", trace: ["controller"] }).toJSON() };
  }
  /** Build a standard error ActionResult — one shape for every controller failure. */
  private err(code: string, message: string, retryable: boolean, extra?: { help?: string; subsystem?: Subsystem }): ActionResult {
    return {
      ok: false,
      error: kruzError(code, {
        message,
        subsystem: extra?.subsystem,
        retryable,
        help: extra?.help,
        trace: ["controller"],
      }).toJSON(),
    };
  }

  /** Classify a caught action failure into the unified taxonomy (D5) instead of
   *  stamping the tool name as the code. The caller's remediation tip is kept. */
  private actionErr(verb: string, err: unknown, tip?: string): ActionResult {
    const env = kruzErrorFromThrown(err, { subsystem: "engine", trace: ["controller"] });
    return this.err(env.code, `${verb} failed: ${env.message}${tip ? ` ${tip}` : ""}`, env.retryable, {
      subsystem: env.subsystem,
      help: env.help ?? tip,
    });
  }

  /** Whether a target (or its fallback) carries any locator criterion. */
  private hasTarget(target?: Target, fallback?: Fallback): boolean {
    if (!target) return false;
    return !!(target.ref || target.css || target.text || target.role || target.name ||
      target.label || target.placeholder || target.testid || target.id || target.nameAttr ||
      fallback?.css || fallback?.xpath || fallback?.text);
  }

  /** Human-readable description of a target (for error messages). */
  private desc(target?: Target): string {
    if (!target) return "element";
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
    return parts.length === 0 ? "element" : parts.join(" ");
  }

  /**
   * The session's ref authority — the single mint/consume point for refs.
   *
   * `page.observe`, `page.probe`, ambiguity candidates and the action results all
   * mint into this one instance, and every action resolves from it. There is no
   * second allocator: two registries would mean two independent `e` counters and
   * refs that no action can resolve.
   */
  private fallbackRefs = new RefRegistry();
  private refs(): RefRegistry {
    const s = this.getActiveSession();
    // A controller built with a stub session (tests) still shares ONE identity
    // system. Returning a fresh `new RefRegistry()` per call would look the same
    // here but would silently make every ref unresolvable on the next call.
    if (s?.refs) return s.refs;
    return (s?.observer as any)?.getRegistry?.() ?? this.fallbackRefs;
  }

  private docIdCache = "nodoc";
  private revisionCache = 0;
  /** Last resolution timing, so the next response can report it. Diagnostic only. */
  private lastResolveTiming: ActionTiming = {};

  /**
   * Refresh page/document identity before a resolution burst.
   *
   * Refs are only meaningful inside the document that minted them, so the
   * action path must know which document it is in before it can honestly answer
   * "this ref is stale" versus "this element is gone".
   *
   * The tab id matters as much as the document id and was the second half of the
   * observe-ref P0: the Observer mints refs against the REAL active tab id it
   * gets from `engine.listTabs()` (e.g. "tab-1"), while the controller resolved
   * against its hardcoded `activePageId` default of "p1". Once the refs were in
   * the shared registry at all, every single observe ref failed the
   * document/page identity check and came back as DOCUMENT_CHANGED. Both sides
   * must derive the tab id the same way, so it is read here from the same source
   * the Observer uses.
   */
  private async refreshIdentity(e: BrowserEngine): Promise<void> {
    const tabs = await e.listTabs().catch(() => null);
    const activeTab = tabs?.find((t) => t.isActive);
    if (activeTab?.id) this.activePageId = activeTab.id;
    const r = await e.evaluate("String(performance && performance.timeOrigin || 'nodoc')").catch(() => null);
    this.docIdCache = r?.ok ? String(r.result) : "nodoc";
    const s = this.getActiveSession();
    const obs = s?.observer as any;
    if (obs?.getRevision) {
      const rev = await obs.getRevision(e).catch(() => 0);
      if (typeof rev === "number") this.revisionCache = rev;
    }
  }

  /**
   * Shared entry point for the remaining target-bearing actions (select,
   * check, uncheck, scroll-to-target). Identity comes from the same matcher and
   * the same ref registry as click/fill/probe; only the actionability bar varies.
   */
  private async unified(
    target: Target, fallback: Fallback | undefined, scope: string | undefined,
    mode: MatchMode, timeoutMs = 5000, allowHidden = false,
  ): Promise<{ ok: true; el: KruzElement; token: string; ref: string } | { ok: false; result: ActionResult }> {
    const t0 = Date.now();
    const e = this.engine();
    if (!e) return { ok: false, result: this.noSession() };
    await this.refreshIdentity(e);
    const tIdentity = Date.now();
    const r = await resolveForAction(
      { engine: e, registry: this.refs(), pageId: this.activePageId, documentId: this.docIdCache, revision: this.revisionCache },
      target, fallback, scope, mode, { allowHidden, waitMs: Math.min(timeoutMs, 1500) },
    );
    // Diagnostic metadata only — never a decision input.
    this.lastResolveTiming = { resolve_ms: Date.now() - t0, identity_ms: tIdentity - t0 };
    if (!r.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          timing: { total_ms: Date.now() - t0, ...this.lastResolveTiming },
          error: kruzError(r.code, { subsystem: "controller", message: r.message, retryable: r.retryable, help: r.help }).toJSON(),
          result: r.candidates ? { count: r.candidates.length, candidates: r.candidates } : r.evidence,
        },
      };
    }
    return { ok: true, el: r.el, token: r.token, ref: r.ref };
  }

  /** Resolve a target to a KruzElement via refMap / semantic re-match. Throws if not found. */
  private async resolve(target: Target, fallback?: Fallback, scope?: string, _timeoutMs = 3000, _force = false): Promise<{ el: KruzElement }> {
    const e = this.engine();
    if (!e) throw new Error("no active session");
    const rm = this.getRefMap();
    const fb = fallback;
    // P2-A: propagate the caller's budget into plain-CSS resolution so a current-state
    // lookup fails fast instead of consuming the fixed resolver timeout.
    const { el } = await resolveElementWithRef(e, target, rm, fb, scope, _timeoutMs);
    if (el) return { el };
    throw new Error(`Element not found (${this.desc(target)})`);
  }

  /** Resolve an element, falling back to a typed selector (input[type='file'], canvas, etc.). */
  private async resolveEl(e: BrowserEngine, target: Target, typeSelector: string, fallback?: Fallback, scope?: string): Promise<KruzElement> {
    const rm = this.getRefMap();
    const fb = fallback;
    const { el } = await resolveElementWithRef(e, target, rm, fb, scope);
    if (el) return el;
    const typed = await e.queryOne({ css: typeSelector }, undefined, scope);
    if (typed) return typed;
    throw new Error(`No ${typeSelector} element found (${this.desc(target)})`);
  }

  /** BUG-3: Invalidate all refs — call after any action that may re-render the page. */
  private invalidateAllRefs(): void {
    const s = this.getActiveSession();
    if (!s) return;
    s.observer.getRefMap().clear();
    s.observer.bumpMutation();
  }

  /** Record an action in the navigation trace and invalidate stale refs. */
  private afterAction(url: string): void {
    const s = this.getActiveSession();
    if (!s) return;
    const pid = this.activePageId;
    try { s.observer.invalidatePage(pid); } catch { /* ignore */ }
    s.observer.bumpMutation();
    s.observer.getRefMap().clear();
    this.sessionManager.trace(s.id, "action", url, pid);
  }

  /** Enable engine network/console capture and merge the backlog into local arrays. */
  private async listen(engine: BrowserEngine): Promise<void> {
    try { await engine.enableNetworkCapture({ captureBodies: this.captureResponseBodies }); } catch { /* ignore */ }
    try { await engine.enableConsoleCapture(); } catch { /* ignore */ }
    this.syncCapture(engine);
  }

  /** Produce an observation snapshot for error results (so the model isn't blind after a failure). */
  private async diagnostic(engine: BrowserEngine | null, scope?: string): Promise<Observation | undefined> {
    try {
      const s = this.getActiveSession();
      if (!s) return undefined;
      const { observation } = await s.observer.observe(engine as any, scope, "minimal", true);
      return observation;
    } catch {
      return undefined;
    }
  }

  /** BUG-2: Select2 dropdown handling — select2 opens via mousedown on the control. Returns true if opened. */
  private async handleSelect2(e: BrowserEngine, target: Target, fallback?: Fallback, scope?: string): Promise<boolean> {
    try {
      const rm = this.getRefMap();
      const { el } = await resolveElementWithRef(e, target, rm, fallback, scope);
      if (!el) return false;
      const res = await e.evaluateOn(el, `(() => {
        const c = this.closest && this.closest('.select2-container');
        const anyS2 = document.querySelector('.select2-container');
        const pick = (root) => { const h = root.querySelector('.select2-selection'); if (h) { const r = h.getBoundingClientRect(); return { open: true, x: r.x + r.width/2, y: r.y + r.height/2 }; } return null; };
        if (c) { const p = pick(c); if (p) return p; }
        if (anyS2) { const p = pick(anyS2); if (p) return p; }
        return { open: false };
      })()`).catch(() => ({ ok: false as const }));
      if (!res.ok || !res.result) return false;
      const r = res.result as any;
      if (!r.open) return false;
      await e.mouseClick(r.x, r.y).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }
}

