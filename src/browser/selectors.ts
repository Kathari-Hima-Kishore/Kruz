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
 * Resolve a target with refMap support.
 * Refs carry semantic data (role, name, index, cssTypeIndex) for nth()-based resolution.
 */
export async function resolveElementWithRef(engine: BrowserEngine, target: Target, refMap: Map<string, any>, fallback?: Fallback, scope?: string): Promise<{ el: KruzElement | null; byRef: boolean }> {
  if (target.css) {
    const el = await engine.queryOne({ css: target.css }, fallback, scope);
    return { el, byRef: false };
  }

  if (target.ref) {
    const entry = refMap.get(target.ref);
    if (entry) {
      if (entry.formRef && entry.locator) {
        return { el: entry.locator as KruzElement, byRef: true };
      }
      if (entry.semantic) {
        const { role, name, text, tag, type, cssTypeIndex } = entry.semantic;
        if (tag === "input" || tag === "select" || tag === "textarea") {
          if (role === "checkbox") {
            if (name?.trim()) {
              const el = await engine.queryOne({ role: "checkbox", name }).catch(() => null);
              if (el) return { el, byRef: true };
            }
            return { el: await engine.queryAll({ css: "input[type='checkbox']" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
          }
          if (role === "radio") {
            if (name?.trim()) {
              const el = await engine.queryOne({ role: "radio", name }).catch(() => null);
              if (el) return { el, byRef: true };
            }
            return { el: await engine.queryAll({ css: "input[type='radio']" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
          }
          if (role === "slider") {
            if (name?.trim()) {
              const el = await engine.queryOne({ role: "slider", name }).catch(() => null);
              if (el) return { el, byRef: true };
            }
            return { el: await engine.queryOne({ css: "input[type='range']" }), byRef: true };
          }
          if (tag === "select") {
            if (name?.trim() && !name.includes("\n")) {
              const el = await engine.queryOne({ role: "combobox", name }).catch(() => null);
              if (el) return { el, byRef: true };
            }
            return { el: await engine.queryAll({ css: "select" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
          }
          if (tag === "textarea") {
            if (name?.trim()) {
              const el = await engine.queryOne({ role: "textbox", name }).catch(() => null);
              if (el) return { el, byRef: true };
            }
            return { el: await engine.queryAll({ css: "textarea" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
          }
          if (tag === "input") {
            const it = type || "text";
            if (it === "file") return { el: await engine.queryAll({ css: "input[type='file']" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
            if (it === "number") {
              if (name?.trim()) {
                const el = await engine.queryOne({ role: "spinbutton", name }).catch(() => null);
                if (el) return { el, byRef: true };
              }
              return { el: await engine.queryAll({ css: "input[type='number']" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
            }
            if (it === "range") return { el: await engine.queryAll({ css: "input[type='range']" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
            if (name?.trim()) {
              const el = await engine.queryOne({ role: "textbox", name }).catch(() => null);
              if (el) return { el, byRef: true };
            }
            return { el: await engine.queryAll({ css: `input[type='${it}']` }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
          }
        }

        if (role === "combobox" || role === "listbox") {
          if (name?.trim() && !name.includes("\n")) {
            const el = await engine.queryOne({ role, name }).catch(() => null);
            if (el) return { el, byRef: true };
          }
          return { el: await engine.queryAll({ css: role === "combobox" ? "select" : "[role='listbox']" }).then((a) => a[cssTypeIndex ?? 0] ?? null), byRef: true };
        }
        if (role && name) {
          const el = await engine.queryOne({ role, name }).catch(() => null);
          // A stale named control must not degrade to the first matching role.
          return { el, byRef: true };
        }
        if (text) {
          const el = await engine.queryOne({ text }).catch(() => null);
          if (el) return { el, byRef: true };
        }
        if (role) {
          const el = await engine.queryOne({ role }).catch(() => null);
          if (el) return { el, byRef: true };
        }
      }
      if (entry.locator && typeof entry.locator.handle === "string") return { el: entry.locator as KruzElement, byRef: true };
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
