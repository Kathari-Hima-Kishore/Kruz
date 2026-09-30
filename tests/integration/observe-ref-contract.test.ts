/**
 * P0 regression: refs returned by `page.observe` must be directly actionable.
 *
 * The live smoke test found this failing deterministically on every site:
 *
 *   page.observe → ref e92/e113/e255/e1342 → page.click({ref}) → UNKNOWN_REFERENCE
 *
 * Root cause: the Observer and the SessionManager each constructed their OWN
 * `new RefRegistry()`. `page.observe` minted `e<n>` into the Observer's copy;
 * probe/ambiguity/action refs were minted into the session's copy; and the
 * action tools resolved only against the session's copy. Two registries also
 * meant two independent `e` counters, so the same public id could name different
 * nodes depending on which producer issued it.
 *
 * The previous suite (`ref-contract.test.ts`) could not catch this: it wired its
 * stub session the same broken way AND only ever tested `probe → action`, never
 * `observe → action`. These tests wire the session the way SessionManager does —
 * ONE registry — and drive the real Observer + BrowserController.
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

/**
 * Mirror the SessionManager wiring exactly: one RefRegistry, handed to the
 * Observer. If this ever drifts back to two registries, the guard test below
 * fails before any behavioural test gets a chance to lie.
 */
function makeController(e: PuppeteerEngine): BrowserController {
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  session = { id: "session_observe_refs", engine: e, status: "active" as const, observer, refs };
  return new BrowserController({ getActiveEngine: () => e, getActive: () => session } as any);
}

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "kruz-obs-refs-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);
  ctrl = makeController(engine);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const set = (html: string) => engine.page.setContent(html);
const ev = async (expr: string) => engine.evaluate(expr).then((r: any) => r.result);

/** Observe exactly the way the router does for `page.observe`, and force a fresh pass. */
async function observeRefs(scope?: string, detail: "minimal" | "standard" | "full" = "minimal") {
  const { observation } = await session.observer.observe(engine, scope, detail, true);
  return observation;
}

function findRef(observation: any, pred: (e: any) => boolean): string {
  const hit = (observation.elements || []).find(pred);
  if (!hit) throw new Error(`no observed element matched; saw ${JSON.stringify((observation.elements || []).map((e: any) => ({ ref: e.ref, role: e.role, name: e.name })))}`);
  return String(hit.ref);
}

// ── the wiring guard ─────────────────────────────────────────────────────────

describe("P0 guard — one registry per session", () => {
  it("the Observer mints into the session's registry, not a private one", () => {
    expect(session.observer.getRegistry()).toBe(session.refs);
  });

  it("a ref minted by observe is known to the registry the actions resolve from", async () => {
    await set(`<html><body><a id="w" href="/w">Wire</a></body></html>`);
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.name === "Wire");
    expect(session.refs.has(ref)).toBe(true);
  });
});

// ── T1–T5: observe → every compatible action ────────────────────────────────

describe("T1–T5 — observe refs are directly actionable", () => {
  beforeEach(() => set(`<html><body>
    <a id="next" href="#next" onclick="window.hit='next'">Next</a>
    <input id="q" type="text" placeholder="Search" />
    <input id="agree" type="checkbox" />
    <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
    <button id="go" onclick="window.hit='go'">Go</button>
    <div style="height:3000px"></div>
    <button id="deep" onclick="window.hit='deep'">Deep</button>
  </body></html>`));

  it("T1: observe → click acts on that exact element", async () => {
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.name === "Go");
    const res = await ctrl.click({ ref });
    expect(res.error?.code).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("go");
  });

  it("T2: observe → fill writes into the observed input", async () => {
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.role === "textbox" && e.name === "Search");
    const res = await ctrl.fill({ ref }, "Kruz smoke test");
    expect(res.ok).toBe(true);
    expect(await ev("document.getElementById('q').value")).toBe("Kruz smoke test");
  });

  it("T3: observe → select uses the exact returned ref", async () => {
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.role === "combobox");
    const res = await ctrl.select({ ref }, { value: "b" });
    expect(res.ok).toBe(true);
    expect(await ev("document.getElementById('pick').value")).toBe("b");
  });

  it("T4: observe → check ticks the observed checkbox", async () => {
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.role === "checkbox");
    const res = await ctrl.check({ ref });
    expect(res.ok).toBe(true);
    expect(await ev("document.getElementById('agree').checked")).toBe(true);
  });

  it("T5: observe → scroll(target) resolves the off-screen element's ref", async () => {
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.name === "Deep");
    const res = await ctrl.scroll("down", 500, { ref });
    expect(res.ok).toBe(true);
    // And the same ref is still usable for the click that follows the scroll.
    const clicked = await ctrl.click({ ref });
    expect(clicked.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("deep");
  });
});

