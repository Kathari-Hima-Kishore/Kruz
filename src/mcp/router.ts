import { cvEnhancedClick, createKruzCVBridge } from "../browser/azure-cv.js";
import { captureClickState, completeClick } from '../browser/click-completion.js';
import { randomUUID } from "node:crypto";
import { KRUZ_VERSION } from "../version.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SessionManager } from "../session/manager.js";
import { BrowserController } from "../browser/controller.js";
import { SafetyLayer } from "../safety/layer.js";
import { loadConfig } from "../config.js";
import { sanitizeToolName, KNOWN_TOOLS } from "./tool-names.js";
import type { BrowserEngine } from "../browser/engine.js";

const KRUZ_START_MS = (globalThis as any).__KRUZ_START__ ?? Date.now();

export class ToolRouter {
  private readonly instanceId = randomUUID();
  private sm: SessionManager;

  private diagnostics() {
    const s = this.sm.getActive();
    return { server_instance_id: this.instanceId, process_id: process.pid, session_id: s?.id ?? null, browser_connected: s?.engine?.connected ?? false, session_creating: this.sm.isCreating };
  }
  private ctrl: BrowserController;
  private safety: SafetyLayer;

  constructor() {
    this.sm = new SessionManager();
    this.ctrl = new BrowserController(this.sm);
    this.safety = new SafetyLayer(loadConfig().safetyPolicy);
  }

  async route(name: string, args: Record<string, any>): Promise<CallToolResult> {
    // Bug 1 (2026-09-06): sanitize the incoming tool name BEFORE dispatch.
    // GPT-OSS-20B leaks `<|channel|>commentary` into tool-call names —
    // each leak dumped the entire tool list into the error transcript.
    // Strip artifacts and validate against the registered set; return a
    // short specific error if the cleaned name still isn't known.
    const sanitized = sanitizeToolName(name);
    if (!sanitized.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: false,
          error: { code: sanitized.code, message: sanitized.message, retryable: false },
          _hint: "This is a model-output parsing failure. If you are using GPT-OSS-20B (or similar) and see repeated `<|channel|>commentary` in tool names, the fix needs to live in your model-runner's tool-call extraction layer, not in Kruz.",
        }) }],
        isError: true,
      };
    }
    name = sanitized.name;

    // Navigation to heavy career portals can legitimately take 12-45s (edge CDN +
    // bot-mitigation before domcontentloaded). Give navigation tools a 55s budget so a
    // 45s goto isn't killed by the default 25s race; everything else stays under the
    // MCP SDK -32001 default (30s) to avoid false timeouts.
    const NAV_TOOLS = new Set(["session.create", "page.open", "page.goto", "page.reload", "page.iCIMSSearch", "ats.verifyPosting"]);
    const ROUTE_TIMEOUT_MS = NAV_TOOLS.has(name) ? 55000 : 25000; // BUG-1: stay under MCP SDK -32001 default (30s) to avoid false timeouts
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.handle(name, args),
        new Promise<never>((_, reject) =>
          timer = setTimeout(() => reject(new Error("ROUTE_TIMEOUT")), ROUTE_TIMEOUT_MS)
        ),
      ]);
      return { content: [{ type: "text", text: JSON.stringify({ ...result, ...this.diagnostics() }) }], isError: result.ok === false };
    } catch (err) {
      if (String(err) === "Error: ROUTE_TIMEOUT") {
        // A timeout cannot establish success or cancel an in-flight browser action.
        // Report unknown completion and require inspection before another mutation.
        return {
          content: [{ type: "text", text: JSON.stringify({
            ok: false,
            error: { code: "ACTION_TIMEOUT", retryable: false },
            ...this.diagnostics(),
            outcome: "unknown",
            message: `Action '${name}' exceeded ${ROUTE_TIMEOUT_MS}ms. Completion is unknown and work may still be running. Inspect page/session state before retrying.`,
            retry_safe: false,
            hint: "Wait 2-3 seconds, then call page_observe or session.status to check current state.",
          }) }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, ...this.diagnostics(), error: { code: (err as any)?.code ?? "INTERNAL_ERROR", message: `Unexpected error: ${err}`, retryable: false } }) }], isError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handle(name: string, a: Record<string, any>): Promise<any> {
    // Normalize AI nesting mistakes — copy top-level keys only, avoid mutating original
    if (a.target?.fallback && !a.fallback) a.fallback = a.target.fallback;
    if (a.target?.scope && !a.scope) a.scope = a.target.scope;

    switch (name) {
      // Server
      case "server.info": return this.serverInfo();

      // Session
      case "session.create": return this.mkSession(a);
      case "session.status": return this.status();
      case "session.pause": { const s = this.sm.getActive(); if (!s) return this.noSess(); await this.sm.pause(); if (s.engine) await s.engine.bringToFront().catch(() => {}); return { ok: true, status: "paused", message: a.message || "Automation paused.", session_id: s.id }; }
      case "session.resume": { const r = await this.sm.resume(); return r ? { ok: true, status: "active" } : { ok: false, error: { code: "RESUME_FAILED", message: "Failed to resume", retryable: false } }; }
      case "session.close": { const c = await this.sm.close(undefined, a.graceful !== false); return { ok: c, status: c ? "closed" : "error" }; }
      case "session.attach": return this.ctrl.attachBrowser(a.endpoint);

      // Navigation
      case "page.open": return this.openWithRetry(a.url, a.wait_for, a.timeout_ms, 1, a.detect_redirect);
      case "page.goto": { const r = await this.openWithRetry(a.url, a.wait_for || "domcontentloaded", a.timeout_ms, 1, a.detect_redirect); if (r.ok) { const s = this.sm.getActive(); const pid = this.pid(); const url = await s?.engine?.url().catch(() => ""); if (s && url !== undefined) this.sm.trace(s.id, "goto", url ?? "", pid); } return r; }
      case "page.back": return this.ctrl.back();
      case "page.forward": return this.ctrl.forward();
      case "page.reload": return this.ctrl.reload(a.wait_for);

      // Multi-tab (parallel boards / keep-JD-open while verifying)
      case "page.newTab": return this.ctrl.newTab(a.url);
      case "page.switchTab": return this.ctrl.switchTab(a.page_id);
      case "page.listTabs": return this.ctrl.listTabs();
      case "page.closeTab": return this.ctrl.closeTab(a.page_id);

      // Observe & Find
      case "page.observe": return this.obs(a);
      case "page.find": return this.find(a);

      // Click - semantic target click (preferred) + coordinate fallback
      case "page.click": return this.click(a);
      case "azureCV.clickText": return this.click({ target: { text: a.text }, ocr: true, timeout_ms: a.timeout_ms });
      case "page.clickAt": return this.ctrl.clickAt(a.x, a.y, a.button);

      // Computer-use (text-only CUA bridge — see src/browser/computer-use.ts)
      case "page.computerUseList": return this.ctrl.computerUseList();
      case "page.computerUseSnapshot": return this.ctrl.computerUseSnapshot();
      case "page.computerUseMark": return this.ctrl.computerUseMark();
      case "page.computerUseClearMarks": return this.ctrl.computerUseClearMarks();
      case "page.computerUseScrollTo": return this.ctrl.computerUseScrollTo(a.i);

      // Keyboard
      case "page.type": return this.ctrl.type(a.target, a.text, a.fallback, a.scope, a.delay_ms, a.clear, a.timeout_ms);
      case "page.fill": return this.ctrl.fill(a.target, a.value, a.fallback, a.scope, a.timeout_ms, { force: a.force, ignoreVisibility: a.ignore_visibility });
      case "page.press": return this.ctrl.press(a.key, a.target, a.fallback, a.scope, a.timeout_ms);
      case "page.pressSequence": return this.ctrl.pressSequence(a.keys, a.delay_ms);

      // Form
      case "page.select": return this.ctrl.select(a.target, { value: a.value, label: a.label, index: a.index }, a.fallback, a.scope, a.timeout_ms);
      case "page.check": return this.ctrl.check(a.target, a.fallback, a.scope, a.timeout_ms);
      case "page.uncheck": return this.ctrl.uncheck(a.target, a.fallback, a.scope, a.timeout_ms);
      case "page.submit": return this.ctrl.submit(a.target, a.fallback, a.scope);
      case "page.setSlider": return this.ctrl.setSliderValue(a.target, a.value, a.fallback, a.scope, a.timeout_ms);
      case "page.stepper": return this.ctrl.stepper(a.target, a.direction, a.fallback, a.scope, a.timeout_ms);

      // Scroll
      case "page.scroll": return this.ctrl.scroll(a.direction, a.amount, a.target, a.fallback);
      case "page.scrollToBottom": return this.ctrl.scrollToBottom(a.sentinel_selector, a.max_scrolls, a.wait_ms);
      case "page.paginate": return this.ctrl.paginate({ max_pages: a.max_pages, wait_ms: a.wait_ms, load_more_selector: a.load_more_selector, next_selector: a.next_selector, infinite_scroll: a.infinite_scroll });
      case "page.scrollAll": return this.ctrl.scrollAll({ max_steps: a.max_steps, step_px: a.step_px, wait_ms: a.wait_ms, sentinel_selector: a.sentinel_selector });
      case "page.handleOverlays": return this.ctrl.handleOverlays({ close_cookie_banner: a.close_cookie_banner, close_newsletter_popup: a.close_newsletter_popup, close_chat_widget: a.close_chat_widget, close_app_prompt: a.close_app_prompt, handle_js_alerts: a.handle_js_alerts });
      case "page.setDialogPolicy": return this.ctrl.setDialogPolicy(a.action, a.value);

      // Hover & Wait
      case "page.hover": return this.ctrl.hover(a.target, a.fallback, a.scope, a.timeout_ms, a.dwell_ms);
      case "page.wait": return this.ctrl.wait(a.condition, a.target, a.fallback, a.scope, a.timeout_ms, a.predicate, a.interval_ms);

      // Drag
      case "page.drag": {
        let s: any, d: any;
        try { s = typeof a.source === "string" ? JSON.parse(a.source) : a.source; d = typeof a.dest === "string" ? JSON.parse(a.dest) : a.dest; } catch { return { ok: false, error: { code: "INVALID_INPUT", message: "Invalid JSON in source/dest. Pass an object like {\"ref\": \"e1\"} or valid JSON string.", retryable: false } }; }
        return this.ctrl.drag(s, d, a.source_fallback, a.dest_fallback, a.scope, a.timeout_ms);
      }
      // Dialogs
      case "page.dialog": return this.ctrl.dialog(a.action, a.value);

      // JS
      case "page.evaluate": return this.ctrl.evaluate(a.expression);
      case "page.readVariable": return this.ctrl.readVariable(a.name);

      // Frame-scoped tools
      case "page.frameEvaluate": return this.ctrl.frameEvaluate(a.expression, a.frame_name, a.frame_url);
      case "page.frameObserve": return this.ctrl.frameObserve(a.frame_name, a.frame_url, a.detail);

      // Pickers & Upload
      case "page.uploadFile": return this.ctrl.uploadFile(a.target, a.file_paths, a.fallback, a.scope, a.timeout_ms);
      case "page.setDate": return this.ctrl.setDate(a.target, a.date, a.fallback, a.scope, a.timeout_ms);
      case "page.setColor": return this.ctrl.setColor(a.target, a.color, a.fallback, a.scope, a.timeout_ms);

      // Screenshot
      case "page.screenshot": return this.ctrl.screenshot(a.target, a.fallback, a.scope, a.path, a.full_page);

      // ATS JSON harvesters (v11 medium-product — direct API feeds)
      case "ats.greenhouseHarvest": return this.ctrl.atsGreenhouseHarvest(a.company, a.query);
      case "ats.leverHarvest": return this.ctrl.atsLeverHarvest(a.company);
      case "ats.ashbyHarvest": return this.ctrl.atsAshbyHarvest(a.company);
      case "ats.smartRecruitersHarvest": return this.ctrl.atsSmartRecruitersHarvest(a.company);
      case "ats.workdayHarvest": return this.ctrl.atsWorkdayHarvest(a.tenant, a.site, a.query);
      case "ats.bulkHarvest": return this.ctrl.atsBulkHarvest(a.companies);
      case "ats.discoverHandle": return this.ctrl.atsDiscoverHandle(a.ats, a.company);
      // ATS-specific helpers (tailored to job-finder-v9 / v11 medium-product)
      case "ats.detect": return this.ctrl.detectATS();
      case "ats.enumerate": return this.ctrl.atsEnumerate(a.ats, a.portal_url, a.company);
      case "ats.verifyPosting": return this.ctrl.atsVerifyPosting(a.url);
      case "ats.summarize": return this.ctrl.atsSummarize();
      case "ats.paginate": return this.ctrl.atsPaginate({ max_scrolls: a.max_scrolls, wait_ms: a.wait_ms, load_more_selector: a.load_more_selector, next_selector: a.next_selector });
      case "network.body": { const b = this.ctrl.getNetworkBody(a.filter || ""); return b ? { ok: true, result: b } : { ok: false, error: { code: "NO_MATCH", message: `No network request matched filter '${a.filter}'. Navigate/reload so the ATS feed is captured, then retry.`, retryable: true } }; }
      case "network.capture" : this.ctrl.setCaptureBodies(a.on !== false); return { ok: true, capturing_bodies: this.ctrl.getCaptureBodies() };
      case "page.oracleHCMSearch": return this.ctrl.oracleHCMSearch(a.keyword, a.wait_ms);
      case "page.iCIMSSearch": return this.ctrl.iCIMSSearch(a.keyword, a.country_path, a.wait_ms);
      case "page.extractExperience": return this.ctrl.extractExperience(a.title, a.body_text);
      case "page.detectATS": return this.ctrl.detectATS();

      // Extract
      case "extract.text": return this.extText(a);
      case "extract.target": return this.extTarget(a);

      // Safety
      case "human.takeover": { const s = this.sm.getActive(); if (!s) return this.noSess(); await this.sm.pause(); if (s.engine) await s.engine.bringToFront().catch(() => {}); return { ok: true, status: "needs_human", message: a.message || "Human intervention required.", session_id: s.id, hint: "Call session.resume when done." }; }
      case "action.confirm": return this.confirm(a);

      default: return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}`, retryable: false } };
    }
  }

  // ── Handlers ───────────────────────────────────────────────────────────

  private async mkSession(a: Record<string, any>) {
    if (a.headless === true) return { ok: false, error: { code: "HEADED_REQUIRED", message: "Kruz sessions require a visible browser. Use headless:false.", retryable: false } };
    const reused = this.sm.isCreating || !!this.sm.getActive()?.engine?.connected;
    if (!reused) this.ctrl.clearCapture();
    const s = await this.sm.create({ headless: a.headless, profileDir: a.profile_dir, viewportWidth: a.viewport_width, viewportHeight: a.viewport_height, userAgent: a.user_agent, locale: a.locale, proxy: a.proxy, downloadDir: a.download_dir, startupUrl: a.startup_url });
    if (!reused && s.engine && (a.viewport_width || a.viewport_height)) {
      const w = a.viewport_width || s.config.viewportWidth;
      const h = a.viewport_height || s.config.viewportHeight;
      await s.engine.setViewportSize(w, h).catch(() => {});
      const actual = await s.engine.viewportSize().catch(() => null);
      const actualW = actual?.width ?? w;
      const actualH = actual?.height ?? h;
      if (actualW !== w || actualH !== h) {
        process.stderr.write(`[kruz] K8: Viewport requested ${w}x${h} but Chrome returned ${actualW}x${actualH}. This is normal on headed Windows (title bar offset).\n`);
      }
      s.config = { ...s.config, viewportWidth: actualW, viewportHeight: actualH };
    }
    const url = await s.engine?.url().catch(() => "about:blank") ?? "about:blank";
    return { ok: true, reused, ...(reused ? { message: "Reused the existing session; launch options and startup_url were not applied. Use page.open to navigate, or session.close before changing launch settings." } : {}), session_id: s.id, status: s.status, browser: { headless: s.config.headless, viewport: { width: s.config.viewportWidth, height: s.config.viewportHeight } }, page_id: "p1", url };
  }

  private async status() {
    const s = this.sm.getActive();
    if (!s) return this.noSess();
    const bc = this.ctrl.isBrowserConnected();
    const tabs = s.engine ? await s.engine.listTabs().catch(() => [] as any[]) : [];
    const activePageUrl = s.engine ? await s.engine.url().catch(() => "about:blank") : "about:blank";
    return { ok: true, session_id: s.id, status: bc ? s.status : "crashed", created_at: s.createdAt, browser_connected: bc, active_page: activePageUrl, pages: tabs.length, navigation_trace: this.sm.getTrace(s.id).slice(-10) };
  }

  private async obs(a: Record<string, any>) {
    const s = this.sm.getActive();
    if (!s?.engine) return this.noSess();
    const ts = new Date().toISOString();
    const { observation, isDelta } = await s.observer.observe(s.engine, a.scope, a.detail || "minimal");
    return { ok: true, ...observation, is_delta: isDelta, captured_at: ts };
  }

  private async find(a: Record<string, any>) {
    const s = this.sm.getActive();
    const engine = s?.engine;
    if (!engine) return this.noSess();
    const t = a.target || {};

    const candidates: { strategy: string; target: any }[] = [];

    if (t.css) candidates.push({ strategy: "css", target: { css: t.css } });
    if (t.id) candidates.push({ strategy: "id", target: { id: t.id } });
    if (t.testid) candidates.push({ strategy: "testid", target: { testid: t.testid } });
    if (t.nameAttr) candidates.push({ strategy: "nameAttr", target: { nameAttr: t.nameAttr } });
    if (t.name) candidates.push({ strategy: "role+name", target: { role: t.role || "button", name: t.name } });
    if (t.label) candidates.push({ strategy: "label", target: { label: t.label } });
    if (t.text) candidates.push({ strategy: "text", target: { text: t.text } });
    if (a.fallback?.css) candidates.push({ strategy: "fallback.css", target: { css: a.fallback.css } });
    if (a.fallback?.text) candidates.push({ strategy: "fallback.text", target: { text: a.fallback.text } });
    if (a.fallback?.xpath) candidates.push({ strategy: "fallback.xpath", target: { css: `xpath=${a.fallback.xpath}` } });

    for (const c of candidates.slice(0, 8)) {
      try {
        const el = await engine.queryOne(c.target, undefined, a.scope).catch(() => null);
        if (el) {
          const count = 1;
          const rawText = (await engine.textContent(el).catch(() => ""))?.trim() ?? "";
          const capped = rawText.length > 500 ? rawText.substring(0, 500) + "..." : rawText;
          const visible = await engine.isVisible(el).catch(() => false);
          const tag = await engine.tagName(el).catch(() => "unknown");
          return { ok: true, found: true, count, strategy: c.strategy, visible, text: capped, tag };
        }
      } catch { /* next */ }
    }
    return { ok: false, error: { code: "ELEMENT_NOT_FOUND", message: `No element found matching ${JSON.stringify(t)}`, retryable: true } };
  }

  private async click(a: Record<string, any>) {
    // Issue 5: Validate target parameter — provide helpful error when missing
    if (!a.target || (typeof a.target === "object" && Object.keys(a.target).length === 0)) {
      return {
        ok: false,
        error: {
          code: "INVALID_TARGET",
          message: "Missing or empty 'target' parameter. You must wrap the ref in a target object: {\"target\": {\"ref\": \"e...\"}}. Other valid fields: css, role, name, text, testid, id.",
          retryable: false,
        },
      };
    }
    const engine = this.sm.getActiveEngine();
    if (!engine) return this.noSess();
    const before = await captureClickState(engine);
    const finish = async (response: any) => {
      if (!response.ok || response.result?.dialog_pending) return response;
      try {
        const completion = await completeClick(engine, before, a);
        return { ...response, result: { ...response.result, ...completion } };
      } catch (error) {
        return { ...response, result: { ...response.result, clicked:true, verified:false, completion_error:String(error), retry_safe:false } };
      }
    };
    if (a.ocr === true) {
      const engine = this.sm.getActiveEngine();
      if (!engine) return this.noSess();
      if (!a.target.text || a.scope || a.button && a.button !== "left" || a.click_count && a.click_count !== 1) return { ok: false, error: { code: "INVALID_OCR_OPTIONS", message: "OCR requires target.text, no scope, and a single left click.", retryable: false } };
      try { return await finish(await cvEnhancedClick(createKruzCVBridge(engine), a.target.text, { timeout: Math.min(a.timeout_ms ?? 5000, 10000) })); }
      catch (error) { return { ok: false, error: { code: "OCR_CLICK_FAILED", message: String(error), retryable: false }, retry_safe: false }; }
    }
    const sd = this.safety.classify("click", a.target);
    // NOTE: Safety confirmation gating removed so the browser agent is fully
    // autonomous (e.g. accepting cookie-consent banners). If any restrictive
    // severity is (re)introduced, it is surfaced here for logging only and the
    // click is NOT blocked.
    if (sd.severity === "human") {
      process.stderr.write(`[kruz] safety(off): ${sd.reason} — proceeding automatically.\n`);
    }
    if (sd.severity === "confirm") {
      process.stderr.write(`[kruz] safety(off): ${sd.reason} — proceeding automatically.\n`);
    }

    // Preserve the site's click semantics, including preventDefault and SPA menus.
    // Never infer a second navigation from an unchanged URL after a click.
    const dispatch = () => this.ctrl.click(a.target, a.fallback, a.scope, a.timeout_ms, a.strict, a.button, a.click_count, { force: a.force, ignoreVisibility: a.ignore_visibility });
    let response = await dispatch();
    let overlays: unknown;
    // This engine error is issued before input dispatch. Only that case can
    // safely dismiss an overlay and retry the original action once.
    if (!response.ok && response.error?.message.includes('ELEMENT_OBSCURED') && a.dismiss_overlays !== false) {
      const handled = await this.ctrl.handleOverlays({handle_js_alerts:false});
      overlays = handled;
      if ((handled.result as any)?.dismissed?.length) response = await dispatch();
    }
    if (!response.ok && a.ocr_fallback === true && a.target.text && !a.scope && (!a.button || a.button==='left') && (!a.click_count || a.click_count===1) && response.error?.code==='TARGET_NOT_FOUND') {
      try { return await finish({...await cvEnhancedClick(createKruzCVBridge(engine), a.target.text, {timeout:Math.min(a.timeout_ms??5000,10000)}), method:'azure-ocr-fallback'}); }
      catch(error){return {ok:false,error:{code:'OCR_CLICK_FAILED',message:String(error),retryable:false},retry_safe:false};}
    }
    return finish({...response, ...(overlays ? {overlay_handling:overlays} : {})});
  }

  private async frames() {
    const s = this.sm.getActive();
    if (!s?.engine) return this.noSess();
    const fr = await s.engine.frames();
    return { ok: true, frames: fr.map((f, i) => ({ index: i, name: f.name, url: f.url, isMain: f.isMain })) };
  }

  private async extText(a: Record<string, any>) {
    const s = this.sm.getActive();
    if (!s?.engine) return this.noSess();
    await this.waitForContent(s.engine);
    return s.extractor.extractText(s.engine, a.target, a.fallback, a.scope, this.pid(), "tab1");
  }

  private async waitForContent(e: BrowserEngine, maxMs = 5000): Promise<void> {
    const hasRes = await e.evaluate(`document.body?.innerText?.trim().length ?? 0`).catch(() => ({ ok: false as const }));
    const has = (hasRes.ok ? hasRes.result : 0) as number;
    if (has > 10) return;
    const step = 500;
    for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
      await e.waitMs(step).catch(() => {});
      const lenRes = await e.evaluate(`document.body?.innerText?.trim().length ?? 0`).catch(() => ({ ok: false as const }));
      const len = (lenRes.ok ? lenRes.result : 0) as number;
      if (len > 10) return;
    }
  }
  private extTable(a: Record<string, any>) { const s = this.sm.getActive(); if (!s?.engine) return this.noSess(); return s.extractor.extractTable(s.engine, a.target, a.fallback, a.scope, this.pid(), "tab1"); }
  private extLinks(a: Record<string, any>) { const s = this.sm.getActive(); if (!s?.engine) return this.noSess(); return s.extractor.extractLinks(s.engine, a.scope, a.filter, this.pid(), "tab1"); }
  private extForm(a: Record<string, any>) { const s = this.sm.getActive(); if (!s?.engine) return this.noSess(); return s.extractor.extractForm(s.engine, a.target, a.fallback, a.scope, this.pid(), "tab1", s.observer.getRefMap()); }
  private extTarget(a: Record<string, any>) { const s = this.sm.getActive(); if (!s?.engine) return this.noSess(); return s.extractor.extractTarget(s.engine, a.target, a.fallback, a.scope, a.verify ?? false, this.pid(), "tab1"); }

  private async confirm(a: Record<string, any>) {
    if (a.confirmed === true) {
      let r: any;
      switch (a.action || "click") {
        case "click": r = await this.ctrl.click(a.target || {}); break;
        case "fill": r = await this.ctrl.fill(a.target || {}, a.value || ""); break;
        case "submit": r = await this.ctrl.submit(a.target); break;
        default: r = { ok: true };
      }
      return { ...r, status: "executed", action: a.action, message: `Confirmed action '${a.action}' executed.` };
    }
    return { ok: true, status: "needs_confirmation", action: a.action, target: a.target, website: a.website, reversible: a.reversible ?? true, message: `Confirmation requested for: ${a.action}.`, hint: "Re-call with confirmed=true to proceed." };
  }

  // Issue 1 & 7: Auto-retry with new session on browser crash
  private async openWithRetry(url: string, waitFor?: string, timeoutMs?: number, retries = 1, detectRedirect?: boolean): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      // K1: networkidle NEVER resolves on SPAs with WebSockets (Oracle HCM, etc.)
      // Convert to domcontentloaded which always completes. The internal fallback
      // in ctrl.open() will handle the rest.
      const effectiveWait = (waitFor === "networkidle") ? "domcontentloaded" : (waitFor as any);
      const result = await this.ctrl.open(url, effectiveWait, timeoutMs);
      if (result.ok) {
        // Deep-link redirect detection (Accenture-style: jobdetails → search page)
        if (detectRedirect && url.includes("jobdetails")) {
          const eng = this.sm.getActive()?.engine;
          const currentUrl = eng ? await eng.url().catch(() => "") : "";
          if (currentUrl !== url && !currentUrl.includes("jobdetails")) {
            process.stderr.write(`[kruz] Deep-link redirect detected: ${url} → ${currentUrl}. Job may require search-then-click navigation.\n`);
            return {
              ok: true,
              result: {
                redirected: true,
                originalUrl: url,
                currentUrl,
                hint: "Job detail URL redirected to search/listing page. Navigate to search page first, then click into job.",
              },
            };
          }
        }
        return result;
      }

      // Check if browser crashed — auto-create new session and retry
      if (result.error?.code === "BROWSER_CRASHED" && attempt < retries) {
        process.stderr.write(`[kruz] Browser crashed during page.open, auto-recreating session (attempt ${attempt + 1}/${retries})\n`);
        try { await this.sm.close(undefined, false); } catch { /* ignore */ }
        try { await this.sm.create(); } catch { /* ignore */ }
        continue;
      }

      return result;
    }
    return { ok: false, error: { code: "RETRY_EXHAUSTED", message: "All retry attempts exhausted", retryable: false } };
  }

  private pid(): string {
    const s = this.sm.getActive();
    return s?.engine ? "p1" : "p1";
  }
  private noSess() { return { ok: false, error: { code: "NO_SESSION", message: "No active session in this MCP server instance. Compare server_instance_id with previous responses; call session.create here to start a session.", retryable: true } }; }
  getSessionManager() { return this.sm; }

  // ── Server diagnostics (no session required) ───────────────────────────

  private async serverInfo() {
    const s = this.sm.getActive();
    const config = s?.config ?? loadConfig();
    const activePage = s?.engine ? await s.engine.url().catch(() => "about:blank") : "about:blank";
    const pages = s?.engine ? (await s.engine.listTabs().catch(() => [])).length : 0;
    return {
      ok: true,
      server: { name: "kruz", version: KRUZ_VERSION, uptime: Math.round((Date.now() - KRUZ_START_MS) / 1000) },
      session: s ? { status: s.status, session_id: s.id, browser_connected: this.ctrl.isBrowserConnected(), active_page: activePage, pages } : null,
      config: { engine: s?.engine?.kind ?? null, extension_configured: !!config.extensionPath, extension_ready: s?.engine ? (await s.engine.evaluate("!!window.__kruz_extension_ready__").catch(() => ({ result: false }))).result === true : false, headless: config.headless, viewport: { width: config.viewportWidth, height: config.viewportHeight }, safety_policy: config.safetyPolicy, locale: config.locale },
      tools_count: KNOWN_TOOLS.size,
      message: "Kruz MCP server is connected and operational.",
    };
  }
}
