/**
 * overlays — cookie/consent/dialog dismissal through the SAME perception stack as
 * page.observe and page.probe.
 *
 * The manual report's Bug 5 is the clearest architectural failure in the server:
 * `page.observe` on the Oracle candidate-experience page immediately exposed
 * "Accept All" / "Reject All" / "Manage Preferences" as ordinary refs, while
 * `page.handleOverlays` spent its entire scan budget and reported "no safe
 * dismiss control". The cause was not Oracle's markup — it was that the overlay
 * scanner had its own private world-view: a hard-coded list of class/id tokens
 * ("cookie", "banner", "consent") plus a fixed regex of English button labels.
 * Any banner that does not spell its own name in a class attribute is invisible
 * to it, no matter how obvious it is to a human or to the general observer.
 *
 * So discovery here is SEMANTIC and layered, with the legacy token list demoted
 * to one heuristic among several:
 *
 *   1. semantic-controls      top-layer regions, ranked by control intent
 *   2. known-ids              the well-known vendor consent containers (fast path)
 *   3. dialog-regions         visible role=dialog / aria-modal regions
 *   4. bounded candidate list  hand the model real refs so it can act itself
 *
 * Each rung records what it found, and an escalation never repeats a strategy
 * that already failed. That is the second half of Bug 5: the old loop re-ran the
 * same failed scan until the budget ran out and then reported three mutually
 * contradictory stories in one response.
 */

import type { BrowserEngine } from "./engine.js";
import { OVERLAY_SCAN_SRC, OVERLAY_FIND_SRC, OVERLAY_GONE_SRC, OVERLAY_CLEAR_SRC } from "./inpage-overlay-script.js";

export interface OverlayIntent {
  /** 'reject' never grants optional consent; 'close' is neutral; 'accept' does grant it. */
  intent: "reject" | "close" | "preferences" | "accept";
  label: string;
  role: string;
  name: string;
  /** Lower sorts first. */
  rank: number;
  actionable: boolean;
  blocked_reason: string | null;
  container: string | null;
  path: string;
}

export interface OverlayCandidate {
  intent: OverlayIntent["intent"];
  label: string;
  ref?: string;
}

export interface OverlayScanResult {
  detected: boolean;
  region: string | null;
  candidates: OverlayCandidate[];
  strategy: string;
  attempts: Array<{ strategy: string; regions: number; controls: number; note?: string }>;
  note?: string;
}

export interface OverlayDismissResult {
  dismissed: string[];
  failed: string[];
  summary: string;
  detected_overlay: boolean;
  attempts: Array<{ strategy: string; control: string; intent: string; outcome: string; note?: string }>;
  candidates: OverlayCandidate[];
  terminal_reason: string | null;
  region: string | null;
  timing: { discovery_ms: number; dismissal_ms: number; total_ms: number };
}

/**
 * Well-known vendor containers — ONE rung of the ladder, not the detection
 * mechanism. Kept (and extended) from the original scanner so no banner that
 * was previously found becomes unfindable; the semantic rungs in
 * inpage-overlay-script.ts are what make banners without these tokens visible.
 */
const CONFIG_SELECTORS: Record<string, string[]> = {
  cookie: [
    "#onetrust-banner-sdk", "#CybotCookiebotDialog", "#system-ialert", "#usercentrics-root",
    "#didomi-host", "#truste-consent-track", "#cookiescript_injected", "#cmpbnty",
    "#didomi-popup", "#qc-cmp2-container", ".qc-cmp2-container", "#usercentrics-root",
    ".truste-banner", ".truste_box", "[id*='cookie' i][id*='banner' i]",
    "[class*='cookie' i][class*='banner' i]", "[class*='cookie' i][class*='consent' i]",
    "[class*='cookie' i][class*='notice' i]", "[class*='cookie' i][class*='policy' i]",
    ".cookie-notice", ".cookie-bar", ".gdpr-banner", "[data-testid*='cookie' i]",
    "[class*='consent' i][class*='banner' i]", "[id*='consent' i][id*='banner' i]",
    "[class*='consent' i][class*='dialog' i]", "[class*='gdpr' i]",
  ],
  newsletter: [
    '[class*="newsletter" i][class*="popup" i]', '[class*="subscribe" i][class*="modal" i]',
    ".newsletter-modal", ".subscription-popup", ".email-capture",
    // NOT a bare [class*="newsletter" i] / [id*="newsletter" i]: those match the
    // ordinary inline footer signup block on every Shopify storefront, so Kruz
    // reported a blocking overlay on pages that had none. Every entry here now
    // names a popup/modal/capture construct.
  ],
  chat: [
    ".intercom-messenger", ".drift-chat", ".crisp-client", ".tawk-widget",
    '[class*="chat" i][class*="widget" i]', '[id*="chat" i][id*="widget" i]',
    '#hubspot-messages-iframe-container', '[class*="livechat" i]',
  ],
  app: [".app-banner", ".install-banner", "#app-install-banner", ".mobile-app-banner", ".pwa-install", '[data-testid*="install" i]'],
};

