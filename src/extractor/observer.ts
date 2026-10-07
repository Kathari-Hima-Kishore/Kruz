import type { BrowserEngine, KruzElement } from "../browser/engine.js";
import type { Observation, ObservedElement, ObservedText } from "../types/observation.js";
import { ObservationCache } from "./cache.js";
import { detectDelta, observationsEqual } from "./delta.js";
import { RefRegistry } from "../browser/ref-registry.js";
import { specFromTarget, type MatchSpec } from "../browser/inpage-matcher.js";
import { ACCESSIBLE_NAME_BUNDLE_SRC } from "../browser/accessible-name.js";
import type { DetailLevel } from "../types/schema.js";

interface BatchedData { index: number; tag: string; role: string; name: string; value: string; enabled: boolean; href: string | null; raw_href?: string | null; checked: boolean | null; readonly: boolean; required: boolean; type: string | null; path?: string; placeholder?: string | null; name_attr?: string | null; testid?: string | null; in_viewport?: boolean; editable?: boolean; container?: string | null; rect?: { x: number; y: number; w: number; h: number } | null; }

export class Observer {
  private cache: ObservationCache;
  private refMap = new Map<string, any>();
  private registry: RefRegistry;
  private mutationCount = 0;
  private mutationAttached = false;
  private elCounter = 0;
  private txtCounter = 0;

  /**
   * `registry` is the SESSION's ref authority and must be the exact instance the
   * action tools resolve against.
   *
   * This used to be `new RefRegistry()` in both the Observer and the SessionManager,
   * which silently produced two registries with two independent `e` counters: the
   * observer minted `e1..eN` into one, probe/actions minted into the other, and
   * every ref `page.observe` handed the model came back as UNKNOWN_REFERENCE from
   * `page.click`. Passing the session registry in makes it structurally impossible
   * for the two to diverge again. The default is only for standalone use (tests
   * that drive the Observer on its own).
   */
  constructor(cacheSize = 100, registry?: RefRegistry) {
    this.cache = new ObservationCache(cacheSize);
    this.registry = registry ?? new RefRegistry();
  }

  /** The session's ref authority — the one instance producers and consumers share. */
  getRegistry(): RefRegistry { return this.registry; }

  async observe(engine: BrowserEngine, scope?: string, detail: DetailLevel = "minimal", forceFull = false): Promise<{ observation: Observation; isDelta: boolean }> {
    const t0 = Date.now();
    const url = await engine.url();
    const tabs = await engine.listTabs();
    const activeTab = tabs.find(t => t.isActive);
    const pageId = activeTab?.id ?? "p1";
    const documentId = await this.documentId(engine);
    // A ref only means something inside the document that minted it. Dropping
    // foreign refs here is what stops a pre-navigation ref from being
    // re-resolved against the new page and landing on a stranger.
    this.registry.invalidateForeign(pageId, documentId);
    const revision = await this.getRevision(engine);
    const key = { page_id: pageId, url, revision, scope: scope || "body", detail };

    if (!forceFull) { const cached = this.cache.get(key); if (cached) { cached.timing = { total_ms: Date.now() - t0, cache_hit: 1 }; return { observation: cached, isDelta: false }; } }
    const prev = this.cache.get({ page_id: pageId, url, revision: revision - 1, scope: scope || "body", detail });
    this.ensureMutation(engine);

    // Wait for meaningful content on heavy SPAs (up to 3s)
    const hasContentResult = await engine.evaluate(`document.querySelectorAll("a, button, input, select, textarea, [role], h1, h2, h3, p, li, td, th").length`).catch(() => ({ ok: false as const }));
    const hasContent = hasContentResult.ok ? (hasContentResult.result as number) : 0;
    if (hasContent < 2) {
      for (let i = 0; i < 6; i++) {
        await engine.waitMs(500).catch(() => {});
        const countResult = await engine.evaluate(`document.querySelectorAll("a, button, input, select, textarea, [role], h1, h2, h3, p, li, td, th").length`).catch(() => ({ ok: false as const }));
        const count = countResult.ok ? (countResult.result as number) : 0;
        if (count >= 2) break;
      }
    }

    const tGen = Date.now();
    const obs = await this.generate(engine, pageId, url, revision, scope, detail, documentId);
    // Diagnostic metadata: how long the observation actually took, measured
    // inside the process rather than by the caller wrapping a timer.
    obs.timing = { total_ms: Date.now() - t0, generate_ms: Date.now() - tGen };
    this.cache.set(key, obs);
    if (prev && observationsEqual(prev, obs)) obs.changed = [];
    return { observation: obs, isDelta: prev !== null && obs.changed.length > 0 };
  }

