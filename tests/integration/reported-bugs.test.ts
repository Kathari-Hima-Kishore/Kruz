import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PuppeteerEngine } from "../../src/browser/engines/puppeteer-engine.js";
import { ExtensionEngine } from "../../src/browser/engines/extension-engine.js";
import { BrowserController } from "../../src/browser/controller.js";
import { loadConfig } from "../../src/config.js";
import { overlayScript } from "../../src/browser/overlays.js";
import { ORACLE_COUNT_SCRIPT } from "../../src/browser/oracle-count.js";
import { resolveElementWithRef } from "../../src/browser/selectors.js";
import { readFile } from "node:fs/promises";
import { verifyPosting } from "../../src/browser/ats-tools.js";

describe("headed browser regression fixtures", () => {
  let engine: PuppeteerEngine, ctrl: BrowserController, server: Server, origin: string, profile: string;
  let applyClicks = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/apply') { applyClicks++; res.end('Unexpected Apply'); return; }
      if (req.url === '/bounce') { res.writeHead(302, { Location: '/listing' }); res.end(); return; }
      if (req.url?.startsWith('/job/')) {
        const id = req.url.split('/').pop();
        const body = `<h1>Software Engineer ${id}</h1><div class="company">Company ${id}</div><div class="job-description">${'Build software infrastructure and backend services. '.repeat(5)} Minimum 1 year of experience. Work with closed source software.</div><button onclick="fetch('/apply')">Apply</button>`;
        const shell = `<h1>Software Engineer ${id}</h1><button>Apply</button><footer>${'We are an equal opportunity employer. Learn about our benefits and culture. '.repeat(8)}</footer>`;
        res.end(`<html><title>Shell ${id}</title><body>${shell}<script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(body)} }, ${id === '2' ? 1500 : 200})</script></body></html>`);
        return;
      }
      res.end('<html><title>Listing</title><body>Listing page</body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
    profile = await mkdtemp(join(tmpdir(), 'kruz-regression-'));
    engine = new PuppeteerEngine(true);
    await engine.boot({ ...loadConfig(), headless: false }, profile);
    await engine.navigate(origin, 'domcontentloaded', 5000);
    ctrl = new BrowserController({ getActiveEngine: () => engine, getActive: () => ({ engine, status: 'active', observer: { bumpMutation() {}, getRefMap: () => new Map() } }) } as any);
  });
  afterAll(async () => {
    await engine?.shutdown();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("isolates three concurrent verifications, waits for bodies, preserves active tab, and never clicks Apply", async () => {
    const original = await engine.url();
    const responses = await Promise.all([1, 2, 3].map(id => ctrl.atsVerifyPosting(`${origin}/job/${id}`)));
    responses.forEach((response, i) => {
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ posting_url: `${origin}/job/${i + 1}`, title: `Software Engineer ${i + 1}`, company: `Company ${i + 1}`, status: 'live', apply_present: true, apply_liveness: 'not_checked' });
      expect((response.result as any).body_text).toContain('Build software');
    });
    expect(applyClicks).toBe(0);
    expect(await engine.url()).toBe(original);
    expect((await engine.listTabs()).length).toBe(1);
  });
  it("flags a listing redirect without adopting its identity", async () => {
    const response = await ctrl.atsVerifyPosting(`${origin}/bounce`);
    expect(response.result).toMatchObject({ posting_url: `${origin}/bounce`, landed_url: `${origin}/listing`, verdict: 'hold', body_text: '' });
  });
  it("scans a clean page quickly, obeys options, and confirms actual dismissals", async () => {
    await engine.page.setContent('<button onclick="window.bad = true">Apply</button><div class="app-banner"><button onclick="this.parentNode.remove()">Close</button></div>');
    const disabled = await engine.evaluate(overlayScript({ cookie: false, newsletter: false, chat: false, app: false }));
    expect((disabled.result as any).dismissed).toEqual([]);
    const response = await ctrl.handleOverlays();
    expect(response.ok).toBe(true);
    expect((response.result as any).dismissed).toEqual(['app']);
    expect((await engine.evaluate('window.bad === true')).result).toBe(false);
    const start = Date.now();
    expect((await ctrl.handleOverlays()).ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });
  it("does not toggle chat launchers and reports an undismissed banner", async () => {
    await engine.page.setContent('<div class="chat-widget"><button onclick="window.opened = true">Open chat</button></div><div class="app-banner"><button>Close</button></div>');
    const result = await ctrl.handleOverlays();
    expect(result.ok).toBe(false);
    expect((result.result as any).failed.length).toBe(2);
    expect((await engine.evaluate('window.opened === true')).result).toBe(false);
  });
  it("extracts Oracle tab counts including commas and zero", async () => {
    for (const [html, count] of [['<div role="tab">Jobs <span>797</span></div>', 797], ['<h1>Jobs (1,234)</h1>', 1234], ['<h2>0 Jobs</h2>', 0]] as const) {
      await engine.page.setContent(html);
      expect((await engine.evaluate(ORACLE_COUNT_SCRIPT)).result).toBe(count);
    }
  });
  it("keeps dialogs pending until explicitly answered and does not consume the next dialog", async () => {
    await engine.page.setContent('<p>Dialogs</p>');
    const first = engine.page.evaluate(() => confirm('First?'));
    for (let i = 0; i < 20 && !(await engine.nextDialog()); i++) await engine.waitMs(25);
    expect((await engine.nextDialog())?.message).toBe('First?');
    expect((await engine.nextDialog())?.message).toBe('First?');
    await ctrl.dialog('dismiss');
    expect(await first).toBe(false);
    const second = engine.page.evaluate(() => prompt('Second?', 'default'));
    for (let i = 0; i < 20 && !(await engine.nextDialog()); i++) await engine.waitMs(25);
    expect((await engine.nextDialog())?.defaultValue).toBe('default');
    await ctrl.dialog('accept', 'answer');
    expect(await second).toBe('answer');
  });
  it("keeps indexed targets intact through the extension wrapper", async () => {
    await engine.page.setContent('<button onclick="window.clicked=0">Apply</button><button onclick="window.clicked=1">Details</button>');
    await engine.evaluate('window.__kruz__ = { click: sel => { document.querySelector(sel).click(); return {ok:true} } }');
    const extension = new ExtensionEngine();
    (extension as any)._puppeteer = engine;
    (extension as any)._portalReady = true;
    const buttons = await extension.queryAll({ css: 'button' });
    await extension.click(buttons[1]);
    expect((await engine.evaluate('window.clicked')).result).toBe(1);
  });
  it("binds element evaluation, selects empty-valued labels/indexes, and rejects missing options", async () => {
    await engine.page.setContent('<select id="location"><option value="x">Elsewhere</option><option value="">India</option><option value="blank"></option></select>');
    const el = (await engine.queryOne({ css: '#location' }))!;
    expect((await engine.evaluateOn(el, 'this.tagName')).result).toBe('SELECT');
    expect((await ctrl.select({ css: '#location' }, { label: 'India' })).ok).toBe(true);
    expect(await engine.inputValue(el)).toBe('');
    expect((await ctrl.select({ css: '#location' }, { index: 2 })).ok).toBe(true);
    expect(await engine.inputValue(el)).toBe('blank');
    await expect(engine.selectOption(el, 'Missing')).rejects.toThrow('Option not found');
    expect(await engine.inputValue(el)).toBe('blank');
  });
  it("checks native and ARIA toggles idempotently and rejects unchanged/unknown state", async () => {
    await engine.page.setContent('<input id="native" type="checkbox"><button id="toggle" aria-checked="false" onclick="this.setAttribute(\'aria-checked\', this.getAttribute(\'aria-checked\')!==\'true\')">Toggle</button><button id="stuck" aria-checked="false">Stuck</button><button id="apply" onclick="window.bad=true">Apply</button>');
    for (const id of ['native', 'toggle']) {
      const el = (await engine.queryOne({ css: `#${id}` }))!;
      await engine.check(el); await engine.check(el);
      expect((await engine.evaluateOn(el, 'this.checked ?? (this.getAttribute("aria-checked") === "true")')).result).toBe(true);
    }
    await expect(engine.check((await engine.queryOne({ css: '#stuck' }))!)).rejects.toThrow('still unchecked');
    await expect(engine.check((await engine.queryOne({ css: '#apply' }))!)).rejects.toThrow('no readable checked state');
    expect((await engine.evaluate('window.bad === true')).result).toBe(false);
  });
  it("never drops a stale ref's accessible name to hit the first button", async () => {
    await engine.page.setContent('<button>Apply</button><button>Details</button>');
    const map = new Map([['old', { semantic: { role: 'button', name: 'Missing' } }]]);
    expect((await resolveElementWithRef(engine, { ref: 'old' }, map)).el).toBeNull();
    expect((await resolveElementWithRef(engine, { ref: 'absent' }, map)).el).toBeNull();
    const detail = (await engine.queryOne({ role: 'button', name: 'Details' }))!;
    expect(await engine.innerText(detail)).toBe('Details');
  });
  it("extension queries do not duplicate matches, exceed limits, or escape a missing scope", async () => {
    await engine.page.setContent('<main><section><button>One</button><button>Two</button></section></main><div id="shadow"></div>');
    await engine.evaluate('document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML = "<button>Three</button>"');
    await engine.page.evaluate(await readFile(new URL('../../extension/content.js', import.meta.url), 'utf8'));
    expect((await engine.evaluate('window.__kruz__.queryAll("button").count')).result).toBe(3);
    expect((await engine.evaluate('window.__kruz__.queryAll("button", {limit: 1}).count')).result).toBe(1);
    expect((await engine.evaluate('window.__kruz__.queryAll("button", {scope: "#missing"}).count')).result).toBe(0);
  });
  it("does not call hidden/disabled Apply live or miss closure messages outside the JD", async () => {
    const page = await engine.createIsolatedPage();
    try {
      await page.navigate(origin, 'domcontentloaded', 5000);
      // Navigation is already complete; exercise extraction against controlled page states.
      const bound = new Proxy(page, { get(target, key) {
        if (key === 'navigate') return async () => {};
        const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      for (const [control, banner, status, verdict] of [
        ['<button hidden>Apply</button>', '', 'broken', 'hold'],
        ['<button disabled>Apply</button>', '', 'broken', 'hold'],
        ['<button>Apply</button>', 'This job has been filled.', 'closed', 'exclude'],
        ['<button>Apply</button>', "We're sorry… the job you are trying to apply for has been filled.", 'closed', 'exclude'],
        ['<button>Sign in to apply</button>', '', 'live', 'include'],
      ]) {
        await page.evaluate(`document.body.innerHTML = ${JSON.stringify(`<h1>Software Engineer</h1>${banner}<div class="job-description">${'Build software infrastructure and backend services. '.repeat(5)}</div>${control}`)}`);
        expect(await verifyPosting(bound, origin + '/')).toMatchObject({ status, verdict });
      }
    } finally { await page.close(); }
  });
  it("dismisses Phenom's Deny/Allow cookie banner without confusing the controls with Apply", async () => {
    await engine.page.setContent('<div class="cookie-banner"><p>We use cookies</p><button onclick="this.parentNode.remove()">Deny</button><button>Allow</button></div><button onclick="window.applied = true">Apply</button>');
    expect((await ctrl.handleOverlays()).result.dismissed).toEqual(['cookie']);
    expect((await engine.evaluate('window.applied === true')).result).toBe(false);
  });
  it("waits for Oracle's delayed keyword input before searching", async () => {
    await engine.page.setContent('<footer>Oracle Careers</footer>');
    await engine.evaluate(`setTimeout(() => { document.body.innerHTML = '<input id="keyword" placeholder="Job title, skill, keyword, event"><h1>Jobs 796</h1>'; }, 700)`);
    const result = await ctrl.oracleHCMSearch('software engineer', 0);
    expect(result).toMatchObject({ ok: true, result: { keyword: 'software engineer', count: 796 } });
    expect((await engine.evaluate('document.querySelector("#keyword").value')).result).toBe('software engineer');
  });
  it("replaces prefilled search values, clears on empty fill, and verifies controlled fields", async () => {
    await engine.page.setContent('<input id="search" value="wireless mouse"><textarea id="notes">Old notes</textarea><div id="editor" contenteditable="true">Old content</div><input id="controlled" oninput="this.value=\'rejected\'">');
    for (const id of ['search', 'notes', 'editor']) {
      const el = (await engine.queryOne({ css: `#${id}` }))!;
      await engine.fill(el, 'usb c hub');
      expect((await engine.evaluateOn(el, 'this.isContentEditable ? this.textContent : this.value')).result).toBe('usb c hub');
      await engine.fill(el, '');
      expect((await engine.evaluateOn(el, 'this.isContentEditable ? this.textContent : this.value')).result).toBe('');
    }
    await expect(engine.fill((await engine.queryOne({ css: '#controlled' }))!, 'new')).rejects.toThrow('did not retain');
  });
  it("preserves the configured viewport in normal and verification tabs", async () => {
    const original = (await engine.listTabs()).find(tab => tab.isActive)!;
    await engine.setViewportSize(1280, 720);
    const normal = await engine.newTab();
    expect((await engine.evaluate('({width:innerWidth,height:innerHeight})')).result).toEqual({width:1280,height:720});
    const isolated = await engine.createIsolatedPage();
    expect((await isolated.evaluate('({width:innerWidth,height:innerHeight})')).result).toEqual({width:1280,height:720});
    await isolated.close(); await engine.closeTab(normal.id); await engine.switchTab(original.id);
  });
});
