/**
 * Regression suite for the manual bug report (session_1, server v1.7.1).
 *
 * Every test here corresponds to a numbered acceptance failure in the report and
 * drives the REAL PuppeteerEngine + BrowserController, so it exercises the same
 * code path the MCP tools do.
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
let profile: string;

function makeController(e: PuppeteerEngine): BrowserController {
  // ONE registry for the session, handed to the Observer — the same wiring
  // SessionManager uses. Wiring two registries here (which this harness used to
  // do) is precisely the P0 that made observe refs unusable, and it silently
  // disabled every observe→action assertion in this file.
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  // One stable session object: the ref registry must persist across tool calls
  // exactly as it does in the real SessionManager.
  const session = { id: "session_test", engine: e, status: "active" as const, observer, refs };
  return new BrowserController({
    getActiveEngine: () => e,
    getActive: () => session,
  } as any);
}

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "kruz-refs-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);
  ctrl = makeController(engine);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const set = (html: string) => engine.page.setContent(html);

describe("T1/T2/T3 — probe refs are consumable by actions (Bugs 1, 2, 3)", () => {
  beforeEach(() => {
    set(`<html><body>
      <a id="l1" href="#cinemas">Cinemas in Chennai</a>
      <input id="s1" type="text" placeholder="Search by cinema or area" />
      <input id="c1" type="checkbox" />
      <select id="sel"><option value="a">A</option><option value="b">B</option></select>
      <button id="b1" onclick="document.getElementById('out').textContent='ok'">Book</button>
      <div id="out"></div>
    </body></html>`);
  });

  it("T1: probe returns a ref that page.click acts on (no CSS redeclaration)", async () => {
    const probe = await ctrl.probeTarget(engine, { css: "a#l1" });
    expect(probe.count).toBe(1);
    const ref = String(probe.candidates[0].ref);
    // Add an observable effect so we assert the click actually landed, not just
    // that a navigation was attempted from an about:blank document.
    await engine.evaluate("document.getElementById('l1').addEventListener('click', () => { window.hit = 'clicked'; })");
    const clicked = await ctrl.click({ ref });
    expect(clicked.ok).toBe(true);
    expect(await engine.evaluate("String(window.hit)").then((r: any) => r.result)).toBe("clicked");
  });

  it("T2: probe ref round-trips into page.fill", async () => {
    const probe = await ctrl.probeTarget(engine, { css: "input#s1" });
    const ref = String(probe.candidates[0].ref);
    const filled = await ctrl.fill({ ref }, "Kelambakkam");
    expect(filled.ok).toBe(true);
    expect(await engine.evaluate("document.getElementById('s1').value").then((r: any) => r.result)).toBe("Kelambakkam");
  });

  it("T3: probe ref round-trips into page.check", async () => {
    const probe = await ctrl.probeTarget(engine, { css: "input#c1" });
    const ref = String(probe.candidates[0].ref);
    const checked = await ctrl.check({ ref });
    expect(checked.ok).toBe(true);
    expect(await engine.evaluate("document.getElementById('c1').checked").then((r: any) => r.result)).toBe(true);
  });

  it("T3b: probe ref round-trips into page.select", async () => {
    const probe = await ctrl.probeTarget(engine, { css: "select#sel" });
    const ref = String(probe.candidates[0].ref);
    const res = await ctrl.select({ ref }, { value: "b" });
    expect(res.ok).toBe(true);
    expect(await engine.evaluate("document.getElementById('sel').value").then((r: any) => r.result)).toBe("b");
  });
});

describe("T7 — placeholder targeting agrees with CSS (Bug 4)", () => {
  beforeEach(() => set(`<html><body><input id="s" type="text" placeholder="Search by cinema or area" /></body></html>`));

  it("probe by placeholder and by equivalent CSS identify the same element", async () => {
    const byPlaceholder = await ctrl.probeTarget(engine, { placeholder: "Search by cinema or area" });
    const byCss = await ctrl.probeTarget(engine, { css: "input[placeholder='Search by cinema or area']" });
    expect(byPlaceholder.count).toBe(1);
    expect(byCss.count).toBe(1);
    expect(byPlaceholder.strategy).toBe("placeholder");
    expect(byPlaceholder.candidates[0].name).toBe(byCss.candidates[0].name);
  });

  it("fill by placeholder target works without CSS", async () => {
    const res = await ctrl.fill({ placeholder: "Search by cinema or area" }, "Padur");
    expect(res.ok).toBe(true);
    expect(await engine.evaluate("document.getElementById('s').value").then((r: any) => r.result)).toBe("Padur");
  });
});

describe("T6 — hidden matches are distinguished from actionable ones (Bug 2)", () => {
  beforeEach(() => set(`<html><body>
    <a id="vis" href="/x">Cinemas in Chennai</a>
    <a id="hid" href="/y" style="display:none">Cinemas in Chennai</a>
  </body></html>`));

  it("probe reports actionability per candidate and counts only the visible one as actionable", async () => {
    const probe = await ctrl.probeTarget(engine, { css: "a[href]" });
    expect(probe.count).toBe(2);
    expect(probe.actionable_count).toBe(1);
    const byName = probe.candidates.filter((c) => c.name === "Cinemas in Chennai");
    expect(byName.length).toBe(2);
    expect(byName.filter((c) => c.actionable === true).length).toBe(1);
    expect(byName.filter((c) => c.actionable === false).length).toBe(1);
  });

  it("clicking a target whose matches are all hidden reports ELEMENT_NOT_VISIBLE, not TARGET_NOT_FOUND", async () => {
    const res = await ctrl.click({ css: "a#hid" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ELEMENT_NOT_VISIBLE");
  });

  it("a hidden-only match keeps a ref but the click explains why it is not actionable", async () => {
    const probe = await ctrl.probeTarget(engine, { css: "a#hid" });
    const ref = String(probe.candidates[0].ref);
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ELEMENT_NOT_VISIBLE");
  });
});

describe("T4 — stale refs never hit the wrong node", () => {
  it("T4: replacing the node yields STALE_REFERENCE, not a wrong-element click", async () => {
    set(`<html><body><div id="host"><button id="x" onclick="window.hit='old'">Go</button></div></body></html>`);
    const probe = await ctrl.probeTarget(engine, { css: "button#x" });
    const ref = String(probe.candidates[0].ref);
    // Replace the node with a DIFFERENT control, same position.
    await engine.evaluate("document.getElementById('host').innerHTML = '<button id=\"y\" onclick=\"window.hit=\\'new\\'\">Other</button>'");
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(["STALE_REFERENCE", "DOCUMENT_CHANGED", "TARGET_NOT_ACTIONABLE"]).toContain(res.error?.code);
    expect(await engine.evaluate("String(window.hit)").then((r: any) => r.result)).not.toBe("new");
  });

  it("T4b: an identical replacement is safely re-resolved", async () => {
    set(`<html><body><div id="host"><button id="x" onclick="window.hit='ok'">Go</button></div></body></html>`);
    const probe = await ctrl.probeTarget(engine, { css: "button#x" });
    const ref = String(probe.candidates[0].ref);
    // React-style churn: same logical control, new node.
    await engine.evaluate("document.getElementById('host').innerHTML = '<button id=\"x2\" onclick=\"window.hit=\\'ok\\'\">Go</button>'");
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await engine.evaluate("String(window.hit)").then((r: any) => r.result)).toBe("ok");
  });
});

describe("T5 — navigation invalidates refs across documents", () => {
  it("a ref from document A cannot resolve against document B", async () => {
    set(`<html><body><a id="a1" href="/one">Target</a></body></html>`);
    const probe = await ctrl.probeTarget(engine, { css: "a#a1" });
    const ref = String(probe.candidates[0].ref);
    // Same selector, different document.
    await engine.navigate("data:text/html,<html><body><a id='a1' href='/two'>Decoy</a></body></html>", "domcontentloaded", 5000);
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(["DOCUMENT_CHANGED", "STALE_REFERENCE", "UNKNOWN_REFERENCE"]).toContain(res.error?.code);
  });
});

describe("T8 — accessibility semantics resolve the same way everywhere", () => {
  beforeEach(() => set(`<html><body><button aria-label="Search now" onclick="window.hit='aria'">x</button></body></html>`));

  it("probe by role+name returns a ref that click acts on", async () => {
    const probe = await ctrl.probeTarget(engine, { role: "button", name: "Search now" });
    expect(probe.count).toBe(1);
    const res = await ctrl.click({ ref: String(probe.candidates[0].ref) });
    expect(res.ok).toBe(true);
  });

  it("click by role+name directly also works (shared matcher)", async () => {
    const res = await ctrl.click({ role: "button", name: "Search now" });
    expect(res.ok).toBe(true);
  });
});

describe("T9 — off-screen targets scroll into view and use fresh coordinates", () => {
  it("click acts on an element far below the fold", async () => {
    set(`<html><body style="margin:0">
      <div style="height:4000px"></div>
      <button id="deep" onclick="window.hit='deep'">Deep</button>
    </body></html>`);
    expect(await engine.evaluate("window.scrollY").then((r: any) => r.result)).toBe(0);
    const probe = await ctrl.probeTarget(engine, { css: "button#deep" });
    const ref = String(probe.candidates[0].ref);
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await engine.evaluate("String(window.hit)").then((r: any) => r.result)).toBe("deep");
  });
});

describe("T10 — layout shift between discovery and interaction", () => {
  it("still clicks the intended control after the page reflows", async () => {
    set(`<html><body><div id="host"><button id="x" onclick="window.hit='ok'">Go</button></div></body></html>`);
    const probe = await ctrl.probeTarget(engine, { css: "button#x" });
    const ref = String(probe.candidates[0].ref);
    // Insert a spacer, shifting the button's position between resolve and click.
    await engine.evaluate("document.body.insertBefore(document.createElement('div'), document.getElementById('host')).style.height='800px'");
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await engine.evaluate("String(window.hit)").then((r: any) => r.result)).toBe("ok");
  });
});

describe("Dense pages - the matcher must survive a big result set", () => {
  // Regression: the matcher used to return live DOM nodes inside its result.
  // That value crosses the CDP boundary and DOM nodes are not serializable, so
  // on a small page the serializer dropped them quietly and on a larger one it
  // voided the WHOLE result, making page.probe report "0 matches" on exactly the
  // dense pages where the answer matters most. Found live on BookMyShow, where
  // a page with 135 links returned count 0.
  it("probes and clicks correctly on a page with hundreds of elements", async () => {
    const rows = Array.from({ length: 220 }, (_, i) =>
      `<li><a href="/movie/${i}">Movie ${i} (2024) HD</a><button aria-label="Book Movie ${i}">Book</button></li>`).join("");
    const fields = Array.from({ length: 30 }, (_, i) => `<input placeholder="Field ${i}" />`).join("");
    set(`<html><body><ul>${rows}</ul><form>${fields}</form></body></html>`);

    const probe = await ctrl.probeTarget(engine, { css: "a[href^='/movie/']" });
    expect((probe as any).error).toBeUndefined();
    expect(probe.count).toBe(220);
    expect(probe.actionable_count).toBeGreaterThan(0);

    // Fill first: clicking the link navigates away and would take the form with it.
    const byPlaceholder = await ctrl.probeTarget(engine, { placeholder: "Field 7" });
    expect(byPlaceholder.count).toBe(1);
    const filled = await ctrl.fill({ ref: String(byPlaceholder.candidates[0].ref) }, "Kelambakkam");
    expect(filled.ok).toBe(true);

    // Click a non-navigating control so the suite does not race the navigation
    // it triggers.
    const bookBtn = await ctrl.probeTarget(engine, { css: "button[aria-label^='Book Movie']" });
    expect(bookBtn.count).toBe(220);
    const clicked = await ctrl.click({ ref: String(bookBtn.candidates[0].ref) });
    expect(clicked.ok).toBe(true);
  }, 60000);
});

describe("Error semantics - truthful codes and retryability", () => {
  beforeEach(() => set(`<html><body><button id="ok">Fine</button></body></html>`));

  it("unknown ref is terminal, not retryable", async () => {
    const res = await ctrl.click({ ref: "c999" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("UNKNOWN_REFERENCE");
    expect(res.error?.retryable).toBe(false);
  });

  it("no match on a settled page is not retryable (no retry-loop invitation)", async () => {
    const res = await ctrl.click({ css: "#nope" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("TARGET_NOT_FOUND");
    expect(res.error?.retryable).toBe(false);
  });

  it("ambiguity refuses and returns refs that DO work", async () => {
    set(`<html><body><button class="dup" onclick="window.n=(window.n||0)+1">Same</button><button class="dup" onclick="window.n=(window.n||0)+10">Same</button></body></html>`);
    const res = await ctrl.click({ css: "button.dup" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("AMBIGUOUS_TARGET");
    expect(res.error?.retryable).toBe(false);
    const candidates = (res.result as any)?.candidates ?? [];
    expect(candidates.length).toBe(2);
    // The documented recovery path: pick a candidate ref and act on it.
    const picked = await ctrl.click({ ref: String(candidates[1].ref) });
    expect(picked.ok).toBe(true);
    expect(await engine.evaluate("Number(window.n)").then((r: any) => r.result)).toBe(10);
  });

  it("disabled control reports ELEMENT_DISABLED, distinct from not-found", async () => {
    set(`<html><body><button id="d" disabled>Nope</button></body></html>`);
    const res = await ctrl.click({ css: "button#d" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ELEMENT_DISABLED");
  });

  it("non-editable target reports ELEMENT_NOT_EDITABLE, distinct from not-found", async () => {
    set(`<html><body><div id="d">not a field</div></body></html>`);
    const res = await ctrl.fill({ css: "#d" }, "x");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ELEMENT_NOT_EDITABLE");
  });
});
