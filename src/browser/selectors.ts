import type { BrowserEngine, KruzElement } from "./engine.js";
import type { Target, Fallback } from "../types/schema.js";

function escCSS(s: string): string {
  return s.replace(/([\\\"\\'\#.:;,!>+~\/\[\](){}|\\s$%@&*=])/g, "\\$1");
}

/** Build a CSS selector from a target. Not an element — just the selector strategy. */
export function selectorString(target: Target, fallback?: Fallback): { css: string; bySemantics: boolean } {
  if (target.css) return { css: target.css, bySemantics: false };
  if (target.role && target.name) return { css: `[role="${escCSS(target.role)}"]`, bySemantics: true };
  if (target.role) return { css: `[role="${escCSS(target.role)}"]`, bySemantics: true };
  if (target.label) return { css: `[aria-label="${escCSS(target.label)}"]`, bySemantics: true };
  if (target.placeholder) return { css: `[placeholder="${escCSS(target.placeholder)}"]`, bySemantics: true };
  if (target.text) return { css: `text="${escCSS(target.text)}"`, bySemantics: true };
  if (target.testid) return { css: `[data-testid="${escCSS(target.testid)}"]`, bySemantics: false };
  if (target.nameAttr) return { css: `[name="${escCSS(target.nameAttr)}"]`, bySemantics: false };
  if (target.id) return { css: `#${escCSS(target.id)}`, bySemantics: false };
  if (fallback?.css) return { css: fallback.css, bySemantics: false };
  if (fallback?.xpath) return { css: `xpath=${fallback.xpath}`, bySemantics: false };
  if (fallback?.text) return { css: `text="${escCSS(fallback.text)}"`, bySemantics: true };
  return { css: "body", bySemantics: false };
}

/** Resolve a target to a KruzElement using the engine. */
export async function resolveElement(engine: BrowserEngine, target: Target, fallback?: Fallback, scope?: string): Promise<KruzElement | null> {
  return engine.queryOne(target, fallback, scope);
}

/**
 * D7: resolve a link ref by destination identity. Marks the observed href's
 * node in-page, then re-queries by the mark — order-independent, so DOM shifts
 * (inserted siblings moving nth indexes) can never rebind the ref to a
 * stranger. Same-href twins (image + title link to one product) share the
 * destination, so either is a correct landing.
 */
async function markElementByHref(engine: BrowserEngine, href: string): Promise<KruzElement | null> {
  const token = `k${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  try {
    // Only one live mark at a time (actions are sequential): clear any stale
    // mark first, then mark the destination. The mark MUST persist after this
    // call — every later resolveHandle re-queries by it for the whole action.
    const found: any = await engine.evaluate(
      `(t => { try { document.querySelectorAll('a[data-kruz-refmark]').forEach(x => x.removeAttribute('data-kruz-refmark')); const a = Array.from(document.querySelectorAll('a')).find(x => x.href === ${JSON.stringify(href)}); if (!a) return false; a.setAttribute('data-kruz-refmark', t); return true; } catch (e) { return false; } })(${JSON.stringify(token)})`,
    ).catch(() => null);
    if (!found?.ok || found.result !== true) return null;
    return await engine.queryOne({ css: `a[data-kruz-refmark="${token}"]` }).catch(() => null);
  } catch { return null; }
}

/**
 * Resolve a target with refMap support.
 * Refs carry semantic data (role, name, index, cssTypeIndex) for nth()-based resolution.
 */
export async function resolveElementWithRef(engine: BrowserEngine, target: Target, refMap: Map<string, any>, fallback?: Fallback, scope?: string, timeoutMs = 3000): Promise<{ el: KruzElement | null; byRef: boolean }> {
  if (target.css) {
    const el = await engine.queryOne({ css: target.css }, fallback, scope, timeoutMs);
    return { el, byRef: false };
  }

  if (target.ref) {
    const entry = refMap.get(target.ref);
    if (entry?.semantic) {
      // D7 fast path: destination identity for links in the default scope.
      // Runs before semantic re-match because role-only fallback would return
      // the first link in the DOM (the observed skip-link misfire class).
      const semHref = (entry.semantic as any)?.href;
      const semTag = (entry.semantic as any)?.tag;
      const entryScope = (entry as any)?.locator?.scope as string | undefined;
      if (semTag === "a" && typeof semHref === "string" && semHref && (!entryScope || entryScope === "body")) {
        const marked = await markElementByHref(engine, semHref).catch(() => null);
        if (marked) return { el: marked, byRef: true };
      }
      // Primary: semantic re-match against the live DOM (name/role/text).
      // Puppeteer's ARIA/text selectors pierce open shadow roots, so a ref
      // captured inside a component resolves here.
      const sem = await resolveSemantic(engine, entry.semantic);
      if (sem) return { el: sem, byRef: true };

      // Tier 1 — the exact piercing path recorded at observe time. Survives an
      // accessible-name change; only fails if the node's position changed.
      // D7: verify identity before trusting the path — nth-index paths silently
      // rebind when the DOM shifts (inserted siblings), which previously clicked
      // a stranger. A path hit whose href differs from the observed one is
      // discarded so Tier 2 can recover by identity instead of position.
      const path = entry.css || entry.semantic.path;
      if (path) {
        const byPath = await engine.queryOne({ css: path }).catch(() => null);
        if (byPath) {
          const wantHref = typeof entry.semantic.href === "string" ? entry.semantic.href as string : "";
          if (wantHref) {
            const same = await engine.evaluateOn(byPath, `(() => { try { return this.href === ${JSON.stringify(wantHref)}; } catch { return false; } })()`).catch(() => ({ ok: false as const }));
            if (same?.ok && same.result === true) return { el: byPath, byRef: true };
          } else {
            return { el: byPath, byRef: true };
          }
        }
      }
      // Tier 2/3 — recovery for SPA churn where the live accessible name drifted
      // from what observe captured. queryAll KruzElements carry no name, so read
      // real names in-page over the same tag-set and match by containment both
      // ways, preferring the candidate nearest the observed position. Conservative:
      // positional recovery (Tier 3) is only used when no name was captured at
      // observe time or the in-page name read failed — NEVER when names exist in
      // the DOM but none match (that would click the wrong element).
      const { name, tag, cssTypeIndex } = entry.semantic;
      if (tag) {
        const all = await engine.queryAll({ css: tag }).catch(() => [] as KruzElement[]);
        let pick: KruzElement | null = null;
        const want = String(name ?? "").trim().toLowerCase();
        const nameReadFailed = { value: false };
        if (want) {
          try {
            const names = await engine.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(tag)})).map((el,i)=>{let n=el.getAttribute('aria-label')||''; if(!n){const lb=el.getAttribute('aria-labelledby'); if(lb){const le=document.getElementById(lb); if(le)n=(le.textContent||'').trim();}} if(!n)n=(el.getAttribute('title')||''); if(!n)n=(el.textContent||'').trim().slice(0,120); return {i,n: n.normalize('NFKC').replace(/\\s+/g,' ').trim()};})`).catch(() => null);
            if (names?.ok && Array.isArray(names.result)) {
              const rows = names.result as { i: number; n: string }[];
              const scored = rows
                .map((x) => {
                  const nn = x.n.toLowerCase();
                  if (!nn) return null;
                  if (nn === want) return { i: x.i, d: 0 };
                  if (nn.includes(want)) return { i: x.i, d: nn.length - want.length };
                  if (want.includes(nn)) return { i: x.i, d: want.length - nn.length };
                  return null;
                })
                .filter((x): x is { i: number; d: number } => x !== null && x.d < 80)
                .sort((a, b) => a.d - b.d || Math.abs(a.i - (cssTypeIndex ?? 0)) - Math.abs(b.i - (cssTypeIndex ?? 0)));
              if (scored.length > 0) pick = all[scored[0].i] ?? null;
              // Names exist but none match → element is gone/renamed; stay null.
              // Only positionally recover when every row is blank AND no href
              // identity exists to bind (D7).
              else if (!rows.some((x) => x.n.trim()) && !((entry.semantic as any)?.href)) pick = all[cssTypeIndex ?? 0] ?? null;
            } else {
              nameReadFailed.value = true;
            }
          } catch { nameReadFailed.value = true; }
        }
        if (pick) return { el: pick, byRef: true };
        // D7: identity match by absolute href for links — an exact destination
        // beats name similarity and always beats position. Scoped to the
        // default body scope so the in-page order matches queryAll order.
        if (!pick && tag === "a") {
          const wantHref = typeof (entry.semantic as any)?.href === "string" ? (entry.semantic as any).href as string : "";
          const entryScope = (entry as any)?.locator?.scope as string | undefined;
          if (wantHref && (!entryScope || entryScope === "body")) {
            const at = await engine.evaluate(`Array.from(document.querySelectorAll('a')).map((el) => (typeof el.href === 'string' ? el.href : ''))`).catch(() => null);
            if (at?.ok && Array.isArray(at.result)) {
              const idx = (at.result as string[]).indexOf(wantHref);
              if (idx >= 0) pick = all[idx] ?? null;
            }
          }
        }
        if (pick) return { el: pick, byRef: true };
        // Positional recovery: only safe when there was no captured name to bind
        // (observe saw it nameless) or the in-page read itself failed — and no
        // href identity exists. NEVER when names exist in the DOM but none
        // match (that would click the wrong element).
        if ((!want || nameReadFailed.value) && !((entry.semantic as any)?.href)) {
          pick = all[cssTypeIndex ?? 0] ?? null;
          if (pick) return { el: pick, byRef: true };
        }
      }
    }

    // Ref not found → try fallbacks
    if (fallback?.css) return { el: await engine.queryOne({ css: fallback.css }, undefined, scope), byRef: false };
    if (fallback?.xpath) return { el: await engine.queryOne({ css: `xpath=${fallback.xpath}` }, undefined, scope), byRef: false };
    if (fallback?.text) return { el: await engine.queryOne({ text: fallback.text }, undefined, scope), byRef: false };
    return { el: null, byRef: true };
  }

  const el = await engine.queryOne(target, fallback, scope);
  return { el, byRef: false };
}