type OverlayScanIntent = "reject" | "close" | "preferences" | "accept";

/** Build the scanner script for a set of enabled overlay kinds. */
export function overlayScanScript(kinds: string[], maxRegions = 12): string {
  return `(${OVERLAY_SCAN_SRC})(${JSON.stringify({ kinds, maxRegions })}, ${JSON.stringify(CONFIG_SELECTORS)})`;
}

/**
 * Detection-only scan, shaped like the historical `overlayScript` result.
 *
 * It deliberately does NOT click anything: the safe-dismissal path lives in
 * `discoverOverlays` + `dismissViaControl`, which rank and verify. This entry
 * point is kept so "are the requested overlay categories even enabled/enabled
 * correctly?" can be answered without mutating the page.
 */
export async function overlayScript(
  e: BrowserEngine,
  config: { cookie: boolean; newsletter: boolean; chat: boolean; app: boolean },
): Promise<{ dismissed: string[]; failed: string[]; summary: string; candidates: OverlayCandidate[]; attempts: unknown[] }> {
  const kinds: string[] = [];
  if (config.cookie) kinds.push("cookie");
  if (config.newsletter) kinds.push("newsletter");
  if (config.chat) kinds.push("chat");
  if (config.app) kinds.push("app");
  if (kinds.length === 0) {
    return { dismissed: [], failed: [], summary: "Dismissed 0 overlays, 0 unresolved", candidates: [], attempts: [] };
  }
  const d = await discoverOverlays(e, kinds);
  return {
    dismissed: [],
    failed: d.regions.map((r) => r.label || r.kind),
    summary: `Dismissed 0 overlays, ${d.regions.length} unresolved`,
    candidates: d.candidates,
    attempts: d.attempts,
  };
}

export interface OverlayDiscovery {
  detected: boolean;
  region: string | null;
  regions_found: number;
  regions: Array<{ kind: string; label: string; controls: number }>;
  candidates: OverlayCandidate[];
  /** Every named interactive control inside a detected region, dismissal intent
   *  or not. Surfaced on refusal so the caller can act on one explicitly. */
  region_controls?: Array<{
    label: string;
    role: string;
    name: string;
    actionable: boolean;
    container: string | null;
    region_kind: string;
    path: string;
  }>;
  attempts: Array<{ strategy: string; regions: number; controls: number; note?: string }>;
  timing: { discovery_ms: number };
}

/**
 * Discover overlay dismissal candidates with bounded escalation.
 *
 * The bounded wait is MUTATION-DRIVEN, not a sleep: we scan immediately, and
 * only when the page is still actively mounting do we watch for real DOM change
 * and rescan. A settled page with no overlay returns immediately, so this cannot
 * become the "sleep 5s on every call" regression the latency work removed.
 */
