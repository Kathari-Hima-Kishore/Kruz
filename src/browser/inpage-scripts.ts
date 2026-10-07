/**
 * inpage-scripts — the in-page programs, stored as explicit source strings.
 *
 * These used to be TypeScript functions serialised with `Function.prototype
 * .toString()`. That is fragile in a way that hides well: esbuild's `keepNames`
 * pass (enabled by tsx, and by several bundler configs) rewrites a named
 * function's body to `__name(fn, "fn")`, and `__name` does not exist in the
 * page. The result is a `ReferenceError: __name is not defined` at runtime that
 * passes under one transpiler and fails under another.
 *
 * Storing the source as a string removes the whole class of problem: there is
 * nothing for a transpiler to rewrite, and the page receives exactly the
 * characters written here.
 */

import type { MatchSpec } from "./inpage-matcher.js";
import { ACCESSIBLE_NAME_BUNDLE_SRC } from "./accessible-name.js";

/**
 * The matcher. Also the single source of element identity for the whole server:
 * page.probe, page.click, page.fill, page.select, page.check and overlay
 * discovery all execute these exact characters.
 */
export const MATCHER_SRC = String.raw`
function __kruzMatcher(args) {
  var norm = function (s) { return String(s == null ? "" : s).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase(); };
  var style = function (el) { try { return getComputedStyle(el); } catch (e) { return {}; } };

  var isRendered = function (el) {
    if (!el.isConnected) return false;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || !(r.width > 0 && r.height > 0)) return false;
    var s = style(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    if (s.opacity === "0") return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  };

  var isDisabled = function (el) {
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.hasAttribute("disabled")) return true;
    return false;
  };

  var isEditable = function (el) {
    if (el instanceof HTMLInputElement) return el.type !== "hidden" && !el.disabled && !el.readOnly;
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
    if (el instanceof HTMLSelectElement) return !el.disabled;
    return el.isContentEditable === true;
  };

  var implicitRole = function (el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "input") {
      var t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "p") return "paragraph";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    return "generic";
  };

  // Accessible name is shared with the page observer via ONE implementation
  // (src/browser/accessible-name.ts). It used to be duplicated here, and the
  // two copies drifted apart on five rules -- see that file for the table.
  // Embedding the canonical source is what stops a node acquiring two
  // different logical identities depending on which subsystem looked at it.
${ACCESSIBLE_NAME_BUNDLE_SRC}
  var accessibleName = __kruzAccessibleName;

  var deepPath = function (el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var segs = [];
    var cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 8) {
      var parent = cur.parentElement;
      var root = cur.getRootNode();
      var seg = cur.tagName.toLowerCase();
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (sibs.length > 1) seg += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
      segs.unshift(seg);
      if (root && root !== document && root.host) { segs.unshift(">>>"); cur = root.host; continue; }
      if (!parent) break;
      cur = parent;
    }
    // CHILD combinator, not descendant. ":nth-of-type" is only emitted when an
    // element has same-tag siblings, so a run of lone-child divs contributes bare
    // "div" segments. Joined with a space those fan out and the path matches every
    // matching branch — measured on makerbazar.in:
    //   "section div div div div div div a:nth-of-type(1)"  -> 4 anchors
    // which silently defeated Tier-1 identity, pushed every ref onto semantic
    // matching, and made repeated links permanently ambiguous (BUG-004).
    return segs.join(" > ").replace(/\s*>>>\s*/g, " >>> ").trim();
  };

  var CONTAINER_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i], [class*="banner" i], [id*="banner" i], [class*="notice" i], [class*="popup" i], [class*="modal" i]';

  var containerSignature = function (el) {
    var c = el.closest(CONTAINER_SEL);
    if (!c) return null;
    var r = c.getBoundingClientRect();
    return (c.id ? "#" + c.id : c.tagName.toLowerCase() + "." + String(c.className || "").split(/\s+/)[0]) +
      "@" + Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width) + "x" + Math.round(r.height);
  };

  var describe = function (el, i) {
    var tag = el.tagName.toLowerCase();
    var an = accessibleName(el);
    var name = an.name, source = an.source;
    var visible = isRendered(el);
    var enabled = !isDisabled(el);
    var editable = isEditable(el);
    var rect = null, inViewport = false;
    if (visible) {
      var r = el.getBoundingClientRect();
      rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      inViewport = r.bottom > 0 && r.right > 0 && r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
    }
    var actionable = visible && enabled;
    var blocked = null;
    if (!visible) blocked = "not rendered (display:none, visibility:hidden, hidden ancestor, or zero size)";
    else if (!enabled) blocked = "disabled or aria-disabled=true";
    var isField = (el instanceof HTMLInputElement) || (el instanceof HTMLTextAreaElement) || (el instanceof HTMLSelectElement);
    return {
      i: i,
      path: deepPath(el),
      tag: tag,
      role: implicitRole(el),
      name: name.slice(0, 200),
      name_source: source,
      href: tag === "a" || tag === "area" ? (el.href || null) : null,
      // The RAW attribute, kept alongside the resolved URL: identity must be
      // compared after resolution, but diagnostics need what the page actually
      // said.
      raw_href: (tag === "a" || tag === "area") ? el.getAttribute("href") : null,
      placeholder: el.getAttribute("placeholder"),
      type: tag === "input" ? (el.type || null) : null,
      name_attr: el.getAttribute("name"),
      testid: el.getAttribute("data-testid"),
      value: isField ? (el.value || "") : null,
      checked: (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) ? el.checked : null,
      visible: visible,
      enabled: enabled,
      in_viewport: inViewport,
      editable: editable,
      actionable: actionable,
      blocked_reason: blocked,
      container: containerSignature(el),
      rect: rect,
      context: (function () {
        var h = el.closest("section,article,li,tr,form,label");
        var t = h ? (h.textContent || "").replace(/\s+/g, " ").trim() : "";
        return t && t.length < 120 ? t.slice(0, 100) : null;
      })()
    };
  };

  var spec = args.spec;
  var limit = Math.max(1, Math.min(200, args.limit || 50));
  var CANDIDATES = "a,button,input,select,textarea,summary,option,[role],[onclick],[tabindex],label,div,span,p,li,td,th,h1,h2,h3,h4,h5,h6,img";
  var nodes = [];
  var strategy = "none";
  var root = spec.scope ? (document.querySelector(spec.scope) || document) : document;

  // Descend into OPEN shadow roots. Component-based portals (Shoelace, Lit,
  // Salesforce LWC, Oracle HCM) render their controls inside shadow roots; a
  // light-DOM-only matcher makes every one of them invisible, which is exactly
  // the "the observer saw it but the action path could not" failure this module
  // exists to remove. Closed roots are unreachable and are not pretended at.
  var collect = function (sel, out) {
    try { root.querySelectorAll(sel).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); }); } catch (e) { }
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) collectInto(all[i].shadowRoot, sel, out, 0); }
  };
  var collectInto = function (r, sel, out, depth) {
    if (depth > 8) return;
    try { r.querySelectorAll(sel).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); }); } catch (e) { }
    var all = r.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) collectInto(all[i].shadowRoot, sel, out, depth + 1); }
  };

  var allIn = function (sel) {
    var out = [];
    collect(sel, out);
    return out;
  };

  // The ">>>" separator is a Puppeteer-selector combinator, NOT CSS. This program
  // runs through engine.evaluate, so the raw in-page querySelectorAll used by
  // collect() THROWS on it and the catch swallows the failure — a Tier-1 path
  // recorded for a node inside a shadow root therefore resolved to ZERO matches,
  // the resolver fell through to the semantic tier, and a specific ref degraded
  // into AMBIGUOUS_TARGET against a same-named sibling. Walk the segments through
  // open roots explicitly so the recorded path still names exactly one node.
  var pierceAll = function (sel) {
    var parts = String(sel).split(/\s*>>>\s*/).filter(function (p) { return p.length; });
    if (parts.length < 2) return null;
    var ctx = [document];
    for (var p = 0; p < parts.length; p++) {
      var seg = parts[p];
      var next = [];
      for (var ci = 0; ci < ctx.length; ci++) {
        var c = ctx[ci];
        try { c.querySelectorAll(seg).forEach(function (n) { if (next.indexOf(n) < 0) next.push(n); }); } catch (e) { }
        if (c.shadowRoot) {
          try { c.shadowRoot.querySelectorAll(seg).forEach(function (n) { if (next.indexOf(n) < 0) next.push(n); }); } catch (e2) { }
        }
      }
      ctx = next;
      if (!ctx.length) return [];
    }
    return ctx;
  };

  if (spec.resolvedHref) {
    // Canonical destination identity. The recorded href is the RESOLVED absolute
    // URL, but the DOM attribute may be relative ("3.13.html"), so an
    // a[href="https://…"] selector matches nothing. Resolve every anchor's
    // attribute against document.baseURI in-page and compare the result, which
    // handles relative, root-relative, ../, fragment, query and <base href>.
    strategy = "resolvedHref";
    var want = String(spec.resolvedHref);
    var canon = function (u) {
      try { var x = new URL(u, document.baseURI); x.hash = x.hash; return x.href; }
      catch (e) { return String(u); }
    };
    var wantCanon = canon(want);
    var anchors = allIn("a[href], area[href]");
    nodes = anchors.filter(function (a) {
      var raw = a.getAttribute("href");
      if (raw == null) return false;
      return canon(raw) === wantCanon;
    });
  } else if (spec.css) {
    strategy = "css";
    var pierced = pierceAll(spec.css);
    nodes = pierced === null ? allIn(spec.css) : pierced;
  } else if (spec.role) {
    strategy = spec.name ? "role+name" : "role";
    var pool = allIn(CANDIDATES);
    var wantRole = norm(spec.role);
    var wantName = spec.name ? norm(spec.name) : null;
    for (var pi = 0; pi < pool.length; pi++) {
      var n0 = pool[pi];
      if (norm(implicitRole(n0)) !== wantRole) continue;
      if (wantName !== null) {
        var got = norm(accessibleName(n0).name);
        // role+name is an EXACT contract: exact hit, else whole-word containment.
        // Never a fuzzy substring of a different control.
        if (got !== wantName && !(got.length > wantName.length && got.indexOf(" " + wantName + " ") >= 0)) continue;
      }
      nodes.push(n0);
    }
  } else if (spec.label) {
    strategy = "label";
    var wantLabel = norm(spec.label);
    var labelPool = allIn('input,select,textarea,[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[contenteditable]');
    for (var li = 0; li < labelPool.length; li++) {
      var lt = norm(__kruzLabelText(labelPool[li]));
      if (lt === wantLabel || (lt.length > wantLabel.length && lt.indexOf(" " + wantLabel + " ") >= 0)) nodes.push(labelPool[li]);
    }
  } else if (spec.placeholder) {
    // The field is named "placeholder", so it means the DOM placeholder property
    // -- NOT the accessible name. Exact first, then whole-word containment, so
    // it can never silently resolve to a differently-labelled control.
    strategy = "placeholder";
    var wantPh = norm(spec.placeholder);
    var exactPh = [], loosePh = [];
    var phPool = allIn("[placeholder]");
    for (var qi = 0; qi < phPool.length; qi++) {
      var gotPh = norm(phPool[qi].placeholder);
      if (gotPh === wantPh) exactPh.push(phPool[qi]);
      else if (gotPh.length > wantPh.length && gotPh.indexOf(" " + wantPh + " ") >= 0) loosePh.push(phPool[qi]);
    }
    nodes = exactPh.length ? exactPh : loosePh;
  } else if (spec.text) {
    strategy = "text";
    var wantText = norm(spec.text);
    var own = function (n) {
      var t = "";
      for (var c = 0; c < n.childNodes.length; c++) if (n.childNodes[c].nodeType === 3) t += n.childNodes[c].nodeValue;
      return t.replace(/\s+/g, " ").trim().toLowerCase();
    };
    var deep = function (n) {
      for (var c = 0; c < (n.children ? n.children.length : 0); c++) if (own(n.children[c]) === wantText || deep(n.children[c])) return true;
      return false;
    };
    var textPool = allIn(CANDIDATES);
    for (var ti = 0; ti < textPool.length; ti++) if (own(textPool[ti]) === wantText && !deep(textPool[ti])) nodes.push(textPool[ti]);
  } else if (spec.testid) {
    strategy = "testid";
    nodes = allIn('[data-testid="' + String(spec.testid).replace(/"/g, '\\"') + '"]');
  } else if (spec.nameAttr) {
    strategy = "nameAttr";
    nodes = allIn('[name="' + String(spec.nameAttr).replace(/"/g, '\\"') + '"]');
  } else if (spec.id) {
    strategy = "id";
    var byId = document.getElementById(String(spec.id));
    if (byId) nodes = [byId];
  }

  var total = nodes.length;
  var take = nodes.slice(0, limit);
  var matches = take.map(describe);
  var actionableCount = 0;
  for (var ai = 0; ai < matches.length; ai++) if (matches[ai].actionable) actionableCount++;
  // Live nodes must NEVER be part of the returned value: this result crosses the
  // CDP boundary, and DOM nodes are not serializable. On a small page the
  // serializer quietly drops them; on a larger one it can void the ENTIRE
  // result, which is how "probe finds nothing" happens on exactly the dense
  // pages where you most need it. When the caller wants the nodes (the marking
  // step), stash them on the window instead and return plain data only.
  if (args.captureNodes) {
    try { window.__kruzMatchNodes = take; } catch (e) { }
  }
  return {
    count: total,
    actionable_count: actionableCount,
    matches: matches,
    truncated: total > take.length,
    total: total,
    strategy: strategy
  };
}
`;

/** Build the matcher invocation for a spec. */
export function matcherCall(spec: MatchSpec, limit: number, captureNodes = false): string {
  return `(${MATCHER_SRC})({spec:${JSON.stringify(spec as unknown as Record<string, string | null>)},limit:${Math.max(1, Math.min(200, limit))},captureNodes:${captureNodes ? "true" : "false"}})`;
}
