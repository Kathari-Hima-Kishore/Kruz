/**
 * Element-identity precision follow-ups.
 *
 * Two defects reported by the independent release gate are reproduced here with
 * a deterministic fixture served over real HTTP, so that RELATIVE hrefs resolve
 * against a real base URL the way they do on docs.python.org (a data:/about:blank
 * document cannot reproduce base-relative resolution at all).
 *
 *   1. Relative-href identity fallback.
 *      The Observer records link identity from `el.href` — the browser-RESOLVED
 *      absolute URL — while the DOM attribute stays relative. Identity resolution
 *      then queries `a[href="https://…"]`, which matches nothing, and a ref whose
 *      Tier-1 path was invalidated by a container re-render degrades to
 *      STALE_REFERENCE even though the identical logical link is still there.
 *
 *   2. `<select>` reachable through the CORRECT operation (`page.select`).
 *      The gate reported this via `page.check`, which is not a compatible
 *      operation for a select. This suite establishes the real answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
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
let server: Server;
let origin: string;

/** The page under test. The list is what the Observer sees first. */
const listItems = (before: string[], after = "") => `
  <ul>
    ${before.map((h) => `<li><a href="${h}">item</a></li>`).join("")}
    <li><a href="child/page.html" id="t" onclick="event.preventDefault(); window.hit='right'">Target</a></li>
    ${after}
  </ul>`;

const DECOY = `<li><a href="other/page.html" onclick="event.preventDefault(); window.hit='wrong'">Target</a></li>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>href fixture</title></head><body>
      <div id="shell">${listItems(["alpha.html"])}</div>
      <div id="keep"></div>
    </body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  profile = await mkdtemp(join(tmpdir(), "kruz-href-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);

  // One shared registry — the SessionManager contract.
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  session = { id: "s_href", engine, status: "active" as const, observer, refs };
  ctrl = new BrowserController({ getActiveEngine: () => engine, getActive: () => session } as any);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const ev = async (x: string) => engine.evaluate(x).then((r: any) => r.result);

async function openFixture(path = "/") {
  await engine.navigate(`${origin}${path}`, "domcontentloaded", 10000);
  // A <base href> set by one case must not leak into the next: it silently
  // re-points every relative URL in the document.
  await ev("document.querySelectorAll('base').forEach(b => b.remove())");
  await ev("window.hit = undefined");
  // Confirm our shell exists before a case mutates it, so a slow navigation can
  // never make a case silently edit the previous page.
  const ok = await ev("!!document.getElementById('shell')");
  if (ok !== true) throw new Error(`fixture did not load at ${path}`);
}

async function observeTarget() {
  const { observation } = await session.observer.observe(engine, undefined, "minimal", true);
  const hit = (observation.elements || []).find((e: any) => e.name === "Target");
  if (!hit) throw new Error("Target not observed");
  return String(hit.ref);
}

/** Re-render the list so the recorded positional path no longer names the target. */
async function rerenderSidebar(before: string[], after = "") {
  await ev(`document.getElementById('shell').innerHTML = ${JSON.stringify(listItems(before, after))}`);
}

describe("1 — relative href identity survives a re-render that invalidates the path", () => {
  beforeEach(async () => {
    await openFixture("/dir/index.html");
  });

  it("re-resolves the SAME logical link by resolved destination, not by position", async () => {
    const ref = await observeTarget();
    // The Tier-1 path was `… ul li:nth-of-type(2) a`; push the target down.
    await rerenderSidebar(["a1.html", "a2.html", "a3.html"]);

    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("right");
  });

  it("never picks a same-text link whose recorded destination differs", async () => {
    const ref = await observeTarget();
    // Re-render AND add an identically-labelled decoy with a different href.
    await rerenderSidebar(["a1.html", "a2.html", "a3.html"], DECOY);

    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    // Must land on the recorded destination, never on the decoy.
    expect(await ev("String(window.hit)")).toBe("right");
  });

  it("hands back USABLE refs when the destination is genuinely ambiguous", async () => {
    // Several links resolve to the same destination (a duplicated sidebar), so
    // refusing is correct — but the error must offer a recovery the caller can
    // actually take, i.e. real refs rather than a bare list of descriptors.
    const ref = await observeTarget();
    // Rebuild so the recorded positional path is gone AND more than one node
    // shares the recorded destination.
    const html = [
      "<ul>",
      '<li><a href="a1.html">i</a></li><li><a href="a2.html">i</a></li><li><a href="a3.html">i</a></li>',
      '<li><a href="child/page.html" onclick="event.preventDefault(); window.hit=\'right\'">Target</a></li>',
      '<li><a href="child/page.html" onclick="event.preventDefault(); window.hit=\'also\'">Copy</a></li>',
      "</ul>",
    ].join("");
    await ev("document.getElementById('shell').innerHTML = " + JSON.stringify(html));

    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("AMBIGUOUS_TARGET");
    expect(res.error?.retryable).toBe(false);

    const candidates = (res.result as any)?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(1);
    for (const c of candidates) expect(typeof c.ref).toBe("string");

    // The advertised recovery: act on one of the returned candidate refs.
    const picked = candidates.find((c: any) => c.actionable && c.name === "Target")
      ?? candidates.find((c: any) => c.actionable);
    const follow = await ctrl.click({ ref: String(picked.ref) });
    expect(follow.ok).toBe(true);
    expect(follow.error?.code).not.toBe("AMBIGUOUS_TARGET");
  });

  it("refuses rather than guessing when the destination is genuinely gone", async () => {
    const ref = await observeTarget();
    // Re-render WITHOUT recreating the target: nothing identical remains.
    await ev(`document.getElementById('shell').innerHTML = '<ul><li><a href="a1.html">item</a></li></ul>'`);

    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("STALE_REFERENCE");
    expect(await ev("String(window.hit)")).not.toBe("wrong");
  });
});

describe("1b — every href shape resolves by canonical destination", () => {
  const shapes: Array<[string, string, string]> = [
    ["relative", "child/page.html", "child/page.html"],
    ["root-relative", "/root/page.html", "/root/page.html"],
    ["parent-relative", "../up/page.html", "../up/page.html"],
    ["fragment", "#section", "#section"],
    ["query", "child/page.html?a=1&b=2", "child/page.html?a=1&b=2"],
  ];

  for (const [label, href] of shapes) {
    it(`${label} href (${href}) re-resolves to the same link`, async () => {
      await openFixture("/dir/index.html");
      await ev(`document.getElementById('shell').innerHTML =
        '<ul><li><a href="other.html">item</a></li>
              <li><a href="${href}" id="t" onclick="event.preventDefault(); window.hit=\\'right\\'">Target</a></li></ul>'`);

      const ref = await observeTarget();
      // Invalidate the path.
      await ev(`document.getElementById('shell').innerHTML =
        '<ul><li><a href="x1.html">item</a></li><li><a href="x2.html">item</a></li><li><a href="x3.html">item</a></li>
              <li><a href="${href}" onclick="event.preventDefault(); window.hit=\\'right\\'">Target</a></li></ul>'`);

      const res = await ctrl.click({ ref });
      expect(res.ok).toBe(true);
      expect(await ev("String(window.hit)")).toBe("right");
    });
  }

  it("absolute href re-resolves to the same link", async () => {
    await openFixture("/dir/index.html");
    const abs = `${origin}/child/page.html`;
    await ev(`document.getElementById('shell').innerHTML =
      '<ul><li><a href="other.html">item</a></li>
            <li><a href="${abs}" onclick="event.preventDefault(); window.hit=\\'right\\'">Target</a></li></ul>'`);
    const ref = await observeTarget();
    await ev(`document.getElementById('shell').innerHTML =
      '<ul><li><a href="x1.html">i</a></li><li><a href="x2.html">i</a></li>
            <li><a href="${abs}" onclick="event.preventDefault(); window.hit=\\'right\\'">Target</a></li></ul>'`);
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("right");
  });

  it("a <base href> is honoured, so the same relative href is a different link", async () => {
    await openFixture("/dir/index.html");
    await ev(`document.head.innerHTML = '<base href="/nested/">'`);
    await ev(`document.getElementById('shell').innerHTML =
      '<ul><li><a href="other.html">item</a></li>
            <li><a href="page.html" onclick="event.preventDefault(); window.hit=\\'right\\'">Target</a></li></ul>'`);
    const ref = await observeTarget();
    await ev(`document.getElementById('shell').innerHTML =
      '<ul><li><a href="x1.html">i</a></li><li><a href="x2.html">i</a></li>
            <li><a href="page.html" onclick="event.preventDefault(); window.hit=\\'right\\'">Target</a></li></ul>'`);
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("right");
  });

  it("two links with identical text but different hrefs keep distinct identities", async () => {
    // A distinct path per case: a <base href> left by the previous test would
    // otherwise still be resolving these relative URLs.
    await openFixture("/twins/index.html");
    const twinsHtml = [
      '<ul>',
      '<li><a href="child/page.html" onclick="event.preventDefault(); window.hit=\'one\'">Same</a></li>',
      '<li><a href="other/page.html" onclick="event.preventDefault(); window.hit=\'two\'">Same</a></li>',
      "</ul>",
    ].join("");
    await ev("document.getElementById('shell').innerHTML = " + JSON.stringify(twinsHtml));
    const { observation } = await session.observer.observe(engine, undefined, "standard", true);
    const twins = (observation.elements || []).filter((e: any) => e.name === "Same");
    if (twins.length !== 2) {
      throw new Error(`expected 2 "Same" links, saw ${JSON.stringify((observation.elements || []).map((e: any) => e.role + "|" + e.name + "|" + e.href))}`);
    }

    const res = await ctrl.click({ ref: String(twins[1].ref) });
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("two");
  });
});