export async function discoverOverlays(
  e: BrowserEngine,
  kinds: string[],
  opts: { mountWindowMs?: number } = {},
): Promise<OverlayDiscovery> {
  const started = Date.now();
  const mountWindow = opts.mountWindowMs ?? 1200;
  /**
   * Minimum window before a no-counter document may be declared settled.
   *
   * Consent managers mount on a timer after `load`, so a document that is
   * already complete at t=0 can still grow a banner. This is a small, bounded
   * watch period rather than the previous full-mountWindow wait, and it is
   * mutation-agnostic: the page may or may not be changing and we rescan
   * regardless.
   */
  const MIN_MOUNT_WATCH_MS = 400;

  const scan = async (): Promise<any> => {
    const r = await e.evaluate(overlayScanScript(kinds)).catch(() => null) as any;
    return r?.ok && r.result ? r.result : { detected: false, region: null, regions_found: 0, candidates: [], attempts: [] };
  };

  let out = await scan();
  // Nothing found. Only wait when the page is genuinely still moving — a settled
  // document cannot grow a banner, so waiting on it is pure latency.
  if (!out.detected || !(out.candidates || []).length) {
    const deadline = started + mountWindow;
    let lastMut = -1;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      const st = await e.evaluate(`(() => { try { return { mut: (window).__p1MutationCount ? (window).__p1MutationCount() : null, ready: document.readyState, body: (document.body && document.body.innerText || '').trim().length }; } catch (x) { return null; } })()`).catch(() => null);
      const now = Date.now();
      const info: any = st?.ok ? st.result : null;
      if (info) {
        if (typeof info.mut === "number") {
          if (info.mut !== lastMut) { lastMut = info.mut; quietSince = now; }
          if (now - quietSince > 400 && info.ready !== "loading") break; // settled: it is not coming
        } else if (info.ready !== "loading" && now - started >= MIN_MOUNT_WATCH_MS) {
          // No mutation counter on this page — the Observer installs one, but
          // page.handleOverlays can be the first thing to touch the document.
          // Previously that left `mut` null, so the settle test could never pass
          // and every no-overlay call burned the full mount window.
          //
          // A finished document is not proof that no overlay is COMING: consent
          // banners routinely mount on a timer after load. So this is a MINIMUM
          // watch period, not an instant exit — rescan on each tick until then.
          // Bounded, and far shorter than the previous unconditional wait.
          await e.waitMs(120);
          out = await scan();
          if ((out.candidates || []).length) break;
          break;
        }
      }
      await e.waitMs(120);
      out = await scan();
      if ((out.candidates || []).length) break;
    }
  }

  return {
    detected: !!out.detected,
    region: out.region ?? null,
    regions_found: out.regions_found ?? 0,
    regions: out.regions ?? [],
    candidates: (out.candidates || []) as OverlayCandidate[],
    // Forwarded so the refusal path can offer the controls it saw but would not
    // click. Dropping them here is what made the refusal evidence-free.
    region_controls: out.region_controls || [],
    attempts: out.attempts || [],
    timing: { discovery_ms: Date.now() - started },
  };
}

/**
 * One bounded dismissal attempt.
 *
 * Verification is the point: a dismissal is only reported as dismissed when the
 * control itself or its overlay region is actually gone afterwards. That is the
 * extra `page.probe` the manual report was forced to spend by hand.
 */
