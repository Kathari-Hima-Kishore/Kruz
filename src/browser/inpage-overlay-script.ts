/**
 * inpage-overlay-script — the overlay scanner, stored as explicit source.
 *
 * See inpage-scripts.ts for why this is a string rather than a serialised
 * function.
 *
 * Discovery here is SEMANTIC. The manual report's Bug 5 was not an Oracle bug:
 * `page.observe` saw "Accept All" / "Reject All" / "Manage Preferences" on the
 * very same page, while `page.handleOverlays` reported no safe dismiss control
 * 9 times. The old scanner had its own private world-view — a class/id token
 * list plus a fixed English label regex — so a banner that never says "cookie"
 * in a class attribute was invisible to it no matter how obvious it was to a
 * human. Those heuristics are kept here as ONE rung of a ladder, not as the
 * detection mechanism.
 */

export const OVERLAY_SCAN_SRC = String.raw`
function __kruzOverlayScan(cfg, KNOWN) {
  var norm = function (s) { return String(s == null ? "" : s).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase(); };

  var rendered = function (el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    var s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };

  var nameOf = function (el) {
    var lb = el.getAttribute("aria-labelledby");
    if (lb) {
      var parts = lb.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? (n.textContent || "") : ""; }).filter(Boolean);
      if (parts.length) return parts.join(" ").trim();
    }
    var al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t) return t;
    return (el.getAttribute("title") || el.getAttribute("value") || "").trim();
  };

  var roleOf = function (el) {
    var r = el.getAttribute("role");
    if (r) return r;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") { var t = el.type; return (t === "submit" || t === "button") ? "button" : "textbox"; }
    return "generic";
  };

  var isControl = function (el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return true;
    if (el.getAttribute("role") === "button" || el.getAttribute("role") === "menuitem") return true;
    if (el.onclick) return true;
    if (tag === "input" && (el.type === "button" || el.type === "submit")) return true;
    return false;
  };

  // Intent classification. These strings are heuristics used to RANK controls
  // inside a region that has already been identified as an overlay -- they are
  // not the detection mechanism. The order encodes a policy: refusing consent
  // always outranks granting it, so an agent never hands out optional tracking
  // consent just because "Accept All" was the easiest button to find.
  var classify = function (el, regionKind) {
    var label = norm(nameOf(el));
    if (!label || label.length > 60) return null;
    if (!isControl(el)) return null;
    // Never treat an ordinary page control as a dismissal control.
    if (/\b(apply|submit|sign ?in|log ?in|sign ?up|register|checkout|place order|buy now|captcha|verify)\b/.test(label)) return null;

    if (/^(reject|reject all|decline|decline all|deny|deny all|continue without accepting|without accepting|only necessary|necessary only|essential only|reject non-essential|opt ?out|opt out of all|no thanks to cookies)/.test(label)) return { intent: "reject", rank: 0 };
    if (/^(close|dismiss|no,? thanks|no thanks|maybe later|not now|later|skip|got it|ok|okay|dismiss this|close banner|hide)/.test(label)) return { intent: "close", rank: 1 };
    if (/^[x×✕✖⨯✖x]$/.test(label)) return { intent: "close", rank: 1 };
    if (/^(manage preferences|cookie settings|privacy settings|preferences|manage settings|customise|customize|change preferences|privacy options)/.test(label)) return { intent: "preferences", rank: 3 };
    if (/^(accept|accept all|accept cookies|allow|allow all|agree|i agree|accept and continue|continue|enable all)/.test(label)) return { intent: "accept", rank: 4 };
    return null;
  };

  var CONTAINER_SEL = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],[class*="consent" i],[id*="consent" i],[class*="cookie" i],[id*="cookie" i],[class*="banner" i],[id*="banner" i],[class*="notice" i],[class*="popup" i],[class*="modal" i],[class*="gdpr" i]';

  var containerLabel = function (el) {
    var c = el.closest(CONTAINER_SEL);
    if (!c) return "";
    return c.id ? "#" + c.id : c.tagName.toLowerCase() + (c.className ? "." + String(c.className).split(/\s+/).slice(0, 2).join(".") : "");
  };

  // Open shadow roots only; a closed root is not reachable and pretending
  // otherwise just produces phantom candidates.
  var deepQuery = function (root, selector, out) {
    try { root.querySelectorAll(selector).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); }); } catch (e) { }
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) deepQuery(all[i].shadowRoot, selector, out); }
  };

  var attempts = [];
  var regions = new Map();

  // An INLINE element with no dismiss intent is not an overlay — it is just
  // part of the page. A bare class*=newsletter selector matches the
  // ordinary footer signup block on every Shopify storefront, and treating that
  // as an overlay made Kruz report "an overlay was detected but nothing was
  // clickable" on pages with no overlay at all. Rung 1 therefore admits a
  // vendor-container match only when it is positioned as a layer (fixed /
  // sticky / absolute), or is a dialog-ish role, or actually holds a control
  // with a dismissal intent. Rungs 2 and 3 already apply the structural test.
  var positionedAsLayer = function (el) {
    var p = getComputedStyle(el).position;
    return p === "fixed" || p === "sticky" || p === "absolute";
  };
  var holdsDismissIntent = function (el) {
    var found = [];
    deepQuery(el, "button, [role='button'], input[type='button'], input[type='submit'], summary, [role='menuitem']", found);
    for (var i = 0; i < found.length && i < 24; i++) {
      if (rendered(found[i]) && classify(found[i], "probe")) return true;
    }
    return false;
  };

  // ── rung 1: well-known vendor containers (fast path) ────────────────────
  var knownRegionCount = 0;
  for (var ki = 0; ki < cfg.kinds.length; ki++) {
    var kind = cfg.kinds[ki];
    var sels = KNOWN[kind] || [];
    for (var si = 0; si < sels.length; si++) {
      var found = [];
      deepQuery(document, sels[si], found);
      var n = 0;
      for (var fi = 0; fi < found.length; fi++) {
        var el = found[fi];
        if (regions.has(el)) continue;
        if (!rendered(el)) continue;
        // Never a wrapper around the page's own content.
        if (el.querySelector("main")) continue;
        var layerish = positionedAsLayer(el) ||
          /^(dialog|alertdialog)$/.test(el.getAttribute("role") || "") ||
          el.getAttribute("aria-modal") === "true" ||
          el.hasAttribute("popover") ||
          el.tagName.toLowerCase() === "dialog";
        if (!layerish && !holdsDismissIntent(el)) continue;
        regions.set(el, kind);
        n++;
        if (regions.size >= cfg.maxRegions) break;
      }
      if (n) attempts.push({ strategy: "known-ids", regions: n, controls: 0, note: kind });
    }
  }
  knownRegionCount = regions.size;

  // ── rung 2: top-layer / modal regions ───────────────────────────────────
  // A banner is structurally something painted above the page: a dialog role, an
  // aria-modal container, a dialog element, or a region explicitly labelled as
  // cookie/consent. Far broader than "does its class name contain cookie".
  var TOP_LAYER = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], [role="region"][aria-label*="cookie" i], [role="region"][aria-label*="consent" i], [aria-label*="cookie" i][role], [aria-label*="consent" i][role]';
  var topLayer = [];
  deepQuery(document, TOP_LAYER, topLayer);
  var addedTop = 0;
  for (var ti = 0; ti < topLayer.length; ti++) {
    var tel = topLayer[ti];
    if (regions.has(tel) || !rendered(tel)) continue;
    var r = tel.getBoundingClientRect();
    // A full-viewport "main content" dialog is not a banner.
    if (r.width >= window.innerWidth * 0.98 && r.height >= window.innerHeight * 0.98) continue;
    regions.set(tel, "dialog");
    addedTop++;
  }
  attempts.push({ strategy: "top-layer-regions", regions: addedTop, controls: 0 });

  // ── rung 3: fixed/sticky containers pinned to an edge that own controls ──
  // Catches the long tail. No z-index floor on purpose: a console-shaped
  // banner often ships with a single-digit z-index, and requiring a high one
  // silently excluded exactly the banners this rung exists to find. What makes
  // a region a banner is structural plus the control-intent test.
  var fixedCandidates = [];
  deepQuery(document, "div, section, aside, form", fixedCandidates);
  var addedEdge = 0;
  for (var ei = 0; ei < fixedCandidates.length; ei++) {
    var eel = fixedCandidates[ei];
    if (regions.has(eel) || !rendered(eel)) continue;
    if (eel === document.body || eel === document.documentElement) continue;
    // Never treat a wrapper around the page's own content as a banner.
    if (eel.querySelector("main")) continue;
    var st = getComputedStyle(eel);
    if (st.position !== "fixed" && st.position !== "sticky") continue;
    var er = eel.getBoundingClientRect();
    if (er.width * er.height > window.innerWidth * window.innerHeight * 0.6) continue;
    var touchesEdge = er.top <= 4 || er.bottom >= window.innerHeight - 4 || er.left <= 4 || er.right >= window.innerWidth - 4;
    if (!touchesEdge) continue;
    var ctrls = eel.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (ctrls.length === 0 || ctrls.length > 12) continue;
    regions.set(eel, "edge-panel");
    addedEdge++;
  }
  attempts.push({ strategy: "edge-panels", regions: addedEdge, controls: 0 });

  // ── rank the controls inside every region ───────────────────────────────
  var candidates = [];
  var seen = new Set();
  // Map.forEach yields (value, key) for a map built with set(key, value), so the
  // region ELEMENT is the second argument here. Getting this pair the wrong way
  // round is silent until deepQuery is handed a string instead of a node.
  var candidateNodes = [];
  var regionRows = [];
  var unsorted = [];
  // Every interactive control inside a detected region, whether or not it has a
  // dismissal intent. The refusal path returns these as region_candidates so a
  // caller that cannot let Kruz guess can still see — and click by ref — the
  // explicit Close controls the scan already located. Discarding them was what
  // forced a re-observe to rediscover evidence the scan was holding.
  var allRegionControls = [];
  regions.forEach(function (kind, region) {
    var controls = [];
    deepQuery(region, 'button, a, [role="button"], input[type="button"], input[type="submit"], summary, [role="menuitem"]', controls);
    var regionControls = 0;
    for (var ci = 0; ci < controls.length; ci++) {
      var c = controls[ci];
      if (seen.has(c) || !rendered(c)) continue;
      seen.add(c);
      if (isControl(c)) {
        var cName = nameOf(c);
        if (cName) {
          allRegionControls.push({
            label: cName.slice(0, 80),
            role: roleOf(c),
            name: cName.slice(0, 80),
            actionable: !(c.disabled === true || c.getAttribute("aria-disabled") === "true"),
            container: containerLabel(c),
            region_kind: kind,
            path: ""
          });
        }
      }
      var cls = classify(c, kind);
      if (!cls) continue;
      regionControls++;
      var disabled = c.disabled === true || c.getAttribute("aria-disabled") === "true";
      unsorted.push({
        intent: cls.intent,
        label: nameOf(c).slice(0, 80),
        role: roleOf(c),
        name: nameOf(c).slice(0, 80),
        rank: cls.rank + (disabled ? 50 : 0),
        actionable: !disabled,
        blocked_reason: disabled ? "disabled" : null,
        container: containerLabel(c),
        region_kind: kind,
        path: ""
      });
      candidateNodes.push(c);
    }
    regionRows.push({ kind: kind, label: containerLabel(region) || region.tagName.toLowerCase(), controls: regionControls });
    if (regionControls) attempts.push({ strategy: "rank-controls", regions: 1, controls: regionControls, note: kind });
  });

  // Sort candidates and their nodes together so the dismissal step clicks the
  // element discovery actually identified.
  var order = unsorted.map(function (_, i) { return i; });
  order.sort(function (a, b) { return (unsorted[a].rank - unsorted[b].rank) || String(unsorted[a].label).localeCompare(String(unsorted[b].label)); });
  var candidates = order.map(function (i) { return unsorted[i]; });
  var orderedNodes = order.map(function (i) { return candidateNodes[i]; });
  // Expose the live nodes for the dismissal step.
  try { window.__kruzOverlayNodes = orderedNodes; } catch (e) { }

  return {
    detected: regions.size > 0,
    region: regions.size ? regions.values().next().value : null,
    regions_found: regions.size,
    regions: regionRows,
    candidates: candidates.slice(0, 12),
    region_controls: allRegionControls.slice(0, 24),
    attempts: attempts
  };
}
`;

