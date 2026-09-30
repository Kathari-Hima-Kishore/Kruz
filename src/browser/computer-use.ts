/**
 * kruz-computer-use bridge — text-model screen grounding via DOM coordinates.
 *
 * Source: `kruz-computer-use.js` (text-only CUA bridge). The DOM already
 * exposes every element's exact center coordinates via
 * `getBoundingClientRect()`. These helpers expose them as plain JSON so a
 * text model can "see" the layout without vision, then act on it via the
 * existing `page.clickAt` / `page.scroll` / `page.type` tools.
 *
 * Coordinate system: CSS pixels, viewport-relative (same as clickAt).
 * Re-run LIST after every navigation/scroll — coords go stale on re-render.
 */

import type { ActionResult } from "./controller.js";
import { kruzError, ErrCode } from "../errors.js";

/** A single interactive target as returned by listTargets. */
export interface ComputerUseTarget {
  i: number;
  role: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Returns every interactive element in the current viewport as JSON.
 * Caps at 120 to avoid context bloat on heavy SPAs.
 */
export function listTargetsJS(): string {
  const els = Array.from(
    (globalThis as any).document.querySelectorAll(
      "a, button, input, select, textarea, [role=button], [role=link], [onclick], [contenteditable]"
    )
  );
  const out: ComputerUseTarget[] = [];
  let i = 0;
  const w = (globalThis as any).window;
  for (const el of els as any[]) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < 0 || r.right < 0) continue;
    if (r.top > w.innerHeight || r.left > w.innerWidth) continue;
    const style = w.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const text = (
      el.innerText ||
      el.value ||
      el.placeholder ||
      el.getAttribute("aria-label") ||
      el.name ||
      el.id ||
      ""
    ).trim().replace(/\s+/g, " ").slice(0, 60);
    out.push({
      i: i++,
      role: el.tagName.toLowerCase(),
      text,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
    if (out.length >= 120) break;
  }
  return JSON.stringify(out);
}

/** Snapshot helper — url + scroll + targets in one call (CUA loop step 1). */
export function snapshotJS(): string {
  const w = (globalThis as any).window;
  const targets = JSON.parse(
    (function () {
      // Inlined copy of listTargetsJS — snapshotJS is serialized via .toString()
      // and evaluated inside the page, where the module-scope listTargetsJS does
      // NOT exist (ReferenceError: listTargetsJS is not defined). Self-contained
      // functions survive the toString() round-trip; cross-calls do not.
      const els = Array.from(
        document.querySelectorAll(
          "a, button, input, select, textarea, [role=button], [role=link], [onclick], [contenteditable]"
        )
      );
      const out = [];
      let i = 0;
      for (const el of els) {
        const e2 = el as any;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom < 0 || r.right < 0) continue;
        if (r.top > window.innerHeight || r.left > window.innerWidth) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const text = (
          e2.innerText || e2.value || e2.placeholder || el.getAttribute("aria-label") || e2.name || el.id || ""
        ).trim().replace(/\s+/g, " ").slice(0, 60);
        out.push({
          i: i++,
          role: el.tagName.toLowerCase(),
          text,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
        if (out.length >= 120) break;
      }
      return JSON.stringify(out);
    })()
  );
  return JSON.stringify({
    scrollX: Math.round(w.scrollX ?? 0),
    scrollY: Math.round(w.scrollY ?? 0),
    vw: w.innerWidth,
    vh: w.innerHeight,
    targets,
  });
}

/** Draw numbered red badges over each interactive element (for vision models). */
export function markTargetsJS(): string {
  const d = (globalThis as any).document;
  d.querySelectorAll(".cu-badge").forEach((b: any) => b.remove());
  const list: ComputerUseTarget[] = JSON.parse(
    (function () {
      // Self-contained copy of listTargetsJS (see snapshotJS for why).
      const els = Array.from(
        document.querySelectorAll(
          "a, button, input, select, textarea, [role=button], [role=link], [onclick], [contenteditable]"
        )
      );
      const out = [];
      let i = 0;
      for (const el of els) {
        const e2 = el as any;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom < 0 || r.right < 0) continue;
        if (r.top > window.innerHeight || r.left > window.innerWidth) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const text = (
          e2.innerText || e2.value || e2.placeholder || el.getAttribute("aria-label") || e2.name || el.id || ""
        ).trim().replace(/\s+/g, " ").slice(0, 60);
        out.push({
          i: i++,
          role: el.tagName.toLowerCase(),
          text,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
        if (out.length >= 120) break;
      }
      return JSON.stringify(out);
    })()
  );
  for (const t of list) {
    const b = d.createElement("div");
    b.className = "cu-badge";
    b.textContent = String(t.i);
    b.style.cssText =
      "position:fixed;left:" + (t.x - 10) + "px;top:" + (t.y - 10) +
      "px;z-index:2147483647;background:#f00;color:#fff;font:bold 12px monospace;" +
      "width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;pointer-events:none;";
    d.body.appendChild(b);
  }
  return list.length + " targets marked";
}

export function clearMarksJS(): string {
  const d = (globalThis as any).document;
  d.querySelectorAll(".cu-badge").forEach((b: any) => b.remove());
  return "marks cleared";
}

/** Scroll the i-th interactive element into view, then return its FRESH center coords. */
export function scrollToTargetJS(i: number): string {
  const w: any = (globalThis as any).window;
  const d: any = (globalThis as any).document;
  const els: any[] = Array.from(
    d.querySelectorAll(
      "a, button, input, select, textarea, [role=button], [role=link], [onclick], [contenteditable]"
    )
  ).filter((el: any) => {
    const r = el.getBoundingClientRect();
    const s = w.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  });
  const el: any = els[i];
  if (!el) return JSON.stringify({ error: "no target " + i });
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return JSON.stringify({
    i,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  });
}

// ── Controller-facing wrappers ────────────────────────────────────────

/** Wrap a page-evaluate call so computer-use helpers get run inside the page. */
async function evalInPage<T>(p: any, expr: string): Promise<T> {
  return p.evaluate((e: string) => eval(e), expr) as Promise<T>;
}

export async function listTargets(p: any): Promise<ActionResult> {
  try {
    const json = await evalInPage<string>(p, `(${listTargetsJS.toString()})()`);
    return { ok: true, result: JSON.parse(json) };
  } catch (e) { return { ok: false, error: kruzError(ErrCode.CU_LIST, { subsystem: "computer-use", message: String(e), cause: e, trace: ["computer-use"] }).toJSON() }; }
}

export async function snapshot(p: any): Promise<ActionResult> {
  try {
    const json = await evalInPage<string>(p, `(${snapshotJS.toString()})()`);
    return { ok: true, result: JSON.parse(json) };
  } catch (e) { return { ok: false, error: kruzError(ErrCode.CU_SNAPSHOT, { subsystem: "computer-use", message: String(e), cause: e, trace: ["computer-use"] }).toJSON() }; }
}

export async function markTargets(p: any): Promise<ActionResult> {
  try {
    const count = await evalInPage<string>(p, `(${markTargetsJS.toString()})()`);
    return { ok: true, result: { message: count } };
  } catch (e) { return { ok: false, error: kruzError(ErrCode.CU_MARK, { subsystem: "computer-use", message: String(e), cause: e, trace: ["computer-use"] }).toJSON() }; }
}

export async function clearMarks(p: any): Promise<ActionResult> {
  try {
    const msg = await evalInPage<string>(p, `(${clearMarksJS.toString()})()`);
    return { ok: true, result: { message: msg } };
  } catch (e) { return { ok: false, error: kruzError(ErrCode.CU_CLEAR, { subsystem: "computer-use", message: String(e), cause: e, trace: ["computer-use"] }).toJSON() }; }
}

export async function scrollToTarget(p: any, i: number): Promise<ActionResult> {
  try {
    const json = await evalInPage<string>(p, `(${scrollToTargetJS.toString()})(${i})`);
    const parsed = JSON.parse(json);
    if (parsed.error) return { ok: false, error: kruzError(ErrCode.CU_NO_TARGET, { subsystem: "computer-use", message: parsed.error, trace: ["computer-use"] }).toJSON() };
    return { ok: true, result: parsed };
  } catch (e) { return { ok: false, error: kruzError(ErrCode.CU_SCROLL, { subsystem: "computer-use", message: String(e), cause: e, trace: ["computer-use"] }).toJSON() }; }
}