export async function dismissViaControl(
  e: BrowserEngine,
  controlName: string,
  intent: OverlayIntent["intent"],
  regionKind: string | null,
  candidateIndex?: number,
): Promise<{ dismissed: boolean; attempts: OverlayDismissResult["attempts"]; reason: string | null }> {
  const attempts: OverlayDismissResult["attempts"] = [];

  // Prefer the node discovery already identified. Clicking THAT element — rather
  // than re-searching by label — is what guarantees a page button that happens
  // to share a label with the banner ("No, thanks" next to a cookie notice) can
  // never be clicked instead of the banner control.
  if (candidateIndex !== undefined) {
    const taken = await e.evaluate(`(() => {
      const list = (window).__kruzOverlayNodes || [];
      const node = list[${candidateIndex}];
      if (!node || !node.isConnected) return { ok: false, reason: 'control-gone' };
      document.querySelectorAll('[data-kruz-overlay-pick]').forEach(n => n.removeAttribute('data-kruz-overlay-pick'));
      document.querySelectorAll('[data-kruz-overlay-region]').forEach(n => n.removeAttribute('data-kruz-overlay-region'));
      const region = node.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],[class*="consent" i],[id*="consent" i],[class*="cookie" i],[id*="cookie" i],[class*="banner" i],[id*="banner" i],[class*="notice" i],[class*="popup" i],[class*="modal" i],[class*="gdpr" i]');
      (region || node).setAttribute('data-kruz-overlay-region', '1');
      node.setAttribute('data-kruz-overlay-pick', '1');
      (window).__kruzMarkedNode = node;
      return { ok: true, hadRegion: !!region };
    })()`).catch(() => null) as any;
    if (taken?.ok && taken.result?.ok) {
      return await clickMarkedAndVerify(e, controlName, intent, regionKind);
    }
    attempts.push({ strategy: regionKind ?? "semantic", control: controlName, intent, outcome: "control_not_found", note: "the control discovery identified is no longer in the document" });
    return { dismissed: false, attempts, reason: `The control "${controlName}" was not present when the dismissal was attempted.` };
  }

  // Hint-driven path: the model named the control, so find it by name.
  const before = await e.evaluate(`(${OVERLAY_FIND_SRC})(${JSON.stringify(controlName)})`).catch(() => null) as any;
  if (!before?.ok || before.result?.ok !== true) {
    attempts.push({ strategy: regionKind ?? "semantic", control: controlName, intent, outcome: "control_not_found" });
    return { dismissed: false, attempts, reason: `The control "${controlName}" was not present when the dismissal was attempted.` };
  }
  return await clickMarkedAndVerify(e, controlName, intent, regionKind);
}

/**
 * Click the currently marked control and verify the overlay actually went away.
 * A dispatch failure is recorded rather than swallowed: "the click could not be
 * dispatched" and "the click landed but the banner stayed" are different
 * problems and the report must not blur them.
 */
async function clickMarkedAndVerify(
  e: BrowserEngine,
  controlName: string,
  intent: OverlayIntent["intent"],
  regionKind: string | null,
): Promise<{ dismissed: boolean; attempts: OverlayDismissResult["attempts"]; reason: string | null }> {
  const attempts: OverlayDismissResult["attempts"] = [];
  const el = await e.takeMarkedNode('[data-kruz-overlay-pick="1"]', { css: '[data-kruz-overlay-pick="1"]' }).catch(() => null);
  if (!el) {
    attempts.push({ strategy: regionKind ?? "semantic", control: controlName, intent, outcome: "not_actionable", note: "the control could not be pinned for clicking" });
    return { dismissed: false, attempts, reason: `The control "${controlName}" could not be pinned for clicking.` };
  }
  let dispatchError: string | null = null;
  try {
    await e.click(el, { timeoutMs: 3000 });
  } catch (err) {
    dispatchError = String((err as Error)?.message ?? err).slice(0, 200);
  }

  // Bounded, effect-based verification: no fixed sleep beyond this settle window.
  const deadline = Date.now() + 1200;
  let state: { controlGone: boolean; regionGone: boolean; hadControl: boolean; hadRegion: boolean } | null = null;
  do {
    const r = await e.evaluate(`(${OVERLAY_GONE_SRC})()`).catch(() => null) as any;
    if (r?.ok && r.result) {
      state = r.result as { controlGone: boolean; regionGone: boolean; hadControl: boolean; hadRegion: boolean };
      if (state.controlGone || state.regionGone) break;
    }
    await e.waitMs(80);
  } while (Date.now() < deadline);
  // Marks are cleared once, after the verdict.
  await e.evaluate(`(${OVERLAY_CLEAR_SRC})()`).catch(() => null);

  const ok = !!(state && (state.controlGone || state.regionGone));
  attempts.push({
    strategy: regionKind ?? "semantic",
    control: controlName,
    intent,
    outcome: ok ? "dismissed" : "still_present",
    note: ok
      ? (state!.regionGone ? "overlay region disappeared" : "control disappeared")
      : dispatchError
        ? `the click could not be dispatched: ${dispatchError}`
        : "the click was dispatched and the control and its overlay region were both still present afterwards",
  });
  return { dismissed: ok, attempts, reason: ok ? null : `Clicking "${controlName}" did not remove the control or its overlay region.` };
}

