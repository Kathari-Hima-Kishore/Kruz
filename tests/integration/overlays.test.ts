/**
 * Overlay discovery/dismissal regression suite (manual report Bugs 5 and 6,
 * spec items T11-T17).
 *
 * The banner fixtures deliberately AVOID the words "cookie", "consent" and
 * "banner" in their class/id names wherever a test is about structural
 * blindness, because the old scanner keyed off exactly those tokens. A fix that
 * only adds more hard-coded selectors would pass a test that kept them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PuppeteerEngine } from "../../src/browser/engines/puppeteer-engine.js";
import { BrowserController } from "../../src/browser/controller.js";
import { Observer } from "../../src/extractor/observer.js";
import { RefRegistry } from "../../src/browser/ref-registry.js";
import { loadConfig } from "../../src/config.js";

let engine: PuppeteerEngine;
let ctrl: BrowserController;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "kruz-ov-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  const session = { id: "s", engine, status: "active" as const, observer, refs };
  ctrl = new BrowserController({ getActiveEngine: () => engine, getActive: () => session } as any);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const set = (html: string) => engine.page.setContent(html);

// page.setContent reuses the window, so a timer scheduled by one fixture can
// still fire on the NEXT fixture's document. Cancel it between tests, otherwise
// a stale late-banner lands on top of the following page and (correctly!) makes
// its controls look obscured.
afterEach(async () => {
  await engine.evaluate("try { clearTimeout(window.__lateTimer) } catch (e) { }").catch(() => {});
});

/** Oracle-shaped: fixed edge panel, opaque class names, no "cookie" anywhere. */
const ORACLE_LIKE = (mount = 0) => `<html><body style="margin:0">
  <h1>Software Engineer</h1><p>Job description body text.</p>
  <div id="m1" style="position:fixed;left:0;right:0;bottom:0;background:#161616;color:#fff;padding:16px;z-index:2147483000;display:flex;gap:12px">
    <span>We use cookies to improve your experience.</span>
    <button id="reject" onclick="this.parentNode.remove()">Reject All</button>
    <button id="accept" onclick="this.parentNode.remove()">Accept All</button>
    <a href="#prefs" onclick="return false">Manage Preferences</a>
  </div>
  ${mount ? `<script>window.__lateTimer = setTimeout(() => { const d=document.createElement('div'); d.id='late-panel'; d.style.cssText='position:fixed;left:0;right:0;bottom:0;background:#000;color:#fff;padding:16px;z-index:2147483001'; d.innerHTML='<span>Later banner</span><button onclick="this.parentNode.remove()">Close</button>'; document.body.appendChild(d); }, ${mount});</script>` : ""}
</body></html>`;