  async delta(engine: BrowserEngine, prev: Observation, scope?: string, detail: DetailLevel = "minimal"): Promise<Observation> {
    const { observation: cur } = await this.observe(engine, scope, detail, true);
    return { ...cur, changed: detectDelta(prev, cur).changed.map(c => c.ref) };
  }

  getRefMap() { return this.refMap; }
  getRefs() { return this.registry; }
  clearCache() { this.cache.clear(); }
  invalidatePage(pid: string) { this.cache.invalidatePage(pid); }
  bumpMutation() { this.mutationCount++; }

  /**
   * Document identity. `performance.timeOrigin` is unique per document, so a
   * ref minted in one document can never be silently re-resolved in the next.
   */
  private async documentId(engine: BrowserEngine): Promise<string> {
    const r = await engine.evaluate("String(performance && performance.timeOrigin || 'nodoc')").catch(() => null);
    return r?.ok ? String(r.result) : "nodoc";
  }

  registerFormRef(ref: string, engine: BrowserEngine, selector: string, scope?: string) {
    // This is a sync stub; actual resolution should happen via resolveElement in the controller
    this.refMap.set(ref, { locator: null, semantic: null, formRef: true, scope, selector });
  }

  private ensureMutation(engine: BrowserEngine): void {
    if (this.mutationAttached) return;
    this.mutationAttached = true;
    engine.onPageLoad(() => { this.mutationCount++; this.mutationAttached = false; });
    engine.evaluate(`(() => {
      let c = 0;
      // Kruz's own overlay must NOT count. pageFeedback's signature includes this
      // counter, and that signature is what decides \`dom_changed\` — i.e. whether an
      // action changed anything. The banner is rebuilt in the LIGHT DOM and its
      // inline styles change on every state transition, so Kruz was marking its own
      // housekeeping as page mutation: an action that provably did nothing still
      // reported dom_changed:true. Both overlay nodes carry [data-kruz] precisely so
      // they can be excluded here. (The closed shadow root was never observed anyway;
      // it is the light-DOM banner that leaked.)
      const isOwn = (n) => {
        try {
          if (!n || n.nodeType !== 1) return false;
          if (typeof n.closest === 'function' && n.closest('[data-kruz]')) return true;
          const host = n.getRootNode && n.getRootNode().host;
          return !!(host && host.hasAttribute && host.hasAttribute('data-kruz'));
        } catch (e) { return false; }
      };
      new MutationObserver((recs) => {
        for (const r of recs) if (!isOwn(r.target)) c++;
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      (window).__p1MutationCount = () => c;
    })()`).catch(() => { this.mutationAttached = false; });
  }

