import { captureClickState, completeClick } from '../browser/click-completion.js';
import { randomUUID } from "node:crypto";
import { KRUZ_VERSION, buildInfo } from "../version.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SessionManager } from "../session/manager.js";
import { BrowserController } from "../browser/controller.js";
import { SafetyLayer } from "../safety/layer.js";
import { loadConfig } from "../config.js";
import { sanitizeToolName, KNOWN_TOOLS } from "./tool-names.js";
import type { BrowserEngine } from "../browser/engine.js";
import { toErrorEnvelope, kruzError, kruzErrorFromThrown, ErrCode, classify, isRetryableCode, isRefusalCode, KruzError, withRetry, type KruzErrorEnvelope } from "../errors.js";

/**
 * Error codes the click recovery ladder retries. ELEMENT_NOT_VISIBLE is included so a
 * hidden first match can resolve to its visible twin after re-observe (D4, matching
 * the type/fill ladders in controller.ts).
 * P1-D / §28: TARGET_NOT_FOUND is deliberately NOT retried — a genuinely missing target
 * must return quickly so the model can reconsider the plan instead of waiting through a
 * recovery ladder that cannot possibly succeed.
 */
export const CLICK_RETRY_CODES = [
  ErrCode.ELEMENT_OBSCURED,
  ErrCode.STALE_ELEMENT,
  ErrCode.ELEMENT_NOT_FOUND,
  ErrCode.ELEMENT_NOT_VISIBLE,
];

/**
 * Session-lifecycle tools that own the indicator themselves and skip the
 * per-action lock (create installs it hidden, close removes it, pause/resume
 * drive the takeover handoff explicitly).
 */
const NO_LOCK_TOOLS = new Set([
  "server.info", "session.status", "session.create", "session.close",
  "session.pause", "session.resume", "human.takeover",
]);

const KRUZ_START_MS = (globalThis as any).__KRUZ_START__ ?? Date.now();

/**
 * Single choke point for error shaping. Every tool result passes through here so
 * each error reaches the model with a stable code, the subsystem that produced
 * it, a retry verdict, and the provenance chain. Subsystems that predate the
 * unified error module (or that build bare `{code,message,retryable}` literals)
 * are enriched here rather than at each call site.
 */
function shapeError(error: unknown, tool: string): KruzErrorEnvelope {
  // Already typed by the unified module.
  if (error instanceof KruzError) return error.at(`tool:${tool}`).at("router").toJSON();

  // A plain error literal: `{code, message, retryable, subsystem?, help?, trace?}`.
  if (error && typeof error === "object" && "code" in (error as any)) {
    const e = error as Record<string, any>;
    const code = String(e.code ?? ErrCode.INTERNAL_ERROR);
    return {
      code,
      message: String(e.message ?? code),
      retryable: e.retryable ?? isRetryableCode(code),
      // Preserved when present, else derived from the code, so a plain error
      // literal cannot silently disagree with the refusal/failure decision.
      outcome: e.outcome ?? (isRefusalCode(code) ? "refusal" : "failure"),
      subsystem: e.subsystem ?? classify(code),
      ...(e.help ? { help: e.help } : {}),
      trace: [`tool:${tool}`, "router", ...(Array.isArray(e.trace) ? e.trace : [])],
    };
  }

  // A thrown Error/string that escaped a subsystem — classify it.
  const env = toErrorEnvelope(error);
  return { ...env, subsystem: env.subsystem ?? "router", trace: [`tool:${tool}`, "router", ...(env.trace ?? [])] };
}

/** Tag an ok:false result with provenance. Mutates in place (results are per-call). */
function shapeResult(result: any, tool: string): any {
  if (result && result.ok === false && result.error) {
    result.error = shapeError(result.error, tool);
  }
  return result;
}

/**
 * Hoist the error contract to the TOP level of a failed response.
 *
 * The envelope lives under `error`, which is the documented shape and what the
 * examples show. But two rounds of bug reports read `r.code` / `r.page_id` at the
 * top level, concluded the field was missing, and filed it as a defect — twice on
 * fields that were present and correct one level down. A contract that is easy to
 * misread is a contract that will keep generating false bug reports, so the four
 * documented failure fields are now also readable directly off the response.
 *
 * Additive only: `error` is untouched, and nothing is overwritten if the tool
 * already put a same-named key at the top level.
 */
function hoistEnvelope(result: any): Record<string, unknown> {
  if (!result || result.ok !== false || !result.error) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["code", "message", "retryable", "outcome", "subsystem", "help"]) {
    if (result.error[k] !== undefined && result[k] === undefined) out[k] = result.error[k];
  }
  return out;
}

/**
 * Copy named keys out of a nested `result` onto the response, without
 * overwriting a key the tool already set at the top level.
 */
function hoistResult(result: any, keys: string[]): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of keys) if (result[k] !== undefined) out[k] = result[k];
  return out;
}

/**
 * Should this result set MCP `isError`?
 *
 * Only a FAILURE should. An `isError: true` result is raised as a thrown
 * exception by most MCP clients, which flattens the envelope into
 * `Error.message` — so the documented `if (!r.ok)` branch is unreachable, and
 * any actionable payload (AMBIGUOUS_TARGET `candidates`, overlay `region`) has
 * to be re-parsed out of a string. It also made delivery depend on the client
 * and on which call it was: the same refusal resolved once and threw on every
 * repeat, so code validated against the first call failed in production.
 *
 * A REFUSAL resolved correctly the whole time; it is Kruz answering "not
 * safely" with a complete, typed payload. So refusals resolve as values with
 * `ok: false`, and only true failures — no session, crash, timeout, unhandled
 * exception — set `isError`.
 *
 * An `ok:false` with NO envelope is treated as a failure: it carries no
 * actionable payload, so there is nothing for a caller to inspect.
 */
function isFailure(result: any): boolean {
  if (!result || result.ok !== false) return false;
  if (result.error?.outcome === "refusal") return false;
  if (typeof result.error?.code === "string" && isRefusalCode(result.error.code)) return false;
  return true;
}

export class ToolRouter {
  private readonly instanceId = randomUUID();
  private sm: SessionManager;
  /** Cached canonical tab id, refreshed wherever the active tab can change. */
  private pageIdCache: string | null = null;

  private diagnostics() {
    const s = this.sm.getActive();
    // page_id is served from a cache rather than a fresh listTabs() round-trip,
    // because diagnostics() rides on EVERY tool response and a CDP call per tool
    // is not worth one convenience field. It is refreshed wherever the active tab
    // can change under us (session create, navigate, tab ops).
    return {
      server_instance_id: this.instanceId,
      process_id: process.pid,
      session_id: s?.id ?? null,
      browser_connected: s?.engine?.connected ?? false,
      session_creating: this.sm.isCreating,
      ...(s?.engine ? { page_id: this.pageIdCache } : {}),
    };
  }

  /**
   * Model control, one rule: WHILE the blue overlay is alive the page belongs to
   * the model and accepts no outside input; when the model goes idle the overlay
   * (and the input lock) disappear and the page is the user's again.
   *
   * This is REALTIME and heartbeat-driven: `beginControl` starts a ~200 ms ping
   * loop that runs for as long as the tool call is in flight; the in-page layer
   * (visual-cursor.ts) keeps the overlay visible only while pings arrive within
   * its own IDLE window. The moment the call ends — i.e. the model is back to
   * thinking/deciding, not acting — pings stop and the overlay turns itself off,
   * even if this Node process is killed mid-call. No paired on/off state, no
   * reliance on a server timer for the off transition.
   */
  private idleReleaseTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setTimeout>;

  /**
   * Stop the heartbeat. That is ALL this does now.
   *
   * It used to also schedule a delayed `setControlLock(false)` "to force the overlay
   * down", duplicating the page-side watchdog (which already hides the overlay
   * `IDLE_MS` after the last ping). The duplicate was not harmless:
   *
   *  - It raced. If that timer had already fired and its `setLock(false)` evaluate was
   *    still in flight when the NEXT call began, `beginControl()` could not cancel it
   *    (`clearTimeout` cannot cancel a running callback). `setLock(false)` sets
   *    `lastPing = 0`, so the overlay went dark *during* an in-flight call and stayed
   *    dark until the next heartbeat tick — a call executing with no indicator. That
   *    is the "the overlay doesn't always show up" symptom.
   *  - It cost a CDP round-trip after every single tool call, to re-assert something
   *    the page already knew.
   *
   * The watchdog is the single source of truth for state; the heartbeat is the
   * single source of truth for intent. Ending a call deliberately does NOT push
   * an explicit state — letting the ping lapse is what moves the banner to
   * "thinking", which is the honest description of a model between actions.
   * The explicit paths are `session.pause` / `human.takeover` (awaiting) and
   * `session.resume` (thinking), which go through `setControlMode`.
   */
  private endControl(_graceMs = 600): void {
    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = undefined; }
    if (this.idleReleaseTimer) { clearTimeout(this.idleReleaseTimer); this.idleReleaseTimer = undefined; }
  }

  /** Heartbeat ON for the duration of a call; overlay visible while it beats. */
  private async beginControl(): Promise<void> {
    if (this.idleReleaseTimer) { clearTimeout(this.idleReleaseTimer); this.idleReleaseTimer = undefined; }
    await this.setControlPing();
    this.schedulePing();
  }

  /**
   * Ping the in-page layer so its realtime IDLE window stays open. Uses a
   * self-rescheduling timeout (not setInterval) so a slow renderer cannot pile
   * up concurrent evaluates, and `unref()` so it never holds the process open.
   */
  private schedulePing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(async () => {
      this.pingTimer = undefined;
      // A call is still in flight only if endControl has not run; it clears
      // pingTimer, so reaching here means control is ongoing.
      await this.setControlPing();
      if (!this.idleReleaseTimer) this.schedulePing();
    }, 200);
    (this.pingTimer as any)?.unref?.();
  }

  /** Realtime heartbeat: extends the overlay's visibility window. */
  private async setControlPing(): Promise<void> {
    try {
      const engine = this.sm.getActiveEngine();
      if (!engine) return;
      await engine.evaluate(`(() => { try { const v = window.__kruzVisual; if (v && v.ping) return v.ping(); return "no-layer"; } catch (e) { return "error"; } })()`).catch(() => null);
    } catch { /* best-effort; never fail an action on the indicator */ }
  }

  /** Toggle the in-page control layer. Best-effort: never fails an action. */
  private async setControlLock(on: boolean): Promise<void> {
    try {
      const engine = this.sm.getActiveEngine();
      if (!engine) return;
      await engine.evaluate(`(() => { try { const v = window.__kruzVisual; if (v && v.setLock) return v.setLock(${on ? "true" : "false"}); return "no-layer"; } catch (e) { return "error"; } })()`).catch(() => null);
    } catch { /* best-effort; never fail an action on the indicator */ }
  }

  /**
   * Drive the banner to an explicit state. Used where the state is KNOWN rather
   * than inferred from the heartbeat: a pause/takeover is a declaration that a
   * human is needed, and a resume is a declaration that the model has the page
   * again but is not mid-action.
   *
   * awaiting is deliberately sticky (it only clears on the next ping), while
   * thinking is a floor the watchdog will keep raising/lowering on activity.
   */
  private async setControlMode(next: "controlling" | "thinking" | "awaiting"): Promise<void> {
    try {
      const engine = this.sm.getActiveEngine();
      if (!engine) return;
      await engine.evaluate(`(() => { try { const v = window.__kruzVisual; if (v && v.setMode) return v.setMode(${JSON.stringify(next)}); return "no-layer"; } catch (e) { return "error"; } })()`).catch(() => null);
    } catch { /* best-effort; never fail an action on the indicator */ }
  }

  private ctrl: BrowserController;
  private safety: SafetyLayer;

  constructor() {
    this.sm = new SessionManager();
    this.ctrl = new BrowserController(this.sm);
    this.safety = new SafetyLayer(loadConfig().safetyPolicy);
  }

  /** Pre-action state shape reused to avoid an extra CDP round trip (P1-A). */
  private stateOf(v: any): { url: string; title: string; document_id?: number; signature?: string; focus?: string | null } | null {
    if (!v || typeof v !== "object") return null;
    return { url: v.url ?? "", title: v.title ?? "", document_id: v.document_id, signature: v.signature, focus: v.focus ?? null };
  }

  /**
   * P1-A: wrap a mutating action so its result carries a compact post-action state
   * delta. `before` (a snapshot from the pre-action capture) is reused when supplied
   * to avoid an extra CDP round trip; observation is best-effort and never fails the
   * action itself.
   */
  private async withFeedback<T extends Record<string, any>>(
    engine: BrowserEngine | null,
    action: () => Promise<T>,
    opts: { before?: any; includeLists?: boolean } = {},
  ): Promise<T> {
    if (!engine) return action();
    const before = opts.before ?? (await this.ctrl.pageFeedback(engine, null, { includeLists: false }).catch(() => null));
    const result = await action();
    if (!result || typeof result !== "object" || result.ok !== true) return result;
    const after = await this.ctrl.pageFeedback(engine, this.stateOf(before), { includeLists: opts.includeLists }).catch(() => null);
    if (!after) return result;
    return { ...result, state: after };
  }

  /** P1-B: cheap, non-mutating existence probe over the current DOM. */
  private async probeTarget(a: Record<string, any>) {
    const engine = this.sm.getActiveEngine();
    if (!engine) return this.noSess();
    const target = a.target ?? {};
    if (!target || typeof target !== "object" || Object.keys(target).length === 0) {
      return { ok: false, error: kruzError(ErrCode.INVALID_TARGET, { subsystem: "router", message: "page.probe needs a target, e.g. {\"target\":{\"css\":\"#submit\"}} or {\"target\":{\"text\":\"Careers\"}}.", trace: ["router"] }).toJSON() };
    }
    const candidates = await this.ctrl.probeTarget(engine, target, a.fallback, a.scope);
    return { ok: true, result: candidates };
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
    // Full-page capture of a long storefront can outlast the default budget, so
    // page.screenshot gets its own ceiling rather than inheriting the 25s default.
    const CAPTURE_TOOLS = new Set(["page.screenshot"]);
    const ROUTE_TIMEOUT_MS = NAV_TOOLS.has(name) ? 55000 : CAPTURE_TOOLS.has(name) ? 55000 : 25000; // BUG-1: stay under MCP SDK -32001 default (30s) to avoid false timeouts
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Model control is tied to ACTIVITY: overlay + input lock go on for the
    // duration of the call and are released shortly after the model goes idle.
    const isLifecycle = NO_LOCK_TOOLS.has(name);
    try {
      if (!isLifecycle && this.sm.getActive()?.id) await this.beginControl();
      const result = await Promise.race([
        this.handle(name, args),
        new Promise<never>((_, reject) =>
          timer = setTimeout(() => reject(new Error("ROUTE_TIMEOUT")), ROUTE_TIMEOUT_MS)
        ),
      ]);
      return this.buildToolResult(result, name);
    } catch (err) {
      if (String(err) === "Error: ROUTE_TIMEOUT") {
        // A timeout cannot establish success or cancel an in-flight browser action.
        // Report unknown completion and require inspection before another mutation.
        // Re-read the tab id first: the hung call may well have switched tabs
        // before wedging, and stamping the response with the pre-call cache is how
        // a response ends up naming a tab the action never touched.
        await this.refreshPageId();
        return {
          content: [{ type: "text", text: JSON.stringify({
            ok: false,
            error: kruzError(ErrCode.ACTION_TIMEOUT, {
              subsystem: "router",
              // Explicitly NOT retryable. `retryable` is the taxonomy's "may the same
              // input succeed without replanning?" field, and this response answers no:
              // completion is unknown and work may still be running, so replaying risks
              // a double-submit. It previously inherited isRetryableCode()===true from
              // ACTION_TIMEOUT while the same payload set retry_safe:false — the one
              // field a caller branches on contradicted the payload beside it.
              retryable: false,
              message: `Action '${name}' exceeded ${ROUTE_TIMEOUT_MS}ms. Completion is unknown and work may still be running.`,
              trace: [`tool:${name}`, "router"],
            }).toJSON(),
            ...this.diagnostics(),
            outcome: "unknown",
            retry_safe: false,
            hint: "Wait 2-3 seconds, then call page_observe or session.status to check current state.",
          }) }],
          isError: true,
        };
      }
      const env = shapeError(err, name);
      await this.refreshPageId();
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, ...this.diagnostics(), error: env }) }], isError: true };
    } finally {
      if (timer) clearTimeout(timer);
      // The model is no longer acting on the page: stop the heartbeat so the
      // overlay turns itself off (unless the user holds control).
      if (!isLifecycle && this.sm.getActive()?.id) this.endControl();
    }
  }

  /**
   * Shape a tool result into an MCP CallToolResult.
   *
   * Every tool historically returned a single text block of JSON, so this was
   * `JSON.stringify(result)` inline. `page.screenshot` breaks that: its payload is
   * a base64 PNG, and JSON-encoding that would deliver the image as an
   * unparseable string inside prose. MCP has a first-class image content block for
   * exactly this, and clients render it as an actual image the model can look at.
   *
   * So: the base64 is hoisted OUT of the JSON and into a sibling image block. The
   * text block keeps every metadata field (mime_type, width, height, bytes, mode,
   * ref, path) so a text-only client still gets a complete, useful answer and the
   * model can correlate what it is looking at with the element it came from.
   *
   * This is what turns Kruz from a text-only tool into one that supports image
   * ANALYSIS: the model receives pixels and interprets them. It is deliberately
   * not OCR — no text is extracted here, because the caller already has
   * `extract.text` for that and gets strictly more from seeing the rendered page.
   */
  private buildToolResult(result: any, name: string): CallToolResult {
    const shaped = shapeResult(result, name);
    const meta = { ...shaped, ...this.diagnostics(), ...hoistEnvelope(shaped) };

    const payload = shaped?.result;
    const b64 = payload && typeof payload.base64 === "string" ? payload.base64 : null;
    if (b64) {
      // Strip it from the JSON view. Leaving a megabyte of base64 inline would
      // duplicate it in the transcript for no benefit.
      const { base64: _dropped, ...rest } = payload;
      meta.result = { ...rest, image_attached: true };
    }

    const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(meta) }];
    if (b64) {
      content.push({
        type: "image",
        data: b64,
        mimeType: (payload.mime_type as any) ?? "image/png",
      });
    }
    return { content, isError: isFailure(shaped) };
  }

  private async handle(name: string, a: Record<string, any>): Promise<any> {
    // Normalize AI nesting mistakes — copy top-level keys only, avoid mutating original
    if (a.target?.fallback && !a.fallback) a.fallback = a.target.fallback;
    if (a.target?.scope && !a.scope) a.scope = a.target.scope;

    // P1-A: post-action feedback is attached after mutating actions. A single snapshot
    // taken here is reused as the "before" baseline (no extra round trip) by actions
    // that don't already capture their own pre-state.
    const engine = this.sm.getActiveEngine();

    switch (name) {
      // Server
      case "server.info": return this.serverInfo();

      // Session
      case "session.create": return this.mkSession(a);
      case "session.status": return this.status();
      case "session.pause": { const s = this.sm.getActive(); if (!s) return this.noSess(); await this.sm.pause(); if (s.engine) await s.engine.bringToFront().catch(() => {}); await this.setControlMode("awaiting"); return { ok: true, status: "paused", message: a.message || "Automation paused; the page is yours until session.resume.", session_id: s.id, overlay: { mode: "awaiting", banner: "Input needed on Browser/TUI" } }; }
      case "session.resume": {
        const r = await this.sm.resume();
        const s = this.sm.getActive();
        if (!s) return { ok: false, error: kruzError(ErrCode.RESUME_FAILED, { subsystem: "session", message: "No active session to resume", trace: ["router"] }).toJSON() };
        // Idempotent: resuming an already-active session is a no-op success.
        // NOT setControlLock(false): that now means "a human is needed", which is
        // exactly the opposite of a resume. The model has the page back but is not
        // mid-action, so this is the "thinking" state until the next ping.
        await this.setControlMode("thinking");
        return { ok: true, status: "active", was_paused: r, overlay: { mode: "thinking", banner: "Model is thinking" } };
      }

      case "session.close": { const prev = this.sm.getActive(); const c = await this.sm.close(undefined, a.graceful !== false); if (c && prev?.engine) await (prev.engine as any).removeControlIndicator?.()?.catch?.(() => {}); return { ok: c, status: c ? "closed" : "error" }; }

      // Navigation
      case "page.open": return this.openWithRetry(a.url, a.wait_for ?? a.wait_until, a.timeout_ms ?? a.nav_timeout_ms, 1, a.detect_redirect);

      // Multi-tab (parallel boards / keep-JD-open while verifying)
      case "page.newTab": return this.tabOp(() => this.ctrl.newTab(a.url));
      case "page.switchTab": return this.tabOp(() => this.ctrl.switchTab(a.page_id));
      case "page.listTabs": return this.ctrl.listTabs();
      case "page.closeTab": return this.tabOp(() => this.ctrl.closeTab(a.page_id));

      // Observe
      case "page.observe": return this.obs(a);

      // Click - semantic target click (preferred) + coordinate fallback
      case "page.click": return this.click(a);
      // through withFeedback so it returns the same compact post-action `state` as
      // every other action tool. It previously returned a bare `{ok:true}` — no
      // state, no timing, and nothing confirming what the coordinate actually
      // hit — making it the only action whose effect the caller could not check.
      case "page.clickAt": return this.withFeedback(this.sm.getActiveEngine(), () => this.ctrl.clickAt(a.x, a.y, a.button));

      // Computer-use (text-only CUA bridge — see src/browser/computer-use.ts)
      case "page.computerUseList": return this.ctrl.computerUseList();
      case "page.computerUseSnapshot": return this.ctrl.computerUseSnapshot();

      // Vision — deliver actual pixels as an MCP image content block so a
      // vision-capable model can analyse the page, not just read its markup.
      case "page.screenshot": return this.ctrl.screenshot(a.target, a.fallback, a.scope, a.path, a.full_page === true, (a.type ?? "png") as "png" | "jpeg" | "webp", a.quality, a.timeout_ms);

      // Keyboard — mutating actions carry a compact post-action state delta (P1-A).
      case "page.fill": return this.withFeedback(engine, () => this.ctrl.fill(a.target, a.value, a.fallback, a.scope, a.timeout_ms, { force: a.force, ignoreVisibility: a.ignore_visibility }), { includeLists: false });
      case "page.press": return this.withFeedback(engine, () => this.ctrl.press(a.key, a.target, a.fallback, a.scope, a.timeout_ms), { includeLists: true });

      // Drag — trusted press/move/release. Reports `verified:false` with a reason
      // when nothing changed, because the alternative failure mode (a silent no-op
      // drag on a custom drag engine) looks identical to success.
      case "page.drag": return this.ctrl.drag(a.from, a.to, {
        steps: a.steps, button: a.button, speed: a.speed, mode: a.mode, data: a.data,
        modifiers: a.modifiers, timeoutMs: a.timeout_ms, settleMs: a.settle_ms,
      });

      // File input — CDP DOM.setFileInputFiles (the only route a page cannot fake).
      case "page.uploadFile": return this.ctrl.uploadFile(a.target ?? a.selector ?? { css: 'input[type="file"]' }, a.path ?? a.paths ?? a.file, {
        scope: a.scope, fallback: a.fallback, timeoutMs: a.timeout_ms,
      });

      // Viewport — pin the CSS viewport so a responsive layout cannot flip under the
      // agent mid-task. Emulation only; the OS window is untouched.
      case "page.setViewport": {
        const r = await this.ctrl.setViewport(a.width, a.height);
        const s = this.sm.getActive();
        // Keep the session's pinned size in step, or session.status would report the
        // new viewport as drift the moment it was applied.
        if (s && r.ok) {
          const actual = (r as any).result?.browser_viewport;
          s.config = { ...s.config, viewportWidth: actual?.width ?? a.width, viewportHeight: actual?.height ?? a.height };
        }
        return r;
      }

      // Probe — cheap, non-mutating "what matches now?" (P1-B)
      case "page.probe": return this.probeTarget(a);

      // Form
      case "page.select": return this.withFeedback(engine, () => this.ctrl.select(a.target, { value: a.value, label: a.label, index: a.index }, a.fallback, a.scope, a.timeout_ms), { includeLists: true });
      case "page.check": return this.withFeedback(engine, () => this.ctrl.check(a.target, a.fallback, a.scope, a.timeout_ms), { includeLists: false });
      case "page.uncheck": return this.withFeedback(engine, () => this.ctrl.uncheck(a.target, a.fallback, a.scope, a.timeout_ms), { includeLists: false });

      // Scroll
      case "page.scroll": return this.withFeedback(engine, () => this.ctrl.scroll(a.direction, a.amount, a.target, a.fallback), { includeLists: false });
      case "page.paginate": return this.withFeedback(engine, () => this.ctrl.paginate({ max_pages: a.max_pages, wait_ms: a.wait_ms, load_more_selector: a.load_more_selector, next_selector: a.next_selector, infinite_scroll: a.infinite_scroll, budget_ms: a.budget_ms }));
      case "page.handleOverlays": return this.ctrl.handleOverlays({ close_cookie_banner: a.close_cookie_banner, close_newsletter_popup: a.close_newsletter_popup, close_chat_widget: a.close_chat_widget, close_app_prompt: a.close_app_prompt, handle_js_alerts: a.handle_js_alerts, scope: a.scope, target: a.target });

      // Wait
      case "page.wait": return this.ctrl.wait(a.condition, a.target, a.fallback, a.scope, a.timeout_ms, a.predicate, a.interval_ms);

      // Dialogs
      case "page.dialog": return this.ctrl.dialog(a.action, a.value);

      // JS — P2-C: report whether the (possibly multi-step) expression mutated the page.
      case "page.evaluate": return this.withFeedback(engine, async () => {
        const res = await this.ctrl.evaluate(a.expression);
        if (res.ok && res.result !== undefined) return { ok: true, result: res.result };
        return res;
      }, { includeLists: false }).then((r: any) => r.ok ? { ...r, page_mutated: !!(r.state?.page_mutated) } : r);

      // Frame-scoped tools
      case "page.frameEvaluate": return this.ctrl.frameEvaluate(a.expression, a.frame_name, a.frame_url);
      case "page.frameObserve": return this.ctrl.frameObserve(a.frame_name, a.frame_url, a.detail);

      // ATS JSON harvesters (v11 medium-product — direct API feeds)
      case "ats.greenhouseHarvest": return this.ctrl.atsGreenhouseHarvest(a.company, a.query);
      case "ats.leverHarvest": return this.ctrl.atsLeverHarvest(a.company);
      case "ats.ashbyHarvest": return this.ctrl.atsAshbyHarvest(a.company);
      case "ats.smartRecruitersHarvest": return this.ctrl.atsSmartRecruitersHarvest(a.company);
      case "ats.workdayHarvest": return this.ctrl.atsWorkdayHarvest(a.tenant, a.site, a.query);
      case "ats.bulkHarvest": return this.ctrl.atsBulkHarvest(a.companies);
      case "ats.discoverHandle": return this.ctrl.atsDiscoverHandle(a.ats, a.company);
      case "ats.enumerate": return this.ctrl.atsEnumerate(a.ats, a.portal_url, a.company);
      case "ats.verifyPosting": return this.ctrl.atsVerifyPosting(a.url);
      case "ats.summarize": return this.ctrl.atsSummarize();
      case "ats.paginate": return this.withFeedback(engine, () => this.ctrl.atsPaginate({ max_scrolls: a.max_scrolls, wait_ms: a.wait_ms, load_more_selector: a.load_more_selector, next_selector: a.next_selector, budget_ms: a.budget_ms }));
      case "network.body": { const b = this.ctrl.getNetworkBody(a.filter || ""); return b ? { ok: true, result: b } : { ok: false, error: kruzError(ErrCode.NO_MATCH, { subsystem: "router", message: `No network request matched filter '${a.filter}'. Navigate/reload so the ATS feed is captured, then retry.`, trace: ["router"] }).toJSON() }; }
      case "network.capture" : this.ctrl.setCaptureBodies(a.on !== false); return { ok: true, capturing_bodies: this.ctrl.getCaptureBodies() };
      case "page.oracleHCMSearch": return this.ctrl.oracleHCMSearch(a.keyword, a.wait_ms);
      case "page.iCIMSSearch": return this.ctrl.iCIMSSearch(a.keyword, a.country_path, a.wait_ms);
      case "page.extractExperience": return this.ctrl.extractExperience(a.title, a.body_text);
      case "page.detectATS": return this.ctrl.detectATS();

      // Extract
      case "extract.text": return this.extText(a);

      // Safety
      case "human.takeover": { const s = this.sm.getActive(); if (!s) return this.noSess(); await this.sm.pause(); if (s.engine) await s.engine.bringToFront().catch(() => {}); await this.setControlMode("awaiting"); return { ok: true, status: "needs_human", message: a.message || "Human intervention required. The overlay is clear and the page is yours.", session_id: s.id, overlay: { mode: "awaiting", banner: "Input needed on Browser/TUI" }, hint: "Interact freely, then call session.resume to hand the browser back to the model." }; }

      default: return { ok: false, error: kruzError(ErrCode.UNKNOWN_TOOL, { subsystem: "router", message: `Unknown tool: ${name}`, trace: ["router"] }).toJSON() };
    }
  }

  // ── Handlers ───────────────────────────────────────────────────────────

  private async mkSession(a: Record<string, any>) {
    if (a.headless === true) return { ok: false, error: kruzError(ErrCode.HEADED_REQUIRED, { subsystem: "session", message: "Kruz sessions require a visible browser. Use headless:false.", trace: ["router"] }).toJSON() };

    // Attach to an ALREADY-RUNNING browser over CDP instead of launching one.
    // This is the only path that keeps the user's real Chrome reputation: Google
    // classifies a Puppeteer-LAUNCHED profile as automation and rejects sign-in with
    // "This browser or app may not be secure" even when a human types the credentials
    // by hand, because the rejection is transport-level and in-page stealth cannot
    // reach it. An attached daily-driver carries real profile history instead.
    // Start Chrome yourself with --remote-debugging-port=9222 and pass the endpoint.
    if (a.cdp_url || a.attach || a.cdp_endpoint) {
      const endpoint = String(a.cdp_url ?? a.cdp_endpoint ?? a.attach);
      const attached = await this.ctrl.attachBrowser(endpoint);
      if (!attached.ok) return attached;
      if (a.startup_url) await this.ctrl.open(a.startup_url).catch(() => {});
      return { ...attached, result: { ...(attached as any).result, mode: "attached", viewport_pinned: false, note: "Driving an existing browser. session.close disconnects from it — it does not close the user's browser." } };
    }
    const reused = this.sm.isCreating || !!this.sm.getActive()?.engine?.connected;
    if (!reused) this.ctrl.clearCapture();
    const s = await this.sm.create({ headless: a.headless, profileDir: a.profile_dir, viewportWidth: a.viewport_width, viewportHeight: a.viewport_height, userAgent: a.user_agent, locale: a.locale, proxy: a.proxy, downloadDir: a.download_dir, startupUrl: a.startup_url });
    // Viewport reconciliation (DEF-5).
    //
    // This block used to be gated on `(a.viewport_width || a.viewport_height)`, so
    // the WHOLE read-back — the measurement, the warning, and the assignment of the
    // measured value into s.config — was skipped whenever the caller omitted the
    // optional arguments, i.e. on the documented default path. s.config then kept
    // the *requested* default forever, so session.create and server.info reported a
    // viewport that had never been compared against the browser. Measured: reported
    // 1280x720 while the page was 1920x912.
    //
    // The read-back is unconditional: truth is read on every fresh session, and the
    // response reports both the request and what the browser actually gave.
    let viewportRequested: { width: number; height: number } | undefined;
    if (!reused && s.engine) {
      // Pin the CSS viewport on every fresh session — but pin it at the size the
      // window ALREADY has, not at the config default.
      //
      // Pinning is the fix for drift: a session created at 1536x730 was serving a
      // 936px MOBILE layout minutes later because the user un-maximized the window,
      // the responsive "Create design" menu was then not rendered at all, and there
      // was no tool to recover except closing the session and losing the tabs.
      // Emulation.setDeviceMetricsOverride does not touch the OS window, so pinning
      // is not a resize of the user's desktop.
      //
      // Measuring first matters: defaulting the pin to the 1280x720 config value
      // would have silently narrowed every session below its real width, which is a
      // layout change the caller never asked for and can itself cross a breakpoint.
      const live0 = await s.engine.viewportSize().catch(() => null);
      const w = a.viewport_width || live0?.width || s.config.viewportWidth;
      const h = a.viewport_height || live0?.height || s.config.viewportHeight;
      viewportRequested = { width: w, height: h };
      await s.engine.setViewportSize(w, h).catch(() => {});
      const actual = await s.engine.viewportSize().catch(() => null);
      const actualW = actual?.width ?? w;
      const actualH = actual?.height ?? h;
      if (actualW !== w || actualH !== h) {
        process.stderr.write(`[kruz] Viewport requested ${w}x${h} but Chrome reports ${actualW}x${actualH}. This is normal on headed Windows (title bar offset, display scaling).\n`);
      }
      s.config = { ...s.config, viewportWidth: actualW, viewportHeight: actualH };
    }
    const url = await s.engine?.url().catch(() => "about:blank") ?? "about:blank";
    // Report the engine's real tab id, not a hardcoded literal, so it matches
    // what page.observe / page.listTabs report for the same tab.
    const pageId = await this.activePageId();
    this.pageIdCache = pageId ?? null;
    // The control layer is injected over CDP and re-applies
    // on every navigation. Its banner is persistent — it always states which of
    // the three states the browser is in — while the blue glow and the input
    // lock engage only around mutating tool calls (route()).
    const indicator = a.control_indicator !== false;
    if (indicator) {
      await (s.engine as any)?.installControlIndicator?.()?.catch?.(() => {});
      // The layer comes up immediately in the thinking state: this session was
      // just created, so the model is engaged but has no call in flight. The
      // blue glow and input lock still engage only around tool calls
      // (see beginControl/endControl heartbeat).
      await this.setControlMode("thinking");
    }
    // `browser.viewport` is the MEASURED viewport, reconciled on every fresh session.
// `browser.viewport_requested` is what was asked for, so a caller can see the gap
// instead of having to trust one number or guess which one it is (DEF-5).
    return {
      ok: true, reused,
      ...(reused ? { message: "Reused the existing session; launch options and startup_url were not applied. Use page.open to navigate, or session.close before changing launch settings." } : {}),
      session_id: s.id, status: s.status, control_indicator: indicator,
      browser: {
        headless: s.config.headless,
        viewport: { width: s.config.viewportWidth, height: s.config.viewportHeight },
        ...(viewportRequested ? { viewport_requested: viewportRequested } : {}),
      },
      page_id: pageId, url,
    };
  }

  private async status() {
    const s = this.sm.getActive();
    if (!s) return this.noSess();
    const bc = this.ctrl.isBrowserConnected();
    const tabs = s.engine ? await s.engine.listTabs().catch(() => [] as any[]) : [];
    const activePageUrl = s.engine ? await s.engine.url().catch(() => "about:blank") : "about:blank";
    // Re-measure the viewport instead of echoing the creation snapshot. The log's
    // top bug was that this number went stale: created at 1536x730, serving a
    // 936px MOBILE layout minutes later, with no tool to recover from. Comparing
    // the live value against the pinned one turns "the control vanished" into
    // "the viewport moved", which is actionable.
    const live = s.engine ? await s.engine.viewportSize().catch(() => null) : null;
    const pinnedW = s.config?.viewportWidth;
    const pinnedH = s.config?.viewportHeight;
    const drifted = !!live && typeof pinnedW === "number" && typeof pinnedH === "number"
      && (live.width !== pinnedW || live.height !== pinnedH);
    if (drifted && live) {
      process.stderr.write(`[kruz] Viewport drifted: pinned ${pinnedW}x${pinnedH}, live ${live.width}x${live.height}. Something cleared the Emulation override — call page.setViewport to re-pin.\n`);
    }
    return {
      ok: true, session_id: s.id, status: bc ? s.status : "crashed", created_at: s.createdAt,
      browser_connected: bc, active_page: activePageUrl, pages: tabs.length,
      browser_viewport: live,
      viewport_requested: typeof pinnedW === "number" ? { width: pinnedW, height: pinnedH } : undefined,
      viewport_drifted: drifted,
      navigation_trace: this.sm.getTrace(s.id).slice(-10),
    };
  }

  private async obs(a: Record<string, any>) {
    const s = this.sm.getActive();
    if (!s?.engine) return this.noSess();
    const ts = new Date().toISOString();
    const { observation, isDelta } = await s.observer.observe(s.engine, a.scope, a.detail || "minimal");
    return { ok: true, ...observation, is_delta: isDelta, captured_at: ts };
  }

  private async click(a: Record<string, any>) {
    // Issue 5: Validate target parameter — provide helpful error when missing
    if (!a.target || (typeof a.target === "object" && Object.keys(a.target).length === 0)) {
      return {
        ok: false,
        error: kruzError(ErrCode.INVALID_TARGET, {
          subsystem: "router",
          message: "Missing or empty 'target' parameter. You must wrap the ref in a target object: {\"target\": {\"ref\": \"e...\"}}. Other valid fields: css, role, name, text, testid, id.",
          trace: ["router"],
        }).toJSON(),
      };
    }
    const engine = this.sm.getActiveEngine();
    if (!engine) return this.noSess();
    const tClick0 = Date.now();
    const tC0 = Date.now();
    // captureClickState returns {tabs, state} — the baseline that pageFeedback must
    // be diffed against is `before.state`. Passing `before` itself type-checks (it is
    // an object) and yields an EMPTY baseline, because every field it looks for lives
    // one level down. Every diff then compared the page against itself: url_changed
    // and document_changed were always false on a click that had navigated, and only
    // dom_changed survived, because signature did not exist on the wrapper.
    const before = await captureClickState(engine);
    const timing = { capture_ms: Date.now() - tC0, dispatch_ms: 0, complete_ms: 0, feedback_ms: 0, total_ms: 0 };
    const finish = async (response: any) => {
      if (!response.ok || response.result?.dialog_pending) return response;
      try {
        const tF0 = Date.now();
        const completion = await completeClick(engine, before, { ...a, effect_token: response.result?.effect_token });
        timing.complete_ms = Date.now() - tF0;
        return { ...response, result: { ...response.result, ...completion } };
      } catch (error) {
        return { ...response, result: { ...response.result, clicked:true, verified:false, completion_error:String(error), retry_safe:false } };
      }
    };
    const sd = this.safety.classify("click", a.target);
    // NOTE: Safety confirmation gating removed so the browser agent is fully
    // autonomous (e.g. accepting cookie-consent banners). If any restrictive
    // severity is (re)introduced, it is surfaced here for logging only and the
    // click is NOT blocked.
    if (sd.severity === "human" || sd.severity === "confirm") {
      process.stderr.write(`[kruz] safety(off): ${sd.reason} — proceeding automatically.\n`);
    }

    // Preserve the site's click semantics, including preventDefault and SPA menus.
    // Never infer a second navigation from an unchanged URL after a click.
    //
    // The recovery ladder is declared here and executed by the shared retry
    // policy so the escalation order lives in one place:
    //   1. dispatch
    //   2. overlay is covering the target -> dismiss known overlays, re-observe
    //      (refs are invalidated by the DOM churn an overlay removal causes), retry
    //   3. a transient re-render race -> re-observe to refresh refs, retry
    //   4. final dispatch attempt
    const dispatch = (overrides: Record<string, any> = {}) => {
      const tD0 = Date.now();
      const p = this.ctrl.click(a.target, a.fallback, a.scope, a.timeout_ms, a.strict, a.button, a.click_count, {
        force: a.force || overrides.force,
        ignoreVisibility: a.ignore_visibility,
        visual: overrides.visual ?? a.visual,
        speed: overrides.speed ?? a.speed,
        // Held across the whole click: shift-click / ctrl-click multi-select in
        // canvas and list editors cannot be expressed by a key combo.
        modifiers: a.modifiers,
      });
      // Accumulates across recovery-ladder attempts, so the number shows how much
      // of a slow click was genuine dispatch versus escalation.
      return p.finally(() => { timing.dispatch_ms += Date.now() - tD0; });
    };

    const reobserve = async (): Promise<boolean> => {
      const s = this.sm.getActive();
      if (!s?.engine) return false;
      await s.observer.observe(s.engine, undefined, "minimal", true);
      return true;
    };

    const dismissOverlays = async (): Promise<boolean> => {
      if (a.dismiss_overlays === false) return false;
      const handled = await this.ctrl.handleOverlays({ handle_js_alerts: false });
      return !!(handled.result as any)?.dismissed?.length;
    };

    /**
     * Visual-cursor leverage: when the deterministic click path fails, the next
     * dispatch glides a real cursor to the target and clicks with trusted input.
     * It hit-tests an 11-point probe grid and carries a genuine press/hold/
     * release, so it lands on badge-covered or layered targets (and on pages
     * that distrust raw synthetic clicks). `fast` keeps the cost to a few
     * hundred ms, and it is the LAST rung: the fast path still runs first.
     */
    let useVisual = false;
    const visualClick = async (): Promise<boolean> => {
      if (a.visual === true) return false;      // caller already asked for it
      if (a.force === true) return false;       // force already bypasses guards
      useVisual = true;
      visualFallback = { used: true, speed: "fast" };
      return true;
    };

    const escalations = [
      { name: "dismiss-overlays", run: dismissOverlays },
      { name: "re-observe", run: reobserve },
      { name: "visual-click", run: visualClick },
    ];

    let overlays: unknown;
    let visualFallback: { used: boolean; speed: string } | undefined;
    let response: any;
    try {
      response = await withRetry(() => dispatch(useVisual ? { visual: true, speed: "fast" } : {}), {
        retryOn: CLICK_RETRY_CODES,
        delayMs: 150,
        escalations,
        // P1-D: the ladder is bounded so a recoverable failure can't become a stall.
        budgetMs: 12000,
      });
    } catch (err) {
      // withRetry exhausted the ladder. Surface the classified error, but keep
      // the overlay report so the model can see what was (and wasn't) dismissed.
      try {
        const handled = await this.ctrl.handleOverlays({ handle_js_alerts: false });
        overlays = handled.result;
      } catch { /* ignore */ }
      response = { ok: false, error: shapeError(toErrorEnvelope(err), "page.click") };
    }

    const settled = await finish({...response, ...(overlays ? {overlay_handling:overlays} : {}), ...(visualFallback ? {visual_fallback:visualFallback} : {})});
    // Where the time went. Observe already reports `timing`; a slow click is the
    // single most-reported latency in browser control, and without this split a
    // 2s click is indistinguishable from a 2s click.
    //
    // The controller's own fields (resolve_ms / action_ms / verify_ms) are
    // SPREAD rather than replaced: `timing.resolve_ms` is a documented contract
    // and nesting it would break every existing reader. `total_ms` is the one
    // field that must be overridden — the router's total also covers the
    // pre-dispatch capture and the post-click verification poll.
    const ctrlTiming = (settled as any)?.timing;
    settled.timing = { ...(ctrlTiming && typeof ctrlTiming === "object" ? ctrlTiming : {}), ...timing, total_ms: Date.now() - tClick0 };
    // BUG-009: page.click was the only action tool that returned `result` instead of
    // the compact post-action `state` that press/fill/select/scroll all provide. The
    // skill documents `state` as the closed loop ("use it to decide the next step
    // without a separate page.observe"), and click is the highest-traffic tool in the
    // catalog - so the documented path was missing exactly where it is used most, and
    // dom_changed / focus / signature / document_changed / page_mutated were
    // unreachable after a click.
    //
    // The verification fields are ALSO hoisted, because the skill's verification table
    // presents clicked/verified/verification as top-level and reading `res.clicked`
    // returned undefined - the same class of path trap that produced two false bug
    // reports this session. `result` keeps everything for backward compatibility.
    if (settled.ok !== true || !engine) return settled;
    let clickState: unknown = null;
    const tB0 = Date.now();
    try {
      clickState = await this.ctrl.pageFeedback(engine, this.stateOf((before as any)?.state), { includeLists: false });
    } catch { /* state is advisory; never fail a click over it */ }
    timing.feedback_ms = Date.now() - tB0;
    settled.timing = { ...(ctrlTiming && typeof ctrlTiming === "object" ? ctrlTiming : {}), ...timing, total_ms: Date.now() - tClick0 };
    if (!clickState) return settled;
    return { ...settled, state: clickState, ...hoistResult(settled.result, ["clicked", "verified", "verification", "effect_observed", "navigation", "url", "title", "resolution_tier", "effect_token", "ref"]) };
  }

  private async extText(a: Record<string, any>) {
    const s = this.sm.getActive();
    if (!s?.engine) return this.noSess();
    await this.waitForContent(s.engine);
    // Same canonical id for both: `tabId` defaulted to a separate hardcoded "tab1"
    // namespace, so one response carried page_id "tab-1" and tab_id "tab1".
    const pid = this.pid();
    return s.extractor.extractText(s.engine, a.target, a.fallback, a.scope, pid, pid);
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

  // Issue 1 & 7: Auto-retry with new session on browser crash
  private async openWithRetry(url: string, waitFor?: string, timeoutMs?: number, retries = 1, detectRedirect?: boolean): Promise<any> {
    // K1: networkidle NEVER resolves as a browser lifecycle event on SPAs with
    // WebSockets (Oracle HCM, etc.), so the CONTROLLER handles it with a bounded
    // in-page quiescence check instead. The caller's argument is passed through
    // untouched: coercing it here made `_wait_condition.requested` echo a request
    // that was never made, so `requested === effective` always held and no
    // caller could detect the downgrade.
    const attempt = async (): Promise<any> => {
      const result = await this.ctrl.open(url, waitFor as any, timeoutMs);
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
        // Navigation reports the canonical tab id so an agent can correlate the
        // tab across navigate/observe/click. It was absent here, which is what
        // made the id look like it lived in two namespaces ("p1" vs "tab-1").
        if (result && result.ok && result.result && result.result.page_id === undefined) {
          // Bounded via the shared helper — see boundedActivePageId. This call was
          // unbounded and alone accounted for >51s of a 55s route budget.
          // Only set the id when we actually got one: a timed-out probe must not
          // replace a missing id with a misleading null.
          const resolvedId = await this.boundedActivePageId();
          if (resolvedId !== null) result.result.page_id = resolvedId;
        }
        // page_id also rides the top level via diagnostics(), so `r.page_id`
        // works here exactly as it does on session.create / page.observe.
        return result;
      }
      // A non-crash failure is terminal — do not burn the retry budget.
      //
      // `result.error` is already a KruzError ENVELOPE ({code, message, ...}), not a
      // thrown Error. Feeding it to kruzErrorFromThrown made the classifier run
      // String(err) on a plain object, which is "[object Object]" — it matched no
      // pattern and collapsed to the CLICK_FAILED default. A navigation failure
      // therefore reported `CLICK_FAILED: [object Object]` (observed live on a
      // disconnected browser), which is both the wrong code and an unreadable message.
      // Re-wrap the envelope with its own code instead of re-deriving it.
      if (result.error?.code !== ErrCode.BROWSER_CRASHED) {
        throw kruzError(result.error?.code ?? ErrCode.OPERATION_FAILED, {
          subsystem: "session",
          message: result.error?.message ?? `Navigation to ${url} failed.`,
          retryable: result.error?.retryable,
          help: result.error?.help,
          cause: result.error,
        });
      }
      throw kruzError(ErrCode.BROWSER_CRASHED, { subsystem: "session", message: result.error?.message ?? "Browser disconnected during navigation.", cause: result.error });
    };

    const recreateSession = async (): Promise<boolean> => {
      process.stderr.write("[kruz] Browser crashed during page.open, recreating session\n");
      try { await this.sm.close(undefined, false); } catch { /* ignore */ }
      try { await this.sm.create(); return true; } catch { return false; }
    };

    const escalations = retries > 0 ? [{ name: "recreate-session", run: recreateSession }] : [];
    try {
      return await withRetry(attempt, { retryOn: [ErrCode.BROWSER_CRASHED], escalations });
    } catch (err) {
      const env = toErrorEnvelope(err);
      // Preserve the original navigation failure; only report exhaustion when the
      // ladder ran out of attempts on a genuinely retryable cause.
      if (env.code === ErrCode.BROWSER_CRASHED && retries > 0) {
        return { ok: false, error: kruzError(ErrCode.RETRY_EXHAUSTED, { subsystem: "router", message: "All navigation retry attempts exhausted after browser crashes.", cause: err, trace: ["router"] }).toJSON() };
      }
      return { ok: false, error: shapeError(env, url.includes("jobdetails") ? "page.open" : "page.goto") };
    }
  }

  /**
 * The canonical tab id for the active page — ONE id, read from the engine.
 *
 * This used to be a hardcoded `"p1"`, while `page.observe` reported the engine's
 * real tab id (`"tab-1"`). So the same physical tab had two names depending on
 * which tool you asked, and `page_id` was missing from `page.open` altogether —
 * an agent could not correlate a tab across calls without guessing, which makes
 * multi-tab work fragile and invites acting on the wrong tab.
 *
 * `controller.activePageId` resolves the same way (`refreshIdentity` reads
 * `engine.listTabs()`), so both sides now agree on one namespace.
 */
  private async activePageId(): Promise<string | null> {
    const s = this.sm.getActive();
    if (!s?.engine) { this.pageIdCache = null; return null; }
    const tabs = await s.engine.listTabs().catch(() => null);
    const active = tabs?.find((t) => t.isActive) ?? tabs?.[0];
    this.pageIdCache = active?.id ?? null;
    return this.pageIdCache;
  }

  /** Refresh the cached tab id after an operation that may have changed it.
   *
   *  Bounded, because it runs on failure paths too — including immediately after
   *  a route timeout, where the browser may be exactly the thing that is stuck.
   *  An unbounded `listTabs()` here would trade a reported timeout for a hung
   *  route, which is strictly worse. */
  private async refreshPageId(): Promise<void> {
    await this.boundedActivePageId();
  }

  /**
   * `activePageId()` with a hard ceiling, shared by EVERY caller.
   *
   * This exists because the bound was previously applied at one call site
   * (`refreshPageId`) and forgotten at its sibling in `openWithRetry`, which called
   * `activePageId()` bare. `activePageId()` reaches `engine.listTabs()`, which calls
   * raw `page.title()` per tab — and `Page.getTitle` hangs indefinitely on a tab
   * whose navigation is still in flight, which is precisely the state right after a
   * `page.open` goto timeout.
   *
   * The measured consequence was severe and entirely self-inflicted: a `page.open`
   * that had already finished correctly in 4.3s (ok:true, _warning:PAGE_NOT_READY)
   * spent >51s inside this one decoration, overran the router's 55s route budget,
   * and was reported to the agent as ACTION_TIMEOUT with `outcome:"unknown"` and
   * `retry_safe:false` — i.e. the agent could no longer tell whether the navigation
   * had happened at all. A tab id is decoration; it must never be able to convert a
   * known answer into an unknown one.
   *
   * Returns null on expiry rather than leaving a dangling id in the response.
   */
  private async boundedActivePageId(ms = 1500): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.activePageId().catch(() => null),
        new Promise<string | null>((r) => { timer = setTimeout(() => r(null), ms); timer.unref?.(); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Run a tab-mutating call, then re-read which tab is active.
   *
   *  `finally`, not "after success": a tab op that throws or hangs may still have
   *  switched the engine's active page before failing (switchTab assigns
   *  `_page` before its focus ping), and a cache that only refreshes on success
   *  then reports the OLD tab on the very response that most needed the new one. */
  private async tabOp<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      await this.refreshPageId();
    }
  }

  /**
   * Canonical tab id, synchronous form. Reads the cache rather than calling
   * listTabs(), because this rides inside an action that already made CDP calls.
   *
   * This used to be `s?.engine ? "p1" : "p1"` — both branches identical, i.e. a
   * hardcoded "p1". So extract_text reported `source.page_id: "p1"` and
   * `source.tab_id: "tab1"` while every other tool reported "tab-1": the last
   * surviving trace of the two-namespace split, hidden inside one field that no
   * round had happened to read.
   */
  private pid(): string {
    if (!this.sm.getActive()?.engine) return "p1";
    return this.pageIdCache ?? "tab-1";
  }
  private noSess() { return { ok: false, error: kruzError(ErrCode.NO_SESSION, { subsystem: "session", message: "No active session in this MCP server instance. Compare server_instance_id with previous responses; call session.create here to start a session.", trace: ["router"] }).toJSON() }; }
  getSessionManager() { return this.sm; }

  // ── Server diagnostics (no session required) ───────────────────────────

  private async serverInfo() {
    const s = this.sm.getActive();
    const config = s?.config ?? loadConfig();
    const activePage = s?.engine ? await s.engine.url().catch(() => "about:blank") : "about:blank";
    const pages = s?.engine ? (await s.engine.listTabs().catch(() => [])).length : 0;
    return {
      ok: true,
      server: { name: "kruz", version: KRUZ_VERSION, uptime: Math.round((Date.now() - KRUZ_START_MS) / 1000), build: buildInfo() },
      session: s ? { status: s.status, session_id: s.id, browser_connected: this.ctrl.isBrowserConnected(), active_page: activePage, pages } : null,
      config: { engine: s?.engine?.kind ?? null, headless: config.headless, viewport: { width: config.viewportWidth, height: config.viewportHeight }, safety_policy: config.safetyPolicy, locale: config.locale },
      tools_count: KNOWN_TOOLS.size,
      docs: {
        skill: "kruz://skill",
        instruction: "Read kruz://skill before using tools. It contains everything about Kruz MCP: what it is, how it works, and how to use it.",
      },
      message: "Kruz MCP server is connected and operational.",
    };
  }
}