// ── T6: lifetime across repeated observations ────────────────────────────────

describe("T6 — ref lifetime across multiple observe calls", () => {
  it("a ref from an earlier observe stays actionable after a second observe", async () => {
    await set(`<html><body>
      <button id="a" onclick="window.hitA='a'">Alpha</button>
      <button id="b" onclick="window.hitB='b'">Bravo</button>
    </body></html>`);
    const first = await observeRefs();
    const refA = findRef(first, (e) => e.name === "Alpha");
    const second = await observeRefs();
    const refB = findRef(second, (e) => e.name === "Bravo");
    expect(refA).not.toBe(refB);

    // The OLD ref must still work — observation must not invalidate a ref before
    // the caller can use it.
    const resA = await ctrl.click({ ref: refA });
    expect(resA.ok).toBe(true);
    expect(await ev("String(window.hitA)")).toBe("a");

    const resB = await ctrl.click({ ref: refB });
    expect(resB.ok).toBe(true);
    expect(await ev("String(window.hitB)")).toBe("b");
  });
});

// ── T7: namespace uniqueness ─────────────────────────────────────────────────

describe("T7 — public ref namespace is unique across every producer", () => {
  it("observe, probe and ambiguity refs never collide with one another", async () => {
    await set(`<html><body>
      <button class="dup" onclick="window.n=(window.n||0)+1">Same</button>
      <button class="dup" onclick="window.n=(window.n||0)+10">Same</button>
      <a id="solo" href="/solo" onclick="window.solo='y'">Solo</a>
    </body></html>`);

    const observation = await observeRefs();
    const observedRefs = (observation.elements || []).map((e: any) => String(e.ref));

    const probe = await ctrl.probeTarget(engine, { css: "a#solo" });
    const probeRefs = probe.candidates.map((c) => String(c.ref));

    const ambiguous = await ctrl.click({ css: "button.dup" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error?.code).toBe("AMBIGUOUS_TARGET");
    const ambiguityRefs = (((ambiguous.result as any)?.candidates) ?? []).map((c: any) => String(c.ref));

    const all = [...observedRefs, ...probeRefs, ...ambiguityRefs];
    expect(new Set(all).size).toBe(all.length);

    // And every one of them is a live registry entry, not just a unique string.
    for (const r of all) expect(session.refs.has(r)).toBe(true);

    // A non-`e` ref is never a valid `e` handle, and vice versa.
    expect(observedRefs.every((r) => r.startsWith("e"))).toBe(true);
    expect(probeRefs.every((r) => r.startsWith("c"))).toBe(true);
  });
});

// ── T8: navigation invalidation must stay safe ───────────────────────────────

describe("T8 — navigation invalidates observe refs without hitting a stranger", () => {
  it("an observe ref from document A is refused in document B (DOCUMENT_CHANGED)", async () => {
    await set(`<html><body><a id="t" href="/one" onclick="window.hit='A'">Target</a></body></html>`);
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.name === "Target");

    // Same selector, same accessible name, different document — the exact decoy
    // that must never be clicked by a stale ref.
    await engine.navigate(
      "data:text/html,<html><body><a id='t' href='/two' onclick=\"window.hit='B'\">Target</a></body></html>",
      "domcontentloaded", 5000,
    );
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("DOCUMENT_CHANGED");
    expect(res.error?.retryable).toBe(false);
  });
});

// ── T9: DOM replacement ──────────────────────────────────────────────────────

describe("T9 — DOM replacement never produces a wrong-element action", () => {
  it("a React-style identical replacement is safely re-resolved", async () => {
    await set(`<html><body><div id="host"><button id="x1" onclick="window.hit='ok'">Go</button></div></body></html>`);
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.name === "Go");
    await ev("document.getElementById('host').innerHTML = '<button id=\"x2\" onclick=\"window.hit=\\'ok\\'\">Go</button>'");
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("ok");
  });

  it("a replacement that is a DIFFERENT control is refused, never clicked", async () => {
    await set(`<html><body><div id="host"><button id="x1" onclick="window.hit='old'">Go</button></div></body></html>`);
    const observation = await observeRefs();
    const ref = findRef(observation, (e) => e.name === "Go");
    await ev("document.getElementById('host').innerHTML = '<button id=\"y\" onclick=\"window.hit=\\'new\\'\">Other</button>'");
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(false);
    expect(["STALE_REFERENCE", "DOCUMENT_CHANGED", "TARGET_NOT_ACTIONABLE"]).toContain(res.error?.code);
    expect(await ev("String(window.hit ?? 'none')")).not.toBe("new");
  });
});

