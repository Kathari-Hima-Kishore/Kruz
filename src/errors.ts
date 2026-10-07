/**
 * KruzError — single source of truth for error classification, provenance, and
 * retry policy across every subsystem (router, controller, engine, observer,
 * ATS tools, session manager).
 *
 * Every failure should surface as a KruzError (or a plain Error that gets
 * normalized through `kruzError()`). All error responses emitted towards the
 * MCP client carry:
 *   - code             stable machine code (e.g. NO_SESSION, TARGET_NOT_FOUND)
 *   - subsystem        which layer produced it (router|controller|engine|session|...)
 *   - retryable        whether retrying the SAME action is likely to succeed
 *   - help             a concise, actionable remediation hint for the model
 *   - trace            causal chain [tool -> router -> controller -> engine ...]
 */

export const SUBSYSTEMS = [
  "router",
  "controller",
  "engine",
  "selector",
  "session",
  "observer",
  "overlay",
  "ats",
  "launcher",
  "computer-use",
  "internal",
] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

/** Stable, documented error codes. Failure modes are finite; provisional
 *  ANY/UNKNOWN codes should be graduated into the enum as they surface in
 *  production so classification stays centralized. */
export const ErrCode = {
  // session
  NO_SESSION: "NO_SESSION",
  HEADED_REQUIRED: "HEADED_REQUIRED",
  RESUME_FAILED: "RESUME_FAILED",
  BROWSER_CRASHED: "BROWSER_CRASHED",
  BROWSER_LAUNCH_FAILED: "BROWSER_LAUNCH_FAILED",
  // targets
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",
  ELEMENT_DISABLED: "ELEMENT_DISABLED",
  ELEMENT_NOT_VISIBLE: "ELEMENT_NOT_VISIBLE",
  ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
  ELEMENT_NOT_EDITABLE: "ELEMENT_NOT_EDITABLE",
  ELEMENT_OBSCURED: "ELEMENT_OBSCURED",
  STALE_ELEMENT: "STALE_ELEMENT",
  /**
   * A ref that no longer identifies a live element. Distinct from
   * TARGET_NOT_FOUND: the caller addressed a known element and the element is
   * gone, which is a different plan-level problem from "my selector matched
   * nothing". Emitted only AFTER the safe re-resolution ladder has run, so it is
   * never retryable — replaying the same ref cannot succeed.
   */
  STALE_REFERENCE: "STALE_REFERENCE",
  /** The ref was never minted, or was invalidated by a navigation/action. */
  UNKNOWN_REFERENCE: "UNKNOWN_REFERENCE",
  /** The document behind a ref was replaced (navigation). Never cross-document reuse. */
  DOCUMENT_CHANGED: "DOCUMENT_CHANGED",
  /** The frame that held the ref is gone or swapped. */
  FRAME_CHANGED: "FRAME_CHANGED",
  /** The element exists and matches, but cannot be acted on in its current state. */
  TARGET_NOT_ACTIONABLE: "TARGET_NOT_ACTIONABLE",
  /** P0-A: a wait predicate stayed false while the page had stopped changing. */
  CONDITION_NOT_MET: "CONDITION_NOT_MET",
  // input / pages
  CLICK_FAILED: "CLICK_FAILED",
  /**
   * A `fill`/`select` was dispatched but the control did not keep the value — a
   * framework handler rejected or transformed it, or a reactive control reverted
   * it. Distinct from CLICK_FAILED because the remediation is completely different:
   * an overlay and `force:true` have nothing to do with it. Previously every such
   * failure fell through to the CLICK_FAILED default and told the caller to retry
   * with `force:true` (reported from a Canva numeric field).
   */
  FILL_NOT_RETAINED: "FILL_NOT_RETAINED",
  INVALID_TARGET: "INVALID_TARGET",
  INVALID_INPUT: "INVALID_INPUT",
  /** The named tab is not open. A caller mistake, not a browser failure. */
  NO_TAB: "NO_TAB",
  /**
   * An operation failed for a reason not otherwise classified. This is what a
   * tool name used as an error code collapses into — see controller.err().
   * The originating operation is preserved on the envelope as `operation`.
   */
  OPERATION_FAILED: "OPERATION_FAILED",
  // overlays
  /**
   * An overlay region was detected but Kruz declined to guess which control
   * dismisses it. This is a REFUSAL, not a failure: Kruz did its job, and the
   * region it found is returned in `result.region` with the controls it saw in
   * `result.candidates`, so the caller can pick one explicitly.
   */
  OVERLAY_NO_DISMISS_INTENT: "OVERLAY_NO_DISMISS_INTENT",
  // routing / lifecycle
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  ACTION_TIMEOUT: "ACTION_TIMEOUT",
  ROUTE_TIMEOUT: "ROUTE_TIMEOUT",
  RETRY_EXHAUSTED: "RETRY_EXHAUSTED",
  NO_MATCH: "NO_MATCH",
  // computer-use (coordinate/vision) helpers
  CU_LIST: "CU_LIST",
  CU_SNAPSHOT: "CU_SNAPSHOT",
  CU_MARK: "CU_MARK",
  CU_CLEAR: "CU_CLEAR",
  CU_SCROLL: "CU_SCROLL",
  CU_NO_TARGET: "CU_NO_TARGET",
  // generic fallback — always graduate into a specific code
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
export type ErrCode = (typeof ErrCode)[keyof typeof ErrCode];

/**
 * FAILURE vs REFUSAL — the distinction the MCP `isError` flag depends on.
 *
 * A **failure** means the tool could not do its job: no session, a crashed
 * browser, an unhandled exception, a timeout. Nothing useful came back.
 *
 * A **refusal** means the tool did its job and the answer is "no, not safely".
 * Nothing was guessed, nothing was clicked, and the payload carries everything
 * the caller needs to choose deliberately — the `candidates` list on
 * AMBIGUOUS_TARGET, the `region` and controls on
 * OVERLAY_NO_DISMISS_INTENT, the diagnostics on TARGET_NOT_FOUND.
 *
 * This is load-bearing because MCP's `isError: true` is surfaced by most clients
 * as a THROWN exception, with the JSON envelope flattened into `Error.message`.
 * A caller doing the documented `const r = await tool(...); if (!r.ok)` therefore
 * never reaches its own branch, and any actionable payload has to be re-parsed
 * out of an exception string. Worse, the throw-vs-resolve behaviour then varies
 * by client and by call, so code validated against one call breaks on the next.
 *
 * Refusals therefore resolve as ordinary values carrying `ok: false` plus the
 * typed envelope. Failures still set `isError`.
 */
export type ErrorOutcome = "failure" | "refusal";

/**
 * Codes that are refusals rather than failures. Kept as an explicit allowlist
 * rather than inferred from `retryable`, because "retryable" answers a
 * different question (is a replay likely to work) and both refusal and failure
 * are routinely non-retryable.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ErrCode.TARGET_NOT_FOUND,
  ErrCode.AMBIGUOUS_TARGET,
  ErrCode.ELEMENT_NOT_FOUND,
  ErrCode.ELEMENT_DISABLED,
  ErrCode.ELEMENT_NOT_VISIBLE,
  ErrCode.ELEMENT_NOT_EDITABLE,
  ErrCode.ELEMENT_OBSCURED,
  ErrCode.ELEMENT_OBSCURED,
  ErrCode.STALE_ELEMENT,
  ErrCode.STALE_REFERENCE,
  ErrCode.UNKNOWN_REFERENCE,
  ErrCode.DOCUMENT_CHANGED,
  ErrCode.FRAME_CHANGED,
  ErrCode.TARGET_NOT_ACTIONABLE,
  ErrCode.CONDITION_NOT_MET,
  ErrCode.OVERLAY_NO_DISMISS_INTENT,
  // Caller-input validation. These are diagnosed, terminal, and carry `help`
  // naming the correct shape, so they belong in the same class as TARGET_NOT_FOUND:
  // Kruz read the request, understood it, and rejected it. Throwing them meant an
  // agent following the documented `if (!r.ok)` pattern crashed on a typo'd
  // argument instead of reading the message that told it how to fix it.
  ErrCode.INVALID_INPUT,
  ErrCode.INVALID_TARGET,
  ErrCode.NO_TAB,
]);

export function isRefusalCode(code: string): boolean {
  return REFUSAL_CODES.has(code);
}

/** Is this string one of the documented, branchable error codes? */
export function isErrCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ErrCode, code);
}

export interface KruzErrorField {
  code: string;
  subsystem?: Subsystem;
  retryable?: boolean;
  message?: string;
  help?: string;
}

/** Wire shape of an error — what every layer returns and the MCP client sees. */
export interface KruzErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  /** "refusal" resolves as a value; "failure" sets MCP isError. */
  outcome: ErrorOutcome;
  subsystem?: Subsystem;
  help?: string;
  trace?: string[];
  cause?: string;
  /** The originating operation when `code` had to be normalised (see controller.err). */
  operation?: string;
}

export class KruzError extends Error {
  readonly code: string;
  readonly subsystem: Subsystem;
  readonly retryable: boolean;
  readonly help?: string;
  /** Causal chain: outermost first. [tool, router, controller, engine, ...] */
  readonly trace: string[];
  /** Underlying cause, when one exists (puppeteer/CDP/DOM error). */
  readonly cause?: unknown;
  /** Derived from `code` so no call site can opt out by omission. */
  readonly outcome: ErrorOutcome;

  constructor(fields: KruzErrorField & { trace?: string[]; cause?: unknown }) {
    super(fields.message || fields.code);
    this.name = "KruzError";
    this.code = fields.code;
    this.subsystem = fields.subsystem ?? "internal";
    this.retryable = fields.retryable ?? false;
    this.help = fields.help;
    this.trace = fields.trace ?? [];
    this.cause = fields.cause;
    this.outcome = isRefusalCode(fields.code) ? "refusal" : "failure";
  }

  /** Serialize to the wire envelope used across the MCP boundary. */
  toJSON(): KruzErrorEnvelope {
    const obj: KruzErrorEnvelope = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      outcome: this.outcome,
      subsystem: this.subsystem,
    };
    if (this.help) obj.help = this.help;
    if (this.trace.length) obj.trace = this.trace;
    if (this.cause !== undefined) {
      obj.cause = String(
        typeof this.cause === "object" && (this.cause as any)?.message
          ? (this.cause as any).message
          : this.cause,
      ).slice(0, 2000);
    }
    return obj;
  }

  /** Return a copy tagged with one more layer of provenance. */
  at(layer: string): KruzError {
    const next = new KruzError({
      code: this.code,
      message: this.message,
      subsystem: this.subsystem,
      retryable: this.retryable,
      help: this.help,
      trace: [layer, ...this.trace],
      cause: this.cause,
    });
    return next;
  }
}

/** Help text keyed by error code — one place to keep the model's remediation
 *  hints so the routines scattered across the old `err()` calls collapse. */
const HELP: Partial<Record<ErrCode, string>> = {
  [ErrCode.NO_SESSION]: "Call session.create to start a headed browser session, then retry.",
  [ErrCode.NO_MATCH]: "Reload or re-navigate so the page feed is captured, then retry.",
  [ErrCode.ELEMENT_OBSCURED]: "An overlay is covering the target. Rely on the auto overlay-dismissal, or call page.handleOverlays first, or click with force:true.",
  [ErrCode.AMBIGUOUS_TARGET]: "Multiple visible elements match. Narrow with a more specific css/text/ref, or a scope.",
  [ErrCode.STALE_ELEMENT]: "The DOM re-rendered between observe and action. Re-observe (page.observe) to refresh refs, then retry.",
  [ErrCode.TARGET_NOT_FOUND]: "Nothing matched. Call page.probe to see what is actually present right now, or page.observe to pick a ref, and use a more specific selector. Retrying the identical target will not help.",
  [ErrCode.ELEMENT_NOT_FOUND]: "No element matched. Call page.probe to see the current DOM, or page.observe to pick a ref.",
  [ErrCode.STALE_REFERENCE]: "The element this ref identified is gone, and nothing provably identical replaced it. Re-probe or re-observe to mint a fresh ref. Do not replay this ref.",
  [ErrCode.UNKNOWN_REFERENCE]: "This ref was never issued, or it was invalidated by a navigation or action since. Re-observe or re-probe for a fresh ref.",
  [ErrCode.DOCUMENT_CHANGED]: "The page navigated, so refs from before the navigation no longer apply. Observe or probe the new page for fresh refs.",
  [ErrCode.FRAME_CHANGED]: "The frame that held this ref is gone or has been replaced. Re-observe the page to see the current frames.",
  [ErrCode.OVERLAY_NO_DISMISS_INTENT]: "An overlay was found but none of its controls has a safe dismissal intent, so nothing was clicked. Inspect `result.candidates` for the controls inside the region and click an explicit Close / dismiss control by ref, or pass `force:true` to click through.",
  [ErrCode.TARGET_NOT_ACTIONABLE]: "The target matched but is not in a state that can be acted on. page.probe reports per-candidate visible/enabled/actionable — pick an actionable candidate, or change the page state first.",
  [ErrCode.ELEMENT_DISABLED]: "The control is disabled. Wait for it to become enabled, or choose a different control.",
  [ErrCode.ELEMENT_NOT_VISIBLE]: "The element exists but is not rendered. Scroll it into view, expand its section, or pass ignore_visibility:true.",
  [ErrCode.ELEMENT_NOT_EDITABLE]: "The target is not an input/textarea/contenteditable. Target the form field itself, not its container.",
  [ErrCode.CONDITION_NOT_MET]: "The waited-for condition never appeared and the page had already stopped changing. Re-observe what is actually present (page.observe) or probe the current DOM (page.probe); do not re-wait for the same predicate.",
  [ErrCode.INVALID_TARGET]: "Pass a non-empty target object, e.g. {\"target\":{\"ref\":\"e12\"}} or {\"target\":{\"css\":\"#submit\"}}.",
  [ErrCode.ACTION_TIMEOUT]: "The action exceeded its time budget. Observe the page state before deciding whether to retry.",
  [ErrCode.BROWSER_CRASHED]: "The renderer crashed. Call session.create to relaunch, then re-navigate.",
  [ErrCode.BROWSER_LAUNCH_FAILED]: "Chrome could not start. Another process may hold the profile dir; pass a different profile_dir, or check that the configured Chrome path is readable.",
  [ErrCode.HEADED_REQUIRED]: "Kruz runs a visible browser only. Call session.create with headless:false.",
  [ErrCode.UNKNOWN_TOOL]: "Check the tool name against the registered tool list.",
  [ErrCode.RETRY_EXHAUSTED]: "Every recovery attempt failed. Inspect the page with page.observe before retrying.",
  [ErrCode.CLICK_FAILED]: "The click could not be dispatched. Inspect the target with page.observe; retry with force:true if an overlay is in the way.",
  [ErrCode.FILL_NOT_RETAINED]: "The field took the input event but did not keep the value, so a script handler rejected or reformatted it. Do NOT retry with force:true — that is for clicks. Read the field's current value; if the app commits on blur, follow the fill with page.press({key:'Tab'}) or Enter. For controlled inputs, set one field at a time.",
  [ErrCode.CU_NO_TARGET]: "No computer-use target at that index. Call page.computerUseList to get the current targets, then retry.",
  [ErrCode.CU_LIST]: "Could not read interactive targets. The page may be mid-navigation; observe and retry.",
  [ErrCode.CU_SNAPSHOT]: "Could not read the computer-use snapshot. Observe and retry.",
  [ErrCode.CU_MARK]: "Could not mark targets. Retry after the page settles.",
  [ErrCode.CU_CLEAR]: "Could not clear marks. Retry after the page settles.",
  [ErrCode.CU_SCROLL]: "Could not scroll to the target. Re-list targets and retry.",
  [ErrCode.INVALID_INPUT]: "The argument is malformed. Check the expected shape for this tool.",
  [ErrCode.NO_TAB]: "That tab is not open. Call page.listTabs for the current ids; the active tab can change after newTab, switchTab and closeTab.",
  [ErrCode.OPERATION_FAILED]: "The operation failed on the page. Inspect current state with page.observe before retrying; if it repeats on a settled page, treat it as site behaviour rather than a transient fault.",
  [ErrCode.ROUTE_TIMEOUT]: "The tool exceeded its routing budget. Inspect page state before retrying.",
};

/** Build a KruzError, normalizing any thrown value and preserving the causal chain. */
export function kruzError(
  code: string,
  opts: { message?: string; subsystem?: Subsystem; retryable?: boolean; help?: string; cause?: unknown; trace?: string[] } = {},
): KruzError {
  return new KruzError({
    code,
    message: opts.message,
    subsystem: opts.subsystem ?? classify(code),
    retryable: opts.retryable ?? isRetryableCode(code),
    help: opts.help ?? HELP[code as ErrCode],
    cause: opts.cause,
    trace: opts.trace,
  });
}

/**
 * Whether a code is retryable by default. Centralized — the engine/controller
 * previously duplicated this on every err() call site.
 *
 * The contract is "can the SAME input plausibly succeed without replanning?".
 *   retryable     transient browser state — an overlay, a re-render race, a
 *                 control that has not finished hydrating.
 *   not retryable the input itself is wrong or unfixable — a ref that no longer
 *                 exists, a selector that matches nothing on a settled page, or
 *                 a confirmed ambiguity that needs a model choice.
 *
 * Getting this wrong is not cosmetic: the manual report's Bug 3 showed a dead
 * ref tagged `retryable: true`, which invites the model into exactly the
 * retry loop the skill tells it to avoid.
 */
export function isRetryableCode(code: string): boolean {
  switch (code) {
    // Transient DOM/overlay state — the same call can work a moment later.
    case ErrCode.ELEMENT_OBSCURED:
    case ErrCode.STALE_ELEMENT:
    case ErrCode.ELEMENT_NOT_VISIBLE:
    case ErrCode.ELEMENT_DISABLED:
    // Browser-level transients.
    case ErrCode.NO_SESSION:
    case ErrCode.BROWSER_CRASHED:
    case ErrCode.ACTION_TIMEOUT:
    case ErrCode.NO_MATCH:
    case ErrCode.INTERNAL_ERROR:
      return true;
    // Terminal by construction. Replaying identical input cannot change the
    // outcome, so the model must reconsider rather than loop.
    case ErrCode.TARGET_NOT_FOUND:
    case ErrCode.ELEMENT_NOT_FOUND:
    case ErrCode.AMBIGUOUS_TARGET:
    case ErrCode.STALE_REFERENCE:
    case ErrCode.UNKNOWN_REFERENCE:
    case ErrCode.DOCUMENT_CHANGED:
    case ErrCode.FRAME_CHANGED:
    case ErrCode.TARGET_NOT_ACTIONABLE:
    case ErrCode.ELEMENT_NOT_EDITABLE:
    case ErrCode.INVALID_TARGET:
    case ErrCode.INVALID_INPUT:
    case ErrCode.NO_TAB:
      return false;
    default:
      return false;
  }
}

/** Infer subsystem from a code when not explicitly provided. */
export function classify(code: string): Subsystem {
  switch (code) {
    case ErrCode.NO_SESSION:
    case ErrCode.HEADED_REQUIRED:
    case ErrCode.RESUME_FAILED:
    case ErrCode.BROWSER_LAUNCH_FAILED:
      return "session";
    // Ref lifecycle and target lookup are the *selector's* business, so they report
    // as "selector". These used to sit in the "engine" arm with a second, unreachable
    // duplicate arm below it claiming "selector" — the earlier arm always won, so the
    // intended classification was dead code and every ref error reported "engine".
    case ErrCode.AMBIGUOUS_TARGET:
    case ErrCode.TARGET_NOT_FOUND:
    case ErrCode.ELEMENT_NOT_FOUND:
    case ErrCode.STALE_REFERENCE:
    case ErrCode.UNKNOWN_REFERENCE:
    case ErrCode.DOCUMENT_CHANGED:
    case ErrCode.FRAME_CHANGED:
      return "selector";
    // Acting on a resolved node.
    case ErrCode.ELEMENT_OBSCURED:
    case ErrCode.ELEMENT_DISABLED:
    case ErrCode.ELEMENT_NOT_VISIBLE:
    case ErrCode.ELEMENT_NOT_EDITABLE:
    case ErrCode.STALE_ELEMENT:
    case ErrCode.CLICK_FAILED:
    case ErrCode.FILL_NOT_RETAINED:
    case ErrCode.TARGET_NOT_ACTIONABLE:
    case ErrCode.CONDITION_NOT_MET:
      return "engine";
    case ErrCode.OVERLAY_NO_DISMISS_INTENT:
      return "overlay";
    case ErrCode.ACTION_TIMEOUT:
    case ErrCode.ROUTE_TIMEOUT:
    case ErrCode.RETRY_EXHAUSTED:
    case ErrCode.UNKNOWN_TOOL:
    case ErrCode.NO_MATCH:
      return "router";
    case ErrCode.CU_LIST:
    case ErrCode.CU_SNAPSHOT:
    case ErrCode.CU_MARK:
    case ErrCode.CU_CLEAR:
    case ErrCode.CU_SCROLL:
    case ErrCode.CU_NO_TARGET:
      return "computer-use";
    default:
      return "internal";
  }
}

/**
 * Normalize any thrown value into a KruzError-ready envelope WITHOUT losing the
 * original code/cause. Used at the outermost catch (router) so a thrown
 * KruzError keeps its taxonomy and a raw Error becomes INTERNAL_ERROR.
 */
export function toErrorEnvelope(err: unknown): KruzErrorEnvelope {
  if (err instanceof KruzError) {
    const env = err.toJSON();
    if (err.cause !== undefined && !env.cause) {
      env.cause = String(
        typeof err.cause === "object" && (err.cause as any)?.message
          ? (err.cause as any).message
          : err.cause,
      ).slice(0, 2000);
    }
    return env;
  }
  return kruzErrorFromThrown(err).toJSON();
}

/**
 * Recover a typed KruzError from any thrown value.
 *
 * The engine historically threw bare strings for a handful of actionability
 * failures (`ELEMENT_OBSCURED`, `ELEMENT_DISABLED`, `ELEMENT_NOT_VISIBLE`) and
 * `Element not found: <handle>` for stale handles. Those codes were previously
 * flattened into a generic CLICK_FAILED with the whole string as the message, so
 * the originating subsystem and remedy were lost. This maps them back onto the
 * taxonomy and, critically, extracts the useful part of an obscured click (the
 * blocking element tag/id) into a readable message.
 */
export function kruzErrorFromThrown(err: unknown, opts: { subsystem?: Subsystem; trace?: string[] } = {}): KruzError {
  if (err instanceof KruzError) return err;
  const raw = String(err instanceof Error ? err.message : err);

  if (/ELEMENT_OBSCURED/.test(raw)) {
    // e.g. ELEMENT_OBSCURED: {"target":"BUTTON","hit":"DIV","hit_id":"cookie","x":640,"y":218}
    // D6: keep the target descriptor in the message, and never render a null
    // blocker (elementFromPoint returns null for offscreen points).
    let detail = "";
    let targetName = "element";
    const json = /ELEMENT_OBSCURED:\s*(\{.*\})/.exec(raw);
    if (json?.[1]) {
      try {
        const hit = JSON.parse(json[1]) as { target?: string; hit?: string | null; hit_id?: string; x?: number; y?: number };
        if (hit.target) targetName = hit.target;
        const blocker = [hit.hit, hit.hit_id ? `#${hit.hit_id}` : ""].filter(Boolean).join("#") || "an unknown element";
        detail = ` Blocking element at (${Math.round(hit.x ?? 0)}, ${Math.round(hit.y ?? 0)}): ${blocker}.`;
      } catch { /* keep raw message */ }
    }
    return kruzError(ErrCode.ELEMENT_OBSCURED, {
      subsystem: opts.subsystem ?? "engine",
      message: `Target ${targetName}${detail || " is covered by another element"}.`,
      cause: err,
      trace: opts.trace,
    });
  }
  if (/ELEMENT_DISABLED/.test(raw)) {
    return kruzError(ErrCode.ELEMENT_DISABLED, { subsystem: opts.subsystem ?? "engine", message: "Target is disabled.", cause: err, trace: opts.trace });
  }
  if (/ELEMENT_NOT_VISIBLE/.test(raw)) {
    return kruzError(ErrCode.ELEMENT_NOT_VISIBLE, { subsystem: opts.subsystem ?? "engine", message: "Target is not visible.", cause: err, trace: opts.trace });
  }
  if (/Node is detached from (the )?DOM|Execution context was destroyed|Target closed|detached/i.test(raw)) {
    return kruzError(ErrCode.STALE_ELEMENT, { subsystem: opts.subsystem ?? "engine", message: "The element was detached mid-action (SPA re-render).", cause: err, trace: opts.trace });
  }
  if (/Element not found/i.test(raw)) {
    return kruzError(ErrCode.TARGET_NOT_FOUND, { subsystem: opts.subsystem ?? "engine", message: raw.replace(/^Error:\s*/, ""), cause: err, trace: opts.trace });
  }
  // A fill that was dispatched but did not stick. Must be matched BEFORE the
  // CLICK_FAILED default, which would otherwise claim an overlay caused it and
  // recommend force:true — wrong tool, wrong cause, wrong remedy.
  if (/Fill did not retain/i.test(raw)) {
    return kruzError(ErrCode.FILL_NOT_RETAINED, { subsystem: opts.subsystem ?? "engine", message: "The field accepted the input event but did not keep the value; a script handler likely rejected or transformed it.", cause: err, trace: opts.trace });
  }
  if (/Ambiguous target/i.test(raw)) {
    return kruzError(ErrCode.AMBIGUOUS_TARGET, { subsystem: opts.subsystem ?? "engine", message: "Multiple elements match this target across child frames.", cause: err, trace: opts.trace });
  }
  return kruzError(ErrCode.CLICK_FAILED, {
    subsystem: opts.subsystem ?? "engine",
    message: raw.replace(/^Error:\s*/, ""),
    cause: err,
    trace: opts.trace,
  });
}

/**
 * Central retry/fallback policy.
 *
 * Retry logic used to be duplicated inline at four sites (router click overlay
 * retry, openWithRetry, controller.type, controller.fill), each with its own
 * idea of which failures are transient and how long to wait. This is the one
 * place that decides: given a failure, is a bounded retry with escalation
 * (re-observe → dismiss overlays → force) worth attempting?
 *
 * `escalations` are attempted in order after the first attempt fails, so the
 * recovery ladder is declared at the call site and executed uniformly.
 */
export interface RetryStep {
  /** Stable id recorded on the error trace when this escalation ran. */
  name: string;
  /** Returns true if the action was retried (or the caller should retry). */
  run: () => Promise<boolean>;
}

export interface RetryPolicy {
  /** Only retry failures whose code is in this list. Empty = use isRetryableCode. */
  retryOn?: string[];
  /** Pause between attempts. */
  delayMs?: number;
  /** Ordered escalations attempted after a failure, before re-running the action. */
  escalations?: RetryStep[];
  /** Hard wall-clock budget for the whole recovery ladder (P1-D). Recovery stops
   *  once exceeded so a recoverable failure can never turn into a long stall. */
  budgetMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A structured controller failure: `{ok:false, error:{code,...}}` (P1-D). */
function structuredFailureCode(value: unknown): string | null {
  const v = value as any;
  if (v && typeof v === "object" && v.ok === false && v.error && typeof v.error.code === "string") return v.error.code;
  return null;
}

/**
 * Run `action`, applying `policy` on failure. Returns the first success.
 *
 * P1-D: failures may be THROWN errors OR structured `{ok:false, error}` results.
 * Previously only thrown errors triggered recovery, so the controller's normal
 * `{ok:false}` returns bypassed the intended escalation ladder entirely. Both shapes
 * are now classified the same way, and the whole ladder is bounded by `budgetMs`.
 */
export async function withRetry<T>(action: () => Promise<T>, policy: RetryPolicy = {}): Promise<T> {
  const attemptsFor = (code: string): boolean => {
    if (policy.retryOn?.length) return policy.retryOn.includes(code);
    return isRetryableCode(code);
  };
  const classify = (value: unknown): string | null => {
    const sc = structuredFailureCode(value);
    if (sc) return sc;
    if (value instanceof Error || typeof value === "string") return kruzErrorFromThrown(value).code;
    return null;
  };
  const started = Date.now();
  const overBudget = () => policy.budgetMs !== undefined && Date.now() - started >= policy.budgetMs;

  let last: unknown;
  try { last = await action(); } catch (err) { last = err; }

  let code = classify(last);
  if (!code) return last as T;                        // success
  if (!attemptsFor(code)) {                           // terminal — surface as-is
    if (last instanceof Error) throw kruzErrorFromThrown(last, { trace: ["retry"] });
    return last as T;
  }

  for (const step of policy.escalations ?? []) {
    if (overBudget()) break;
    try {
      if (await step.run()) {
        try {
          const r = await action();
          const c = classify(r);
          if (!c) return r;
          last = r; code = c;
          if (!attemptsFor(code)) return last as T;
        } catch (err) { last = err; }
      }
    } catch (err) { last = err; }
  }

  if (!overBudget() && policy.delayMs) await sleep(policy.delayMs);
  if (!overBudget()) {
    try {
      const r = await action();
      const c = classify(r);
      if (!c) return r;
      last = r;
    } catch (err) { last = err; }
  }

  // Surface the final failure with its true identity: a structured controller result
  // must keep its own code/help/retryability (P1-D). Converting it to a thrown error
  // made every recovered click report CLICK_FAILED — the exact code loss P1-D fixes.
  if (structuredFailureCode(last)) return last as T;
  throw kruzErrorFromThrown(last, { trace: ["retry:exhausted"] });
}