/** Script that marks a named control and its overlay region for a dismissal. */
export const OVERLAY_FIND_SRC = String.raw`
(function (controlName) {
  var norm = function (s) { return String(s == null ? "" : s).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase(); };
  var want = norm(controlName);
  var rendered = function (el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    var s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    return !el.closest('[hidden],[aria-hidden="true"]');
  };
  var nameOf = function (el) {
    var al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t) return t;
    return (el.getAttribute("title") || el.getAttribute("value") || "").trim();
  };
  var all = [];
  var push = function (root) {
    try { root.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],summary').forEach(function (n) { if (all.indexOf(n) < 0) all.push(n); }); } catch (e) { }
    var every = root.querySelectorAll("*");
    for (var i = 0; i < every.length; i++) if (every[i].shadowRoot) push(every[i].shadowRoot);
  };
  push(document);
  document.querySelectorAll("[data-kruz-overlay-pick]").forEach(function (n) { n.removeAttribute("data-kruz-overlay-pick"); });
  document.querySelectorAll("[data-kruz-overlay-region]").forEach(function (n) { n.removeAttribute("data-kruz-overlay-region"); });
  var hit = null;
  for (var i = 0; i < all.length; i++) { if (rendered(all[i]) && norm(nameOf(all[i])) === want) { hit = all[i]; break; } }
  if (!hit) return { ok: false, reason: "control-gone" };
  var region = hit.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],[class*="consent" i],[id*="consent" i],[class*="cookie" i],[id*="cookie" i],[class*="banner" i],[id*="banner" i],[class*="notice" i],[class*="popup" i],[class*="modal" i],[class*="gdpr" i]');
  (region || hit).setAttribute("data-kruz-overlay-region", "1");
  hit.setAttribute("data-kruz-overlay-pick", "1");
  try { window.__kruzMarkedNode = hit; } catch (e) { }
  return { ok: true, hadRegion: !!region };
})
`;

/**
 * Script that reports whether the dismissed control/region is still there.
 *
 * It deliberately does NOT remove the marks: this is polled until the decision
 * is made, and a poll that cleaned up after itself would make the second poll
 * observe "gone" for a banner that is still on screen. Cleanup is a separate
 * step, run once, after the verdict.
 */
export const OVERLAY_GONE_SRC = String.raw`
(function () {
  var pick = document.querySelector('[data-kruz-overlay-pick="1"]');
  var region = document.querySelector('[data-kruz-overlay-region="1"]');
  var rendered = function (el) {
    if (!el) return false;
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    var s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  return {
    controlGone: !pick || !rendered(pick),
    regionGone: !region || !rendered(region),
    hadControl: !!pick,
    hadRegion: !!region
  };
})
`;

/** Remove the marks once the verdict is final. */
export const OVERLAY_CLEAR_SRC = String.raw`
(function () {
  document.querySelectorAll("[data-kruz-overlay-pick]").forEach(function (n) { n.removeAttribute("data-kruz-overlay-pick"); });
  document.querySelectorAll("[data-kruz-overlay-region]").forEach(function (n) { n.removeAttribute("data-kruz-overlay-region"); });
  return true;
})
`;