// ── T10: same-name siblings keep distinct exact refs ────────────────────────

describe("T10 — same-name siblings keep distinct, exact refs", () => {
  // Fragment hrefs, NOT "/x": these are real navigations, so clicking one
  // discards window.n before the assertion can read it. The identity being
  // tested is which node was clicked, not whether the page stayed put.
  beforeEach(async () => {
    await set(`<html><body>
      <ul>
        <li><a href="#one" onclick="window.n=(window.n||0)+1">Benefits</a></li>
        <li><a href="#two" onclick="window.n=(window.n||0)+10">Benefits</a></li>
      </ul>
    </body></html>`);
    // setContent rewrites the document but keeps the same JS global, so the
    // counter has to be reset explicitly or it carries across tests.
    await ev("window.n = 0");
  });

  it("observe mints two distinct refs for two identical links", async () => {
    const observation = await observeRefs();
    const twins = (observation.elements || []).filter((e: any) => e.name === "Benefits");
    expect(twins.length).toBe(2);
    expect(String(twins[0].ref)).not.toBe(String(twins[1].ref));
  });

  it("clicking one twin's exact ref selects that node and does not degrade into ambiguity", async () => {
    const observation = await observeRefs();
    const twins = (observation.elements || []).filter((e: any) => e.name === "Benefits");
    // Each ref must resolve to its OWN node while both nodes are still live.
    const first = await ctrl.click({ ref: String(twins[0].ref) });
    expect(first.error?.code).not.toBe("AMBIGUOUS_TARGET");
    expect(first.ok).toBe(true);
    expect(await ev("Number(window.n)")).toBe(1);

    await ev("window.n=0");
    const second = await ctrl.click({ ref: String(twins[1].ref) });
    expect(second.error?.code).not.toBe("AMBIGUOUS_TARGET");
    expect(second.ok).toBe(true);
    expect(await ev("Number(window.n)")).toBe(10);
  });

  it("probe candidates for same-name siblings also keep exact identity", async () => {
    const probe = await ctrl.probeTarget(engine, { role: "link", name: "Benefits" });
    expect(probe.count).toBe(2);
    const res = await ctrl.click({ ref: String(probe.candidates[1].ref) });
    expect(res.error?.code).not.toBe("AMBIGUOUS_TARGET");
    expect(res.ok).toBe(true);
    expect(await ev("Number(window.n)")).toBe(10);
  });
});

// ── secondary defect: a ref into a shadow root must not collapse to ambiguity ─

describe("Shadow-DOM refs keep exact identity (MDN-style search control)", () => {
  it("two identical buttons inside separate shadow roots stay individually clickable", async () => {
    await set(`<html><body>
      <div id="mount"></div>
      <script>
        window.n = 0;
        const mk = (hostId, delta) => {
          const host = document.createElement('div');
          host.id = hostId;
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<button onclick="window.n=(window.n||0)+' + delta + '">Search the site</button>';
          document.getElementById('mount').appendChild(host);
        };
        mk('h1', 1); mk('h2', 10);
      </script>
    </body></html>`);
    await ev("void 0");

    const probe = await ctrl.probeTarget(engine, { role: "button", name: "Search the site" });
    expect(probe.count).toBe(2);
    expect(probe.actionable_count).toBe(2);

    // This is the live failure: a fresh actionable probe ref re-resolved to two
    // candidates because the recorded Tier-1 path could not cross the shadow
    // boundary, so the resolver fell through to the ambiguous semantic tier.
    const res = await ctrl.click({ ref: String(probe.candidates[0].ref) });
    expect(res.error?.code).not.toBe("AMBIGUOUS_TARGET");
    expect(res.ok).toBe(true);
    expect(await ev("Number(window.n)")).toBe(1);
  });

  it("an observe ref into a shadow root is actionable too", async () => {
    await set(`<html><body>
      <div id="mount"></div>
      <script>
        const host = document.createElement('div');
        host.id = 'h9';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<button onclick="window.hit=\\'shadow\\'">Deep control</button>';
        document.getElementById('mount').appendChild(host);
      </script>
    </body></html>`);
    await ev("void 0");

    const observation = await observeRefs(undefined, "full");
    const ref = findRef(observation, (e) => e.name === "Deep control");
    const res = await ctrl.click({ ref });
    expect(res.ok).toBe(true);
    expect(await ev("String(window.hit)")).toBe("shadow");
  });
});
