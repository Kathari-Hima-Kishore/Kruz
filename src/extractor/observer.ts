import type { BrowserEngine, KruzElement } from "../browser/engine.js";
import type { Observation, ObservedElement, ObservedText } from "../types/observation.js";
import { ObservationCache } from "./cache.js";
import { detectDelta, observationsEqual } from "./delta.js";
import type { DetailLevel } from "../types/schema.js";

interface BatchedData { index: number; tag: string; role: string; name: string; value: string; enabled: boolean; href: string | null; checked: boolean | null; readonly: boolean; required: boolean; type: string | null; }

export class Observer {
  private cache: ObservationCache;
  private refMap = new Map<string, any>();
  private mutationCount = 0;
  private mutationAttached = false;
  private elCounter = 0;
  private txtCounter = 0;

  constructor(cacheSize = 100) { this.cache = new ObservationCache(cacheSize); }

  async observe(engine: BrowserEngine, scope?: string, detail: DetailLevel = "minimal", forceFull = false): Promise<{ observation: Observation; isDelta: boolean }> {
    const url = await engine.url();
    const tabs = await engine.listTabs();
    const activeTab = tabs.find(t => t.isActive);
    const pageId = activeTab?.id ?? "p1";
    const revision = await this.getRevision(engine);
    const key = { page_id: pageId, url, revision, scope: scope || "body", detail };

    if (!forceFull) { const cached = this.cache.get(key); if (cached) return { observation: cached, isDelta: false }; }
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

    const obs = await this.generate(engine, pageId, url, revision, scope, detail);
    this.cache.set(key, obs);
    if (prev && observationsEqual(prev, obs)) obs.changed = [];
    return { observation: obs, isDelta: prev !== null && obs.changed.length > 0 };
  }

  async delta(engine: BrowserEngine, prev: Observation, scope?: string, detail: DetailLevel = "minimal"): Promise<Observation> {
    const { observation: cur } = await this.observe(engine, scope, detail, true);
    return { ...cur, changed: detectDelta(prev, cur).changed.map(c => c.ref) };
  }

  getRefMap() { return this.refMap; }
  clearCache() { this.cache.clear(); }
  invalidatePage(pid: string) { this.cache.invalidatePage(pid); }
  bumpMutation() { this.mutationCount++; }

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
      new MutationObserver(() => c++).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      (window).__p1MutationCount = () => c;
    })()`).catch(() => { this.mutationAttached = false; });
  }

  private async generate(engine: BrowserEngine, pageId: string, url: string, revision: number, scope?: string, detail: DetailLevel = "minimal"): Promise<Observation> {
    const elements: ObservedElement[] = [];
    const text: ObservedText[] = [];
    const sel = this.buildSelector(scope);
    const maxText = detail === "minimal" ? 10 : detail === "standard" ? 30 : 100;
    const maxElements = detail === "minimal" ? 120 : detail === "standard" ? 400 : 2000;

    const isComboboxScope = !!(scope && /(combobox|listbox|menu|search)/i.test(scope));

    // Batch 1: interactive elements
    const batched: BatchedData[] = [];
    try {
      const selJson = sel.replace(/'/g, "\\'");
      const rawResult: any = await engine.evaluate(`(() => {
        const s = '${selJson}';
        const root = document.querySelector(s);
        if (!${!!scope} && !root && !${isComboboxScope}) return [];
        const target = root || document.body;
        const qs = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="slider"], [role="searchbox"], [tabindex]';
        const out = [];
        const seen = new Set();
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

          let name = el.getAttribute("aria-label") || "";
          if (!name) { const lb = el.getAttribute("aria-labelledby"); if (lb) { const le = document.getElementById(lb); if (le) name = le.textContent?.trim() || ""; } }
          if (!name && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) { const id = el.id; if (id) { const l = document.querySelector('label[for="' + id + '"]'); if (l) name = l.textContent?.trim() || ""; } if (!name) { const pl = el.closest("label"); if (pl) name = pl.textContent?.trim() || ""; } }
          if (!name) name = el.getAttribute("title") || "";
          if (!name && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) name = el.placeholder || "";
          if (!name && tag !== "select") { const t = el.textContent?.trim(); if (t && t.length < 100) name = t; }

          let value = "";
          if (tag === "input" || tag === "textarea") value = el.value || "";
          else if (tag === "select") value = el.value || "";

          let checked = null;
          if (role === "checkbox" || role === "radio") checked = el.checked;

          out.push({ index: out.length, tag, role, name: name.substring(0, 200), value: value.substring(0, 500), enabled: !el.disabled, href: tag === "a" ? (el.href || null) : null, checked, readonly: el.readOnly || false, required: el.required || false, type: el.type || null });
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
        target.querySelectorAll(qs).forEach((node) => capture(node));
        return out;
      })()`).catch(() => ({ ok: false as const }));

      if (rawResult.ok && Array.isArray(rawResult.result)) {
        for (const r of rawResult.result.slice(0, maxElements)) batched.push(r);
      }
    } catch { /* page not ready */ }

    // Build elements + refMap — store KruzElement objects, not Playwright Locators
    const cssCounters: Record<string, number> = {};
    const scopeSelector = scope || "body";
    for (const d of batched) {
      const ref = `e${++this.elCounter}`;
      elements.push({ ref, role: d.role, name: d.name, value: d.value || undefined, enabled: d.enabled, href: d.href ?? undefined, checked: d.checked ?? undefined, selected: undefined, readonly: d.readonly, required: d.required, type: d.type ?? undefined });
      const cssSel = d.tag === "input" && d.type ? `input[type='${d.type}']` : d.tag;
      if (!(cssSel in cssCounters)) cssCounters[cssSel] = 0;
      const typeIndex = cssCounters[cssSel]++;
      // K14: Store a KruzElement (resolved lazily) instead of a Playwright Locator.
      // The controller's resolveElementWithRef checks entry.locator?.handle === 'string'
      // to treat it as a KruzElement — we store a synthetic handle + semantic metadata.
      const syntheticEl: KruzElement = {
        handle: `${scopeSelector} >> ${cssSel} >> nth=${typeIndex}`,
        strategy: "css-nth",
        target: { css: cssSel },
        scope: scopeSelector,
        resolvedAt: Date.now(),
      };
      this.refMap.set(ref, {
        locator: syntheticEl,
        semantic: { role: d.role, name: d.name, text: d.name, index: d.index, tag: d.tag, type: d.type, cssSelector: cssSel, cssTypeIndex: typeIndex },
      });
    }

    // Batch 2: text nodes
    try {
      const selJson2 = sel.replace(/'/g, "\\'");
      const linesResult: any = await engine.evaluate(`(() => {
        const s = '${selJson2}';
        const root = document.querySelector(s);
        if (!${!!scope} && !root) return [];
        const target = root || document.body;
        return (target.innerText || "").split("\\n").map(l => l.trim()).filter(l => l.length > 0 && l.length < 500);
      })()`).catch(() => ({ ok: false as const }));

      if (linesResult.ok && Array.isArray(linesResult.result)) {
        const lines: string[] = linesResult.result;
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

    return { page_id: pageId, url, title: await engine.title().catch(() => ""), revision, scope: scope || "body", elements, text, changed: [], detail };
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