/** Semantic re-match of an observed element against the live DOM. Returns null when the
 *  element is gone or its name/role shifted — never the-first-match-of-a-stale-role. */
async function resolveSemantic(engine: BrowserEngine, s: any): Promise<KruzElement | null> {
  const { role, name, text, tag, type, cssTypeIndex } = s;
  if (tag === "input" || tag === "select" || tag === "textarea") {
    if (role === "checkbox") {
      if (name?.trim()) {
        const el = await engine.queryOne({ role: "checkbox", name }).catch(() => null);
        if (el) return el;
      }
      return await engine.queryAll({ css: "input[type='checkbox']" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
    }
    if (role === "radio") {
      if (name?.trim()) {
        const el = await engine.queryOne({ role: "radio", name }).catch(() => null);
        if (el) return el;
      }
      return await engine.queryAll({ css: "input[type='radio']" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
    }
    if (role === "slider") {
      if (name?.trim()) {
        const el = await engine.queryOne({ role: "slider", name }).catch(() => null);
        if (el) return el;
      }
      return await engine.queryOne({ css: "input[type='range']" });
    }
    if (tag === "select") {
      if (name?.trim() && !name.includes("\n")) {
        const el = await engine.queryOne({ role: "combobox", name }).catch(() => null);
        if (el) return el;
      }
      return await engine.queryAll({ css: "select" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
    }
    if (tag === "textarea") {
      if (name?.trim()) {
        const el = await engine.queryOne({ role: "textbox", name }).catch(() => null);
        if (el) return el;
      }
      return await engine.queryAll({ css: "textarea" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
    }
    if (tag === "input") {
      const it = type || "text";
      if (it === "file") return await engine.queryAll({ css: "input[type='file']" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
      if (it === "number") {
        if (name?.trim()) {
          const el = await engine.queryOne({ role: "spinbutton", name }).catch(() => null);
          if (el) return el;
        }
        return await engine.queryAll({ css: "input[type='number']" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
      }
      if (it === "range") return await engine.queryAll({ css: "input[type='range']" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
      if (name?.trim()) {
        const el = await engine.queryOne({ role: "textbox", name }).catch(() => null);
        if (el) return el;
      }
      return await engine.queryAll({ css: `input[type='${it}']` }).then((a) => a[cssTypeIndex ?? 0] ?? null);
    }
  }

  if (role === "combobox" || role === "listbox") {
    if (name?.trim() && !name.includes("\n")) {
      const el = await engine.queryOne({ role, name }).catch(() => null);
      if (el) return el;
    }
    return await engine.queryAll({ css: role === "combobox" ? "select" : "[role='listbox']" }).then((a) => a[cssTypeIndex ?? 0] ?? null);
  }
  if (role && name) {
    const el = await engine.queryOne({ role, name }).catch(() => null);
    // A stale/renamed control must not degrade to the first matching role; the
    // caller's css fallback covers SPA re-renders that changed the name.
    return el;
  }
  if (text) {
    const el = await engine.queryOne({ text }).catch(() => null);
    if (el) return el;
  }
  if (role) {
    const el = await engine.queryOne({ role }).catch(() => null);
    if (el) return el;
  }
  return null;
}

/** Try to resolve an element, returning null if not visible. */
export async function tryResolveElement(engine: BrowserEngine, target: Target, fallback?: Fallback, scope?: string, timeoutMs = 5000): Promise<KruzElement | null> {
  try {
    const el = await engine.queryOne(target, fallback, scope);
    if (el) {
      const visible = await engine.isVisible(el).catch(() => false);
      if (visible) return el;
    }
    return null;
  } catch {
    return null;
  }
}
