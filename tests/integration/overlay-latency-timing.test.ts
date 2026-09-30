/**
 * Overlay discovery latency + action timing metadata.
 *
 * The release gate measured `page.handleOverlays` at 1200-1400 ms even on pages
 * with no overlay, with `discovery_ms: 0`. The settle check that is supposed to
 * return early depended on `window.__p1MutationCount`, which is installed by the
 * Observer — so when `page.handleOverlays` was the first thing to touch the
 * document, the counter was absent, `mut` was null, the "settled" test could
 * never pass, and every call burned the full mount window.
 *
 * These tests pin the fast negative on a settled page AND prove the bounded wait
 * still catches an overlay that mounts after the first scan.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
let session: any;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "kruz-ovlat-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  session = { id: "s_ov", engine, status: "active" as const, observer, refs };
  ctrl = new BrowserController({ getActiveEngine: () => engine, getActive: () => session } as any);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const set = (html: string) => engine.page.setContent(html);
const ev = async (x: string) => engine.evaluate(x).then((r: any) => r.result);

/** handleOverlays as the router calls it; unwraps the ActionResult envelope. */
async function overlays() {
  const res = await (ctrl as any).handleOverlays({ close_cookie_banner: true });
  return res?.result ?? res;
}

describe("overlay no-op latency", () => {
  beforeEach(async () => {
    await set(`<html><body><h1>Settled page</h1><p>No banner here.</p>
      <a href="/x">link</a></body></html>`);
    // A fresh document has no mutation counter unless the Observer installed
    // one. This is exactly the state the release gate hit.
    await ev("try { delete window.__p1MutationCount } catch (e) { window.__p1MutationCount = undefined }");
  });

  it("returns fast on a settled page with no overlay and no mutation counter", async () => {
    const r = await overlays();
    expect(r.dismissed?.length ?? 0).toBe(0);
    // Bounded, but well under the previous unconditional ~1.2s mount window.
    const total = r.timing?.total_ms ?? 0;
    expect(total).toBeLessThan(900);
  });

  it("still detects and dismisses a cookie banner that is already present", async () => {
    await set(`<html><body>
      <div id="global-cookie-message" class="gem-c-cookie-banner">
        <div class="govuk-cookie-banner__message">
          <h2>Cookies on this site</h2>
          <button type="button" onclick="document.getElementById('global-cookie-message').remove()">Reject additional cookies</button>
          <button type="button" onclick="document.getElementById('global-cookie-message').remove()">Accept additional cookies</button>
        </div>
      </div>
      <a href="/x">link</a></body></html>`);
    const r = await overlays();
    expect(r.detected_overlay).toBe(true);
    // The privacy-first control is preferred, and the banner really goes away.
    expect(r.dismissed_controls?.[0]).toBe("Reject additional cookies");
    expect(await ev("!!document.getElementById('global-cookie-message')")).toBe(false);
  });

  it("still catches an overlay that mounts asynchronously after the first scan", async () => {
    await set(`<html><body><a href="/x">link</a><div id="late"></div>
      <script>
        setTimeout(function () {
          var d = document.createElement('div');
          d.id = 'global-cookie-message';
          d.className = 'gem-c-cookie-banner';
          d.innerHTML = '<div class="govuk-cookie-banner__message"><h2>Cookies</h2>' +
            '<button type="button" onclick="this.closest(\\'#global-cookie-message\\').remove()">Reject additional cookies</button></div>';
          document.body.appendChild(d);
        }, 350);
      </script></body></html>`);
    const r = await overlays();
    // The point is that detection still works, not that it is fast.
    expect(r.detected_overlay).toBe(true);
  }, 15000);
});

describe("action timing metadata", () => {
  beforeEach(async () => {
    await set(`<html><body>
      <a id="l" href="#x" onclick="event.preventDefault()">Link</a>
      <input id="i" type="text" />
      <div style="height:2500px"></div><a id="deep" href="#d">Deep</a>
    </body></html>`);
  });

  it("click reports total/resolve/action timing", async () => {
    await session.observer.observe(engine, undefined, "minimal", true);
    const { observation } = await session.observer.observe(engine, undefined, "minimal", true);
    const el = (observation.elements || []).find((e: any) => e.name === "Link");
    const res = await ctrl.click({ ref: String(el!.ref) });
    expect(res.ok).toBe(true);
    expect(typeof res.timing?.total_ms).toBe("number");
    expect(typeof res.timing?.resolve_ms).toBe("number");
  });

  it("fill reports timing", async () => {
    const { observation } = await session.observer.observe(engine, undefined, "minimal", true);
    const el = (observation.elements || []).find((e: any) => e.role === "textbox");
    const res = await ctrl.fill({ ref: String(el!.ref) }, "v");
    expect(res.ok).toBe(true);
    expect(typeof res.timing?.total_ms).toBe("number");
  });

  it("scroll reports timing", async () => {
    const res = await ctrl.scroll("down", 400);
    expect(res.ok).toBe(true);
    expect(typeof res.timing?.total_ms).toBe("number");
  });

  it("observation reports its own timing", async () => {
    const { observation } = await session.observer.observe(engine, undefined, "minimal", true);
    expect(typeof observation.timing?.total_ms).toBe("number");
  });

  it("a failed action is timed too, since that is where a regression hides", async () => {
    const res = await ctrl.click({ css: "#definitely-not-here" });
    expect(res.ok).toBe(false);
    expect(typeof res.timing?.total_ms).toBe("number");
  });
});
