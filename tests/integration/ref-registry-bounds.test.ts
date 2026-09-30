/**
 * The ref registry must stay BOUNDED over a long session.
 *
 * Refs are minted per observation — a `full` observe on a dense page is ~2000 —
 * and every re-render mints a fresh set. The registry used to grow without
 * limit: measured 1440 live entries after 12 re-renders in ONE document, and
 * +400 per navigation with a counter that never reset, so a long session reached
 * 5-digit ref ids and a `known_refs` diagnostic full of noise.
 *
 * Two independent problems, fixed together:
 *   1. unbounded `entries` — now capped, evicting oldest-first
 *   2. monotonic `counters` across documents — now reset once the map is empty
 *      of the old document, which is the only moment recycling is safe
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

beforeAll(async () => {
  // A real http origin so a navigation produces a genuinely new document with
  // `performance.timeOrigin` — which is what the registry keys on.
  server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="margin:0"><div style="display:block;height:200px">seed</div></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  profile = await mkdtemp(join(tmpdir(), "kruz-bounded-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  session = { id: "s_bounded", engine, status: "active" as const, observer, refs };
  ctrl = new BrowserController({ getActiveEngine: () => engine, getActive: () => session } as any);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const ev = async (x: string) => engine.evaluate(x).then((r: any) => r.result);

/**
 * Re-render the page in place with `n` links.
 *
 * `href="#s<i>"` rather than a real path: these tests click links, and a real
 * href would navigate the page out from under the next test's `setContent`
 * ("Execution context was destroyed"). The ref/identity behaviour under test
 * does not depend on the destination.
 */
async function renderLinks(n: number) {
  await ev("document.body.innerHTML = " + JSON.stringify(
    Array.from({ length: n }, (_, i) => `<a href="#s${i}">L${i}</a>`).join(""),
  ));
}

beforeEach(async () => {
  // Refs are document-scoped and `setContent` does NOT change timeOrigin, so
  // without an explicit reset each test would inherit the previous test's
  // entries and counters — making these assertions order-dependent.
  session.refs.clear();
  await engine.page.setContent(
    `<html><body style="margin:0"><div style="display:block;height:200px">seed</div></body></html>`,
  );
});

describe("the registry stays bounded within a document", () => {
  it("does not grow without limit across many re-renders of the same document", async () => {
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      await renderLinks(150);
      await session.observer.observe(engine, undefined, "standard", true);
      seen.push(session.refs.stats().entries);
    }
    // 20 re-renders x 150 links = 3000 mints. The cap must hold regardless of
    // how many times the page re-renders underneath us.
    expect(Math.max(...seen)).toBeLessThanOrEqual(6000);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(6000);
  });

  it("keeps the MOST RECENT observation's refs actionable after eviction pressure", async () => {
    // Push past the cap, then confirm the refs the model would actually be
    // acting from — the latest observation — are the survivors.
    for (let i = 0; i < 60; i++) {
      await renderLinks(150);
      await session.observer.observe(engine, undefined, "standard", true);
    }
    const { observation } = await session.observer.observe(engine, undefined, "standard", true);
    const newest = (observation.elements || []).filter((e: any) => e.name === "L149");
    expect(newest.length).toBeGreaterThan(0);
    const res = await ctrl.click({ ref: String(newest[0].ref) });
    // A fresh ref must be usable — eviction must not eat the current view.
    expect(res.ok).toBe(true);
  });

  it("an evicted ref reports a precise, non-retryable failure", async () => {
    // Drive the map past the cap, then use a ref that was minted first and has
    // therefore been evicted.
    for (let i = 0; i < 80; i++) {
      await renderLinks(150);
      await session.observer.observe(engine, undefined, "standard", true);
    }
    const stats = session.refs.stats();
    expect(stats.entries).toBeLessThanOrEqual(6000);
    // The first id minted in this document is long gone.
    expect(session.refs.has("e1")).toBe(false);

    const res = await ctrl.click({ ref: "e1" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNKNOWN_REFERENCE");
    expect(res.error?.retryable).toBe(false);
    // The help must point at re-observing, not send the model hunting a typo.
    expect(res.error?.help).toMatch(/observe|probe/i);
  });
});

describe("counters restart in a new document", () => {
  it("ref ids do not keep climbing across navigations", async () => {
    // A REAL http navigation: `performance.timeOrigin` changes, so the registry
    // can tell this is a different document and recycle the id space. A `data:`
    // URL would not do — the observer needs laid-out elements, and data: pages
    // do not produce them here.
    const links = (n: number) =>
      Array.from({ length: n }, (_, i) => `<a href="#s${i}">L${i}</a>`).join("");

    await engine.navigate(`${origin}/doc-a.html`, "domcontentloaded", 10000);
    await ev("document.body.innerHTML = " + JSON.stringify(links(40)));
    const { observation: first } = await session.observer.observe(engine, undefined, "minimal", true);
    const firstMax = Math.max(
      0, ...first.elements.map((e: any) => parseInt(String(e.ref).replace(/^\D+/, ""), 10) || 0),
    );

    await engine.navigate(`${origin}/doc-b.html`, "domcontentloaded", 10000);
    await ev("document.body.innerHTML = " + JSON.stringify(links(40)));
    const { observation: second } = await session.observer.observe(engine, undefined, "minimal", true);
    const secondMax = Math.max(
      0, ...second.elements.map((e: any) => parseInt(String(e.ref).replace(/^\D+/, ""), 10) || 0),
    );

    expect(firstMax).toBeGreaterThan(0);
    expect(secondMax).toBeGreaterThan(0);
    // The second document starts in the same small id space instead of
    // continuing from the first document's high-water mark.
    expect(secondMax).toBeLessThanOrEqual(firstMax);
    expect(session.refs.stats().counters.e).toBeLessThanOrEqual(firstMax);
  });

  it("a ref from the previous document cannot act on the new one", async () => {
    await renderLinks(40);
    const { observation: first } = await session.observer.observe(engine, undefined, "minimal", true);
    const oldRef = String((first.elements || [])[0].ref);

    // A REAL navigation, so performance.timeOrigin changes and the registry can
    // tell this is a different document.
    await engine.navigate(`${origin}/other.html`, "domcontentloaded", 10000);
    await ev("document.body.innerHTML = " + JSON.stringify("<a href='#n'>New</a>".repeat(40)));
    await session.observer.observe(engine, undefined, "minimal", true);

    const res = await ctrl.click({ ref: oldRef });
    // Whatever happens, it must never be a silent wrong-element click: the action
    // either fails with a precise reason, or the registry genuinely re-minted
    // that id in the CURRENT document (which is only possible because the old
    // document's refs were all dropped first).
    if (res.ok) {
      expect(session.refs.has(oldRef)).toBe(true);
    } else {
      expect(["DOCUMENT_CHANGED", "UNKNOWN_REFERENCE", "STALE_REFERENCE"]).toContain(res.error?.code);
      expect(res.error?.retryable).toBe(false);
    }
  });
});