describe("2 — <select> via the correct operation (page.select)", () => {
  beforeEach(async () => {
    await openFixture("/dir/select.html");
    const html = [
      '<label for="t">Theme</label><select id="t">',
      '<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>',
      "</select>",
      '<select id="aria" aria-label="Theme">',
      '<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>',
      "</select>",
      '<select id="bare">',
      '<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>',
      "</select>",
    ].join("");
    await ev("document.getElementById('shell').innerHTML = " + JSON.stringify(html));
  });

  it("select labelled by <label for> is reachable by its observe ref", async () => {
    const { observation } = await session.observer.observe(engine, undefined, "standard", true);
    const el = (observation.elements || []).find((e: any) => e.name === "Theme" && e.role === "combobox");
    expect(el).toBeTruthy();
    const res = await ctrl.select({ ref: String(el!.ref) }, { value: "dark" });
    expect(res.ok).toBe(true);
    expect(await ev("document.getElementById('t').value")).toBe("dark");
  });

  it("select with aria-label is reachable by its observe ref", async () => {
    // The labelled and the aria-labelled select deliberately share the name
    // "Theme", so the ref must be located by POSITION, not by name — selecting
    // "the first Theme" would silently re-test the previous case.
    const { observation } = await session.observer.observe(engine, undefined, "standard", true);
    const themes = (observation.elements || []).filter((e: any) => e.name === "Theme" && e.role === "combobox");
    expect(themes.length).toBe(2);
    const res = await ctrl.select({ ref: String(themes[1].ref) }, { value: "light" });
    expect(res.ok).toBe(true);
    // The aria-labelled node (#aria) must be the one that changed.
    expect(await ev("document.getElementById('aria').value")).toBe("light");
  });

  it("bare select with identical option text is reachable by its exact ref", async () => {
    const { observation } = await session.observer.observe(engine, undefined, "standard", true);
    const el = (observation.elements || []).find((e: any) => e.role === "combobox" && e.name !== "Theme");
    expect(el).toBeTruthy();
    const res = await ctrl.select({ ref: String(el!.ref) }, { value: "dark" });
    expect(res.ok).toBe(true);
    expect(await ev("document.getElementById('bare').value")).toBe("dark");
  });

  it("select ref still works after the selected option changes", async () => {
    const { observation } = await session.observer.observe(engine, undefined, "standard", true);
    const el = (observation.elements || []).find((e: any) => e.role === "combobox" && e.name === "Theme");
    await ctrl.select({ ref: String(el!.ref) }, { value: "dark" });
    const res = await ctrl.select({ ref: String(el!.ref) }, { value: "light" });
    expect(res.ok).toBe(true);
    // Whichever node the ref named, its own value must have changed.
    const changed = await ev("JSON.stringify(Array.from(document.querySelectorAll('select')).map(s=>s.id+':'+s.value))");
    expect(String(changed)).toContain("light");
  });
});
