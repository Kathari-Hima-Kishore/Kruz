import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PuppeteerEngine } from "../../src/browser/engines/puppeteer-engine.js";
import { BrowserController } from "../../src/browser/controller.js";
import { Observer } from "../../src/extractor/observer.js";
import { RefRegistry } from "../../src/browser/ref-registry.js";
import { paginate } from "../../src/browser/ats-tools.js";
import { loadConfig } from "../../src/config.js";

const PAGE = (title: string, body: string, script = "") =>
  `<html><head><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

describe("closed-loop control fixes", () => {
  let engine: PuppeteerEngine, ctrl: BrowserController, observer: Observer, server: Server, origin: string, profile: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url || "/";
      res.setHeader("Content-Type", "text/html");
      if (url === "/thin") {
        // Test 1 — valid title, <100 chars of body text.
        res.end(PAGE("Thin Page", `<canvas id="c" width="10" height="10"></canvas><script>document.getElementById('c').getContext('2d').fillRect(0,0,5,5)</script>`));
        return;
      }
      if (url === "/settled") {
        // Test 2 — meaningful, stable content (the settle detector is safe to run).
        res.end(PAGE("Settled", `<h1>Hello world</h1><p>${"A settled paragraph of real content. ".repeat(4)}</p><button>Go</button>`));
        return;
      }
      if (url === "/delayed") {
        // Test 3 — element appears once after a quiet delay (no DOM activity before it).
        res.end(PAGE("Delayed", "<div id='root'>loading</div>", "setTimeout(()=>{const d=document.createElement('div');d.id='late';d.textContent='arrived';document.getElementById('root').appendChild(d)},1200)"));
        return;
      }
      if (url === "/mutating") {
        // Test 4 — the DOM keeps changing while a late element is still 2.5s away.
        res.end(PAGE("Mutating", "<div id='tick'>0</div><div id='root'></div>",
          "let n=0;const iv=setInterval(()=>{n++;document.getElementById('tick').textContent=String(n);if(n>=25)clearInterval(iv)},100);" +
          "setTimeout(()=>{const d=document.createElement('div');d.id='late';d.textContent='late content';document.getElementById('root').appendChild(d)},2500)"));
        return;
      }
      if (url === "/ambiguous") {
        // Test 6 — three identical controls with distinguishable context.
        res.end(PAGE("Ambiguous", "<section><h2>Venue A</h2><button>Book</button></section><section><h2>Venue B</h2><button>Book</button></section><section><h2>Venue C</h2><button>Book</button></section>"));
        return;
      }
      if (url === "/form") {
        // Test 7/8 — controlled form; submit handler writes a result the test can read.
        res.end(PAGE("Form", `<p>${"x".repeat(200)}</p><form id="f"><input id="n" placeholder="Name"><input id="e"><button type="submit">Go</button></form><div id="out"></div>`,
          "document.getElementById('f').addEventListener('submit',ev=>{ev.preventDefault();document.getElementById('out').textContent='submitted:'+document.getElementById('n').value})"));
        return;
      }
      if (url === "/list") {
        // Test 11 — each click adds exactly 3 items, 4 times, then the button vanishes.
        res.end(PAGE("List", `${Array.from({ length: 10 }, (_, i) => `<a href="/job/${i}">Job ${i}</a>`).join("")}<button id="lm">Load More</button>`,
          "let rounds=0;document.getElementById('lm').addEventListener('click',()=>{rounds++;const b=document.body;for(let i=0;i<3;i++){const a=document.createElement('a');a.href='/job/x'+rounds+'-'+i;a.textContent='Job x'+rounds+'-'+i;b.appendChild(a)}if(rounds>=4)document.getElementById('lm').remove()})"));
        return;
      }
      if (url === "/list-fail") {
        // Test 12 — the first click throws; the loop must stop with a structured partial, not continue blind.
        res.end(PAGE("ListFail", `${Array.from({ length: 6 }, (_, i) => `<a href="/job/${i}">Job ${i}</a>`).join("")}<button id="lm">Load More</button>`,
          "document.getElementById('lm').addEventListener('click',()=>{throw new Error('backend blew up')})"));
        return;
      }
      if (url === "/dense") {
        // Test 15 — 500 interactive nodes for the observation cap.
        res.end(PAGE("Dense", Array.from({ length: 500 }, (_, i) => `<a href="/x/${i}">Item ${i}</a>`).join("")));
        return;
      }
      if (url === "/overlay") {
        // Test 9 — a cookie banner covers the target until it is dismissed. The
        // dismissal rewires the button to a clean handler so the retry succeeds.
        res.end(PAGE("Overlay",
          `<div id="cookie" class="cookie-banner" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center">` +
          `<div style="background:#fff;padding:20px">We use cookies <button id="reject">Reject</button><button>Accept all</button></div></div>` +
          `<button id="cta" onclick="window.hit=1">Continue</button><div id="out"></div>`,
          `document.getElementById('reject').addEventListener('click',()=>{document.getElementById('cookie').remove();document.getElementById('cta').setAttribute('onclick','window.hit=1;document.getElementById(\\'out\\').textContent=\\'clicked\\'');});`));
        return;
      }
      res.end(PAGE("Home", "<h1>Home</h1><a href='/settled'>settled</a>"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
    profile = await mkdtemp(join(tmpdir(), "kruz-cloop-"));
    engine = new PuppeteerEngine(true);
    await engine.boot({ ...loadConfig(), headless: false }, profile);
    // One shared registry (the SessionManager contract): the Observer mints
    // observe refs into it and the action tools resolve from it.
    const refs = new RefRegistry();
    observer = new Observer(100, refs);
    ctrl = new BrowserController({
      getActiveEngine: () => engine,
      getActive: () => ({ id: "s1", engine, status: "active", observer, refs, config: loadConfig(), navigationTrace: [] }),
      trace: () => {},
    } as any);
  });
  afterAll(async () => {
    await engine?.shutdown();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const open = async (path: string) => {
    const r = await ctrl.open(`${origin}${path}`, "domcontentloaded", 10000);
    expect(r.ok).toBe(true);
    return r;
  };

  it("Test 1 — thin page (valid title, <100 chars) is ready immediately, not after the poll", async () => {
    const started = Date.now();
    const r = await open("/thin");
    const elapsed = Date.now() - started;
    expect(r.result?._ready).toBe(true);
    expect(r.result?.body_length).toBeLessThan(100);
    expect(elapsed).toBeLessThan(3000); // was ~15,000ms before P0-B
  });

  it("Test 2 — impossible wait on a settled page fails early, not at the hard timeout", async () => {
    await open("/settled");
    const started = Date.now();
    const r = await ctrl.wait("content", undefined, undefined, undefined, 20000, "document.querySelector('.never-exists-xyz')");
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("CONDITION_NOT_MET");
    expect(r.error?.retryable).toBe(false);
    expect(elapsed).toBeLessThan(6000); // was the full 20,000ms
  });

  it("Test 3 — a genuinely delayed element still satisfies the wait", async () => {
    await open("/delayed");
    const r = await ctrl.wait("content", undefined, undefined, undefined, 10000, "document.getElementById('late')");
    expect(r.ok).toBe(true);
  });

  it("Test 4 — a long-mutating SPA does not trigger a premature settle failure", async () => {
    await open("/mutating");
    const r = await ctrl.wait("content", undefined, undefined, undefined, 10000, "document.getElementById('late')");
    expect(r.ok).toBe(true); // element arrives at 2.5s while the DOM mutates every 100ms
  });

  it("Test 5 — a nonexistent CSS target fails fast and respects the caller budget", async () => {
    await open("/settled");
    const started = Date.now();
    const r = await ctrl.click({ css: "#no-such-element" }, undefined, undefined, 400);
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(["TARGET_NOT_FOUND", "ELEMENT_NOT_FOUND"]).toContain(r.error?.code);
    expect(elapsed).toBeLessThan(1500); // was ~3000ms fixed
  });

  it("Test 6 — an ambiguous target returns bounded candidates instead of just a count", async () => {
    await open("/ambiguous");
    const r = await ctrl.click({ text: "Book" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("AMBIGUOUS_TARGET");
    const candidates = (r.result as any)?.candidates as any[];
    expect(candidates.length).toBe(3);
    expect(candidates.every((c) => c.name === "Book")).toBe(true);
    expect(candidates.some((c) => /Venue/.test(c.context ?? ""))).toBe(true);
  });

  it("Test 7 — fill returns decision-grade state, not just {ok:true}", async () => {
    await open("/form");
    const before = await ctrl.pageFeedback(engine, null, { includeLists: false });
    const r = await ctrl.fill({ css: "#n" }, "Ada");
    expect(r.ok).toBe(true);
    const after = await ctrl.pageFeedback(engine, before as any, { includeLists: false });
    expect(after.dom_changed).toBe(true);
    expect(after.focus).toBe("n");
    expect(await engine.inputValue((await engine.queryOne({ css: "#n" }))!)).toBe("Ada");
  });

  it("Test 8 — Enter produces a real, observable submit effect", async () => {
    await open("/form");
    await ctrl.fill({ css: "#n" }, "Ada");
    const before = await ctrl.pageFeedback(engine, null, { includeLists: false });
    const r = await ctrl.press("Enter", { css: "#e" });
    expect(r.ok).toBe(true);
    // Give the (synchronous) submit handler a moment, then read the effect.
    await engine.waitMs(200);
    const after = await ctrl.pageFeedback(engine, before as any, { includeLists: false });
    const out = await engine.evaluate("document.getElementById('out').textContent");
    expect(out.result).toBe("submitted:Ada");
    expect(after.dom_changed).toBe(true);
  });

  it("Test 8b — a single-input form still implicit-submits on Enter (input-lock regression)", async () => {
    // Regression for P2-B: element-level press must run inside the model-dispatch
    // window, otherwise the in-page input lock cancels keydown in the capture phase
    // and implicit form submission never fires. This form follows the HTML spec case
    // where implicit submission is expected (exactly one text input, no submit button).
    const single = `<html><head><title>Single</title></head><body><p>${"x".repeat(200)}</p><form id="f"><input id="n" placeholder="Name"></form><div id="out"></div><script>document.getElementById('f').addEventListener('submit',ev=>{ev.preventDefault();document.getElementById('out').textContent='single:'+document.getElementById('n').value})</script></body></html>`;
    await engine.navigate(`data:text/html,${encodeURIComponent(single)}`, "domcontentloaded", 5000);
    await ctrl.fill({ css: "#n" }, "Ada");
    await ctrl.press("Enter", { css: "#n" });
    await engine.waitMs(200);
    const out = await engine.evaluate("document.getElementById('out').textContent");
    expect(out.result).toBe("single:Ada");
  });

  it("Test 10 — a missing target on a settled page does not run a pointless ladder", async () => {
    await open("/settled");
    const started = Date.now();
    const r = await ctrl.click({ text: "NonExistentControl" }, undefined, undefined, 500);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TARGET_NOT_FOUND");
    expect(r.error?.retryable).toBe(false); // terminal → no recovery ladder (P1-D/§28)
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("Test 11 — pagination verifies each step added content before continuing", async () => {
    await open("/list");
    const r = await paginate(engine as any, { loadMoreSelector: "#lm", maxScrolls: 10, waitMs: 400, budgetMs: 10000 });
    expect(r.loaded).toBeGreaterThanOrEqual(22); // 10 initial + 4 rounds × 3
    expect(r.reason).toBe("selector_gone"); // button removed after the last round
    expect(r.iterations).toBeGreaterThanOrEqual(4);
    expect(r.partial).toBe(false);
  });

  it("Test 12 — a failing pagination step stops with a structured partial result", async () => {
    await open("/list-fail");
    const r = await paginate(engine as any, { loadMoreSelector: "#lm", maxScrolls: 10, waitMs: 300, budgetMs: 10000 });
    // The click dispatched but the page's handler threw, so no content was added. The
    // loop must STOP (no blind continuation) and say why — not keep clicking.
    expect(r.partial).toBe(true);
    expect(["no_new_content", "step_failed"]).toContain(r.reason);
    expect(r.iterations).toBeLessThanOrEqual(1);
  });

  it("Test 13 — pagination respects its deadline instead of being killed by the route timeout", async () => {
    await open("/list");
    const started = Date.now();
    const r = await paginate(engine as any, { maxScrolls: 40, waitMs: 500, budgetMs: 1500 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(r.remaining_budget_ms).toBeGreaterThanOrEqual(0);
    expect(["budget_exhausted", "selector_gone", "no_new_content", "terminal"]).toContain(r.reason);
  });

  it("Test 14 — page.evaluate mutation is observable via the feedback signature", async () => {
    await open("/settled");
    const before = await ctrl.pageFeedback(engine, null, { includeLists: false });
    const readOnly = await ctrl.evaluate("document.title");
    expect(readOnly.ok).toBe(true);
    const afterRead = await ctrl.pageFeedback(engine, before as any, { includeLists: false });
    expect(afterRead.dom_changed).toBe(false);
    expect(afterRead.page_mutated).toBe(false);
    await ctrl.evaluate("(() => { document.title = 'mutated-' + Date.now(); return 1 })()");
    const afterMutate = await ctrl.pageFeedback(engine, before as any, { includeLists: false });
    expect(afterMutate.dom_changed).toBe(true);
    expect(afterMutate.page_mutated).toBe(true);
  });

  it("Test 9 — an obscured target is classified recoverable, and overlay recovery lands the click", async () => {
    // The automatic ladder itself (escalation → retry) lives in the router and is proven
    // by tests/unit/retry-structured.test.ts. This test proves the two pieces it composes:
    // (a) an obscured click yields a RECOVERABLE structured error (P1-D classification),
    // (b) the recovery action (dismiss overlays) then re-resolve and retry succeeds.
    await open("/overlay");

    // (a) obscured → structured, retryable (this is what makes the ladder eligible).
    const first = await ctrl.click({ text: "Continue" }, undefined, undefined, 3000);
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("ELEMENT_OBSCURED");
    expect(first.error?.retryable).toBe(true);

    // (b) the escalation the ladder runs: dismiss the overlay.
    const handled = await ctrl.handleOverlays({ handle_js_alerts: false });
    expect((handled.result as any)?.dismissed).toContain("cookie");
    const banner = await engine.evaluate("!!document.getElementById('cookie')");
    expect(banner.result).toBe(false);

    // Retry after re-observation succeeds — the click lands and the effect is real.
    await observer.observe(engine, undefined, "minimal", true);
    const second = await ctrl.click({ text: "Continue" }, undefined, undefined, 3000);
    expect(second.ok).toBe(true);
    expect((await engine.evaluate("window.hit === 1")).result).toBe(true);

    // Terminal failures must NOT enter the ladder: a missing target stays fast.
    const started = Date.now();
    const miss = await ctrl.click({ text: "NoSuchControlAnywhere" }, undefined, undefined, 500);
    expect(miss.error?.code).toBe("TARGET_NOT_FOUND");
    expect(miss.error?.retryable).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("Test 15 — a dense page observation stays bounded in minimal mode", async () => {
    await open("/dense");
    const { observation } = await observer.observe(engine, undefined, "minimal", true);
    expect(observation.elements.length).toBeLessThanOrEqual(120);
    const full = await observer.observe(engine, undefined, "full", true);
    expect(full.observation.elements.length).toBeLessThanOrEqual(2000);
  });
});