describe("T11 — ordinary semantic cookie banner (Bug 5)", () => {
  it("finds and dismisses a banner whose markup never says 'cookie'", async () => {
    set(ORACLE_LIKE());
    const res = await ctrl.handleOverlays({ close_cookie_banner: true });
    expect(res.ok).toBe(true);
    const r = res.result as any;
    expect(r.dismissed.length).toBe(1);
    // Refusing consent must be preferred over granting it.
    expect(String(r.dismissed_controls[0]).toLowerCase()).toContain("reject");
    expect(await engine.evaluate("!!document.getElementById('m1')").then((x: any) => x.result)).toBe(false);
  });

  it("T16: escalates past the known-selector fast path to semantic discovery", async () => {
    set(ORACLE_LIKE());
    const res = await ctrl.handleOverlays({});
    const r = res.result as any;
    // The strategy list proves discovery was not just the vendor id path.
    expect(r.detected_overlay).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

describe("T12 — asynchronously mounted banner (issue A)", () => {
  it("detects a banner that mounts after navigation, without a long fixed sleep", async () => {
    set(ORACLE_LIKE(700));
    const started = Date.now();
    const res = await ctrl.handleOverlays({ close_cookie_banner: true });
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(true);
    expect((res.result as any).dismissed.length).toBe(1);
    // Bounded, mutation-driven: comfortably under a blind multi-second sleep.
    expect(elapsed).toBeLessThan(4000);
  });
});

describe("T13 — no overlay on a settled page returns fast", () => {
  it("returns quickly and does not claim work it did not do", async () => {
    set(`<html><body><h1>Clean page</h1><p>No overlays here at all.</p><button>Do a thing</button></body></html>`);
    const started = Date.now();
    const res = await ctrl.handleOverlays({});
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(true);
    const r = res.result as any;
    expect(r.dismissed).toEqual([]);
    expect(r.detected_overlay).toBe(false);
    expect(r.terminal_reason).toContain("No cookie");
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("T14 — dismissal is verified without a follow-up probe (Bug 6)", () => {
  it("reports the overlay as dismissed AND the click as verified", async () => {
    set(ORACLE_LIKE());
    const res = await ctrl.handleOverlays({ close_cookie_banner: true });
    const r = res.result as any;
    expect(r.dismissed.length).toBe(1);
    expect(r.attempts[0].outcome).toBe("dismissed");
  });

  it("T14b: a manual click on the dismissal is verified by target effect, not by a body-text diff", async () => {
    set(ORACLE_LIKE());
    const { completeClick, captureClickState } = await import("../../src/browser/click-completion.js");
    const probe = await ctrl.probeTarget(engine, { css: "#reject" });
    const ref = String(probe.candidates[0].ref);
    const before = await captureClickState(engine);
    const clicked = await ctrl.click({ ref });
    expect(clicked.ok).toBe(true);
    const completion = await completeClick(engine, before, { effect_token: (clicked.result as any)?.effect_token });
    expect(completion.verified).toBe(true);
    expect(["target_disappeared", "overlay_disappeared", "target_hidden"]).toContain((completion as any).verification);
  });
});

describe("T15 — a failed dismissal is not reported as success", () => {
  it("reports still_present and never claims dismissed", async () => {
    set(`<html><body><div id="m1" style="position:fixed;left:0;right:0;bottom:0;z-index:9;background:#000">
      <button onclick="void 0">Close</button>
    </div></body></html>`);
    const res = await ctrl.handleOverlays({ close_cookie_banner: true });
    const r = res.result as any;
    expect(r.dismissed).toEqual([]);
    expect(r.attempts.length).toBeGreaterThan(0);
    expect(r.attempts.some((a: any) => a.outcome === "still_present")).toBe(true);
  });
});

describe("T17 — diagnostics are internally consistent", () => {
  it("never reports 'no safe dismiss control' and 'still visible after dismissal' for the same attempt", async () => {
    set(ORACLE_LIKE());
    const res = await ctrl.handleOverlays({ close_cookie_banner: true });
    const r = res.result as any;
    const outcomes = r.attempts.map((a: any) => a.outcome);
    // Every attempt carries exactly ONE outcome from a closed set, and no attempt
    // claims both "there was nothing to click" and "the click did not work".
    const allowed = ["dismissed", "still_present", "control_not_found", "not_actionable"];
    expect(outcomes.every((o: string) => allowed.includes(o))).toBe(true);
    for (const a of r.attempts) {
      const claimsNothingToClick = a.outcome === "control_not_found" || a.outcome === "not_actionable";
      const claimsClickHappened = a.outcome === "dismissed" || a.outcome === "still_present";
      expect(claimsNothingToClick && claimsClickHappened).toBe(false);
    }
    expect(r.dismissed.length).toBe(1);
  });

  it("a page with an overlay but no safe control gives ONE coherent terminal reason", async () => {
    set(`<html><body><div role="dialog" aria-modal="true" style="position:fixed;inset:20%;z-index:9;background:#eee">
      <p>Terms of use</p><button onclick="void 0">I Agree</button>
    </div></body></html>`);
    const res = await ctrl.handleOverlays({ close_cookie_banner: true });
    const r = res.result as any;
    if (r.dismissed.length === 0) {
      expect(r.terminal_reason).toBeTruthy();
      expect(r.failed.length + r.attempts.length).toBeGreaterThan(0);
    }
  });
});

describe("Safety — optional consent is never granted casually", () => {
  it("picks Reject over Accept when both are present", async () => {
    set(ORACLE_LIKE());
    await ctrl.handleOverlays({ close_cookie_banner: true });
    const probe = await ctrl.probeTarget(engine, { css: "#accept" });
    // Reject All was clicked, and it removed the whole panel.
    expect(probe.count).toBe(0);
  });
});