  private async generate(engine: BrowserEngine, pageId: string, url: string, revision: number, scope?: string, detail: DetailLevel = "minimal", documentId = "unknown"): Promise<Observation> {
    const elements: ObservedElement[] = [];
    const text: ObservedText[] = [];
    const sel = this.buildSelector(scope);
    const maxText = detail === "minimal" ? 10 : detail === "standard" ? 30 : 100;
    // `minimal` is the agent-control view, so it stays small enough to be read
    // in full. The manual report hit a ~55 KB observation that the client
    // truncated; that was `standard`/`full` on a dense portal. Rather than just
    // capping harder, `minimal` also compacts each element (see `compact` below)
    // so the same number of elements costs far fewer bytes.
    const maxElements = detail === "minimal" ? 80 : detail === "standard" ? 400 : 2000;
    const nameCap = detail === "minimal" ? 80 : 200;
    const valueCap = detail === "minimal" ? 60 : 500;
    // P1-F: report when a cap hid real content instead of truncating silently.
    let totalElementMatches = 0;

    const isComboboxScope = !!(scope && /(combobox|listbox|menu|search)/i.test(scope));

    // Batch 1: interactive elements
    const batched: BatchedData[] = [];
    try {
      const selJson = sel.replace(/'/g, "\\'");
      const rawResult: any = await engine.evaluate(`(() => {
${ACCESSIBLE_NAME_BUNDLE_SRC}
        const s = '${selJson}';
        const root = document.querySelector(s);
        if (!${!!scope} && !root && !${isComboboxScope}) return [];
        const target = root || document.body;
        const qs = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="slider"], [role="searchbox"], [tabindex]';
        const out = [];
        const seen = new Set();
        // A piercing path back to the node, so a ref stays resolvable after the
        // page re-renders. Puppeteer understands ">>>" for open shadow roots.
        const deepPath = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          const segs = [];
          let cur = el, guard = 0;
          while (cur && cur.nodeType === 1 && guard++ < 8) {
            const parent = cur.parentElement;
            const root = cur.getRootNode();
            let seg = cur.tagName.toLowerCase();
            if (parent) {
              const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
              if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
            } else if (root && root !== document && root.host) {
              seg += ':nth-of-type(1)';
            } else {
              seg += ':nth-of-type(1)';
            }
            segs.unshift(seg);
            // Crossing a shadow boundary: jump to the host and mark the pierce.
            if (root && root !== document && root.host) {
              segs.unshift('>>>');
              cur = root.host;
              continue;
            }
            if (!parent) break;
            cur = parent;
          }
          // CHILD combinator, not descendant — see the identical fix in inpage-scripts.ts
          // (BUG-004). Bare "div" segments with a space fan out to every matching
          // branch, so an observed ref could not be re-found by its own path.
          return segs.join(' > ').replace(/\\s*>>>\\s*/g, ' >>> ').trim();
        };
        // Nearest overlay-ish container, matching the matcher's definition, so an
        // observed ref can be verified against its banner/dialog root after a
        // dismissal click.
        const containerSignature = (el) => {
          const c = el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i], [class*="banner" i], [id*="banner" i], [class*="notice" i], [class*="popup" i], [class*="modal" i]');
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return (c.id ? '#' + c.id : c.tagName.toLowerCase() + '.' + String(c.className || '').split(/\\s+/)[0]) + '@' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
        };
        const capture = (node) => {
          if (seen.has(node)) return;
          seen.add(node);
          const el = node;
          if (el.offsetParent === null && el.tagName !== "BODY") return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          const tag = el.tagName.toLowerCase();
          const ra = el.getAttribute("role");
          let role = ra || "";
          if (!role) {
            if (tag === "a") role = "link";
            else if (tag === "button") role = "button";
            else if (tag === "input") { const it = el.type; role = it === "checkbox" ? "checkbox" : it === "radio" ? "radio" : it === "submit" ? "button" : it === "search" ? "searchbox" : it === "range" ? "slider" : it === "number" ? "spinbutton" : it === "file" ? "textbox" : "textbox"; }
            else if (tag === "select") role = "combobox";
            else if (tag === "textarea") role = "textbox";
            else role = "generic";
          }
          if (["heading", "generic", "img", "presentation", "none"].includes(role)) return;

          // Name comes from the ONE canonical implementation shared with the
          // action-path matcher (src/browser/accessible-name.ts). This used to be
          // a second, independently drifting copy: it ordered aria-label above
          // aria-labelledby, read only the FIRST id of an aria-labelledby, did
          // not collapse whitespace, capped text at 100 chars instead of 200, and
          // excluded <select> from its own text while the matcher did not. A
          // node therefore got a different logical identity depending on which
          // subsystem happened to observe it.
          const an = __kruzAccessibleName(el);
          const name = an.name;

          let value = "";
          if (tag === "input" || tag === "textarea") value = el.value || "";
          else if (tag === "select") value = el.value || "";

          let checked = null;
          if (role === "checkbox" || role === "radio") checked = el.checked;

          out.push({ index: out.length, tag, role, name: name.substring(0, 200), value: value.substring(0, 500), enabled: !el.disabled, href: tag === "a" ? (el.href || null) : null, raw_href: tag === "a" ? el.getAttribute("href") : null, checked, readonly: el.readOnly || false, required: el.required || false, type: el.type || null, path: deepPath(el), placeholder: el.getAttribute("placeholder"), name_attr: el.getAttribute("name"), testid: el.getAttribute("data-testid"), in_viewport: r.bottom > 0 && r.right > 0 && r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0), editable: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && !el.disabled, container: containerSignature(el), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
        };
        const targets = [];
        if (${isComboboxScope}) {
          const listboxes = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [aria-expanded="true"][aria-controls]')).slice(0, 20);
          for (const lb of listboxes) {
            const ctl = lb.getAttribute("aria-controls");
            if (ctl) { const own = document.getElementById(ctl); if (own) targets.push(own); }
            targets.push(lb);
          }
          targets.forEach(t => t.querySelectorAll('[role="option"], [role="menuitem"]').forEach(c => capture(c)));
        }
        // Walk the light tree AND descend into open shadow roots. Component-based
        // portals (Shoelace, Lit, Stencil, Salesforce LWC, Oracle HCM) render their
        // interactive controls inside shadow roots; a light-DOM-only sweep made
        // every one of them invisible, so the model could neither see them nor get
        // a ref to click. Bounded to keep the single evaluate cheap.
        const MAX_HOSTS = 400, MAX_DEPTH = 8;
        let hosts = 0;
        const walk = (node, depth) => {
          node.querySelectorAll(qs).forEach((n) => capture(n));
          if (depth >= MAX_DEPTH || hosts >= MAX_HOSTS) return;
          const all = node.querySelectorAll('*');
          for (let i = 0; i < all.length && hosts < MAX_HOSTS; i++) {
            const sr = all[i].shadowRoot;
            if (sr) { hosts++; walk(sr, depth + 1); }
          }
        };
        walk(target, 0);
        return out;
      })()`).catch(() => ({ ok: false as const }));

      if (rawResult.ok && Array.isArray(rawResult.result)) {
        totalElementMatches = rawResult.result.length;
        for (const r of rawResult.result.slice(0, maxElements)) batched.push(r);
      }
    } catch { /* page not ready */ }

    // Mint every observed element through the SHARED ref registry. This is the
    // single place refs come into existence, which is what lets page.probe hand
    // the model a ref that page.click can actually resolve.
    const scopeSelector = scope || "body";
    for (const d of batched) {
      // The spec is reconstructed from what we observed, so the registry can
      // re-resolve this element semantically (Tier 2/3) after a re-render.
      // A link's identity is its RESOLVED destination — the DOM attribute is
      // usually relative, so an `a[href="<absolute>"]` selector would match
      // nothing and a valid ref would be reported stale.
      const spec: MatchSpec = { scope: scopeSelector, strategy: "observe" };
      if (d.tag === "a" && d.href) { spec.resolvedHref = d.href; spec.strategy = "resolvedHref"; }
      else if (d.testid) { spec.testid = d.testid; spec.strategy = "testid"; }
      else if (d.name_attr) { spec.nameAttr = d.name_attr; spec.strategy = "nameAttr"; }
      else if (d.placeholder) { spec.placeholder = d.placeholder; spec.strategy = "placeholder"; }
      else { spec.css = d.tag; spec.strategy = "css"; }

      const entry = this.registry.mint("observe", {
        i: d.index,
        path: d.path ?? "",
        tag: d.tag,
        role: d.role,
        name: d.name,
        name_source: "",
        href: d.href ?? null,
        raw_href: d.raw_href ?? null,
        placeholder: d.placeholder ?? null,
        type: d.type ?? null,
        name_attr: d.name_attr ?? null,
        testid: d.testid ?? null,
        value: d.value || null,
        checked: d.checked ?? null,
        visible: true,
        enabled: d.enabled,
        in_viewport: d.in_viewport ?? false,
        editable: d.editable ?? false,
        actionable: d.enabled,
        blocked_reason: d.enabled ? null : "disabled or aria-disabled=true",
        container: d.container ?? null,
        rect: d.rect ?? null,
        context: null,
      }, { pageId, documentId, frameId: "main", spec, scope: scopeSelector, revision });

      const ref = entry.ref;
      // Compact: drop fields that are false/null in the common case. An agent
      // choosing an action cares about role, name and whether it is enabled;
      // `readonly: false` on every row is pure payload.
      const el: ObservedElement = { ref, role: d.role, name: d.name.slice(0, nameCap) };
      if (d.value) el.value = d.value.slice(0, valueCap);
      if (d.href) el.href = d.href;
      if (d.type) el.type = d.type;
      if (detail !== "minimal") {
        el.enabled = d.enabled;
        if (d.checked !== null) el.checked = d.checked;
        if (d.readonly) el.readonly = true;
        if (d.required) el.required = true;
      } else {
        // Keep the one boolean an agent actually acts on.
        if (!d.enabled) el.enabled = false;
      }
      elements.push(el);

      // Legacy alias kept so existing consumers that read the observer's map
      // directly (e.g. the ref-TTL path) still see the entry.
      const cssSel = d.tag === "input" && d.type ? `input[type='${d.type}']` : d.tag;
      this.refMap.set(ref, { locator: null, css: d.path, semantic: { ...entry } });
    }

    // Batch 2: text nodes
    let totalTextMatches = 0;
    try {
      const selJson2 = sel.replace(/'/g, "\\'");
      const linesResult: any = await engine.evaluate(`(() => {
        const s = '${selJson2}';
        const root = document.querySelector(s);
        if (!${!!scope} && !root) return [];
        const target = root || document.body;
        const lines = [];
        const push = (t) => { for (const l of (t || "").split("\\n")) { const v = l.trim(); if (v) lines.push(v); } };
        push(target.innerText);
        // innerText does not descend into shadow roots (and a ShadowRoot has no
        // innerText of its own — it is a DocumentFragment), so component-rendered
        // copy (button labels, option text, validation messages) was missing
        // entirely. Collect leaf-element text from each open root instead.
        let hosts = 0;
        const pushShadow = (sr) => {
          for (const el of sr.querySelectorAll('*')) {
            if (el.children.length) continue;
            const t = (el.textContent || '').trim();
            if (t && t.length < 500) push(t);
          }
        };
        const visit = (node, depth) => {
          if (depth >= 8 || hosts >= 400) return;
          for (const n of node.querySelectorAll('*')) {
            if (n.shadowRoot && hosts < 400) { hosts++; pushShadow(n.shadowRoot); visit(n.shadowRoot, depth + 1); }
          }
        };
        visit(target, 0);
        return Array.from(new Set(lines));
      })()`).catch(() => ({ ok: false as const }));

      if (linesResult.ok && Array.isArray(linesResult.result)) {
        const lines: string[] = linesResult.result;
        totalTextMatches = lines.length;
        const take = Math.min(lines.length, maxText);
        for (let i = 0; i < take; i++) {
          const ref = `t${++this.txtCounter}`;
          text.push({ ref, text: lines[i] });
          // K31: Do NOT map text lines through queryOne ({ text }) — that built a
          // ':text("...")' selector and ran page.waitForSelector with a 3s timeout per line.
          // With up to `maxText` lines and text often split across nodes/iframes/shadow DOM,
          // puppeteer's built-in :text matcher can wait the full 3s on every line, blowing
          // page.observe past its route budget. Text probing here is best-effort and should
          // never block; skip the refMap binding instead of waiting on a selector.
        }
      }
    } catch { /* ignore */ }

    const observation: Observation = { page_id: pageId, url, title: await engine.title().catch(() => ""), revision, scope: scope || "body", elements, text, changed: [], detail };
    // P1-F: surface the cap honestly (fields are additive; absent when nothing was cut).
    if (totalElementMatches > elements.length || totalTextMatches > text.length) {
      observation.truncated = true;
      observation.returned_elements = elements.length;
      observation.total_elements_estimate = totalElementMatches;
      observation.returned_text = text.length;
      observation.total_text_estimate = totalTextMatches;
      observation.truncation_hint = detail === "full" ? "Even 'full' is capped; narrow with a scope." : `Raise detail to 'full' or narrow with a scope to see more than ${elements.length} elements.`;
    }
    return observation;
  }

  private buildSelector(scope?: string): string {
    if (!scope) return "body";
    const map: Record<string, string> = {
      main: "main, [role='main'], #main, .main, [aria-label='Main']",
      nav: "nav, [role='navigation'], #nav, .nav, [aria-label='Navigation']",
      header: "header, [role='banner'], #header, .header",
      footer: "footer, [role='contentinfo'], #footer, .footer",
      dialog: "dialog, [role='dialog'], .modal, .dialog, [aria-modal='true']",
      form: "form, [role='form'], section[role='form'], div[role='form']",
      table: "table, [role='table'], [role='grid'], [role='treegrid']",
      search: "search, [role='search'], #search, .search",
      article: "article, [role='article'], #article, .article",
      section: "section, [role='region'], #section, .section",
    };
    return map[scope] || scope;
  }

  private async getRevision(engine: BrowserEngine): Promise<number> {
    const url = await engine.url();
    const title = await engine.title();
    let pageMut = 0;
    try {
      const mutResult = await engine.evaluate(`(window).__p1MutationCount?.() ?? 0`);
      if (mutResult.ok) pageMut = (mutResult.result as number) ?? 0;
    } catch { /* ok */ }
    const str = `${url}|${title}|${this.mutationCount}|${pageMut}`;
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
    return Math.abs(h);
  }
}
