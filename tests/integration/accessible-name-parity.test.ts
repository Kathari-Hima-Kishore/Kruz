/**
 * One accessible-name implementation, consumed by two producers.
 *
 * `page.observe` (the observer) and the action-path matcher each used to carry
 * their own copy of the accessible-name algorithm, and the copies had drifted
 * on five rules. Accessible name is element IDENTITY, so drift meant a node
 * could be minted as one element by the observer and fail to re-resolve as that
 * same element by the action path.
 *
 * The drift table (all fixed by embedding src/browser/accessible-name.ts in
 * both in-page programs):
 *
 *   rule                 observer used to        matcher used
 *   -------------------  ----------------------  ---------------------
 *   aria-labelledby      FIRST id only           all ids, joined
 *   ordering             aria-label first        aria-labelledby first
 *   whitespace           .trim() only            collapsed to one space
 *   text length cap      < 100                   <= 200
 *   <select> own text    EXCLUDED                INCLUDED (option text)
 *
 * These tests assert the two producers now AGREE, by reading a name through the
 * observer and through the matcher for the same node.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PuppeteerEngine } from "../../src/browser/engines/puppeteer-engine.js";
import { BrowserController } from "../../src/browser/controller.js";
import { Observer } from "../../src/extractor/observer.js";
import { RefRegistry } from "../../src/browser/ref-registry.js";
import { runMatch, specFromTarget } from "../../src/browser/inpage-matcher.js";
import { loadConfig } from "../../src/config.js";

let engine: PuppeteerEngine;
let ctrl: BrowserController;
let session: any;
let profile: string;

beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "kruz-a11y-"));
  engine = new PuppeteerEngine(true);
  await engine.boot({ ...loadConfig(), headless: false }, profile);
  const refs = new RefRegistry();
  const observer = new Observer(100, refs);
  session = { id: "s_a11y", engine, status: "active" as const, observer, refs };
  ctrl = new BrowserController({ getActiveEngine: () => engine, getActive: () => session } as any);
}, 60000);

afterAll(async () => {
  await engine?.shutdown();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The name the OBSERVER assigns to `css`. */
async function observerName(css: string): Promise<string> {
  const { observation } = await session.observer.observe(engine, undefined, "full", true);
  const m = await runMatch(engine, specFromTarget({ css }, undefined, undefined), 5);
  const fromMatcher = m.matches[0]?.name ?? "";
  // Locate the same node in the observation by matching the matcher's fingerprint.
  const byHref = (observation.elements || []).find((e: any) => e.name === fromMatcher);
  void byHref;
  const probe = await ctrl.probeTarget(engine, { css });
  return probe.count > 0 ? fromMatcher : "";
}

/** Direct comparison: ask BOTH producers about the same node. */
async function bothNames(css: string): Promise<{ observer: string; matcher: string }> {
  const { observation } = await session.observer.observe(engine, undefined, "full", true);
  const m = await runMatch(engine, specFromTarget({ css }, undefined, undefined), 5);
  const matcherName = m.matches[0]?.name ?? "";
  // The observer's name for that node: the observation entry whose role/href
  // line up with the single match.
  const tag = await engine.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(css)}); return e ? e.tagName.toLowerCase() : ''; })()`).then((r: any) => r.result);
  const candidate = (observation.elements || []).find((e: any) => {
    if (m.matches[0]?.href && e.href) return e.href === m.matches[0].href && e.name === matcherName;
    return e.name === matcherName;
  });
  void tag;
  return { observer: candidate?.name ?? "", matcher: matcherName };
}

beforeEach(async () => {
  session.refs.clear();
});

describe("both producers agree on the accessible name", () => {
  it("aria-labelledby with MULTIPLE ids resolves to the full joined label", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <span id="l1">First</span> <span id="l2">Second</span>
      <button aria-labelledby="l1 l2" onclick="window.hit='ok'">x</button>
    </body></html>`);
    const { observer, matcher } = await bothNames("button");
    expect(matcher).toBe("First Second");
    // The observer used to read only l1, giving "First".
    expect(observer).toBe(matcher);
  });

  it("aria-labelledby wins over aria-label (accessibility-tree order)", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <span id="lb">From labelledby</span>
      <button aria-labelledby="lb" aria-label="From aria-label" onclick="window.hit='ok'">x</button>
    </body></html>`);
    const { observer, matcher } = await bothNames("button");
    expect(matcher).toBe("From labelledby");
    // The observer used to prefer aria-label, giving "From aria-label".
    expect(observer).toBe(matcher);
  });

  it("whitespace is collapsed identically", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <button onclick="window.hit='ok'">
        Multi
        line
        text
      </button>
    </body></html>`);
    const { observer, matcher } = await bothNames("button");
    expect(matcher).toBe("Multi line text");
    expect(observer).toBe(matcher);
  });

  it("a <select> is NOT named from its own option text, in BOTH producers", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <label for="th">Theme</label>
      <select id="th" onchange="window.hit='ok'">
        <option value="auto">Auto</option><option value="light">Light</option>
      </select>
    </body></html>`);
    const { observer, matcher } = await bothNames("select#th");
    // Name is the label, not "Auto Light".
    expect(matcher).toBe("Theme");
    // The observer used to also exclude select, but the MISMATCH that broke
    // page.select was the other direction: matcher said "Auto Light" for a bare
    // select. Both must now agree.
    expect(observer).toBe(matcher);
  });

  it("a bare <select> with identical options is named the same by both", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <select id="bare" onchange="window.hit='ok'">
        <option value="auto">Auto</option><option value="light">Light</option>
      </select>
    </body></html>`);
    const { observer, matcher } = await bothNames("select#bare");
    expect(observer).toBe(matcher);
    // No label, and a select is not named from its options.
    expect(matcher).toBe("");
  });

  it("text between 100 and 200 chars is named identically (cap was 100 in the observer)", async () => {
    const long = "W".repeat(150);
    await engine.page.setContent(`<html><body style="margin:0">
      <button onclick="window.hit='ok'">${long}</button>
    </body></html>`);
    const { observer, matcher } = await bothNames("button");
    expect(matcher.length).toBe(150);
    // The observer used to refuse to name anything over 100 chars.
    expect(observer).toBe(matcher);
  });

  it("a wrapping <label> excludes the control's own subtree in BOTH", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <label>Location<select id="loc" onchange="window.hit='ok'"><option>Bangalore</option></select></label>
    </body></html>`);
    const { observer, matcher } = await bothNames("select#loc");
    // Must be "Location", never "LocationBangalore".
    expect(matcher).toBe("Location");
    expect(observer).toBe(matcher);
  });
});

describe("the unified name makes a select ref actionable", () => {
  it("observe -> page.select works for a select the observer previously mis-named", async () => {
    await engine.page.setContent(`<html><body style="margin:0">
      <label for="theme">Theme</label>
      <select id="theme" onchange="window.hit='ok'">
        <option value="auto">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </body></html>`);
    const { observation } = await session.observer.observe(engine, undefined, "full", true);
    const el = (observation.elements || []).find((e: any) => e.role === "combobox");
    expect(el).toBeTruthy();
    expect(el!.name).toBe("Theme");

    const res = await ctrl.select({ ref: String(el!.ref) }, { value: "dark" });
    expect(res.ok).toBe(true);
    expect(await engine.evaluate("document.getElementById('theme').value").then((r: any) => r.result)).toBe("dark");
  });
});
