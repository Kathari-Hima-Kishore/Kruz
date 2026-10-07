/**
 * Visual control layer — a virtual cursor and a viewport "being controlled"
 * glow, so a human watching a headed session can see exactly what the agent
 * intends to do before it does it.
 *
 * Design constraints (each one exists because of a real failure mode):
 *
 *  1. The cursor is VISUAL ONLY. Real input is dispatched over CDP
 *     (Input.dispatchMouseEvent) so `isTrusted === true`. Dispatching synthetic
 *     MouseEvents from a content script yields `isTrusted: false`, which many
 *     sites and bot-mitigation vendors reject outright.
 *  2. Everything is `pointer-events: none`. A visible cursor that accepts hits
 *     becomes the topmost element at its own coordinates, which would make
 *     every click under it report as obscured.
 *  3. Everything lives in a closed shadow root on a `document.documentElement`
 *     child. Page CSS cannot reach it, and it survives `body` replacement.
 *  4. Injected over CDP, so it is independent of any page script or
 *     browser extension.
 *  5. `position: fixed; inset: 0` only — never `100vw`/`100vh`, which would
 *     introduce a scrollbar and shift layout.
 */

export type Point = { x: number; y: number };
export type ClickSpeed = "instant" | "fast" | "normal" | "slow";

/* ── path generation (pure, unit-tested) ─────────────────────────────────── */

const CURVE_STEPS: Record<ClickSpeed, number> = { instant: 1, fast: 10, normal: 22, slow: 40 };
const BASE_MS: Record<ClickSpeed, number> = { instant: 0, fast: 110, normal: 260, slow: 620 };

/** Deterministic PRNG so the visual and the trusted event stream share one path. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export interface PathOptions {
  speed?: ClickSpeed;
  seed?: number;
  /** Human jitter magnitude in px. */
  jitter?: number;
}

/**
 * Build a human-looking glide path from `from` to `to`.
 *
 * Real pointer travel is a curved, eased trajectory, not a straight line at
 * constant velocity. A single quadratic control point offset perpendicular to
 * the line, plus a light taper, reproduces the shape; the ease-out matches the
 * observed deceleration into the target. Bot-mitigation vendors measure
 * trajectory straightness and inter-event timing, so this is not cosmetic.
 */
export function computePath(from: Point, to: Point, opts: PathOptions = {}): Point[] {
  const speed = opts.speed ?? "normal";
  const steps = CURVE_STEPS[speed];
  if (steps <= 1) return [to];

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return [to];

  const rand = mulberry32(opts.seed ?? Math.round(from.x * 7919 + from.y * 104729 + to.x * 31 + to.y * 17));
  const jitter = opts.jitter ?? 4;
  // Perpendicular unit vector for the control-point bow.
  const nx = -dy / dist;
  const ny = dx / dist;
  // Bow scales with distance but stays small for near targets (a short hop is
  // essentially straight, which is what a human hand actually does).
  const bow = (rand() * 0.5 + 0.5) * Math.min(dist * 0.18, 60) * (rand() < 0.5 ? -1 : 1);
  const cx = (from.x + to.x) / 2 + nx * bow;
  const cy = (from.y + to.y) / 2 + ny * bow;

  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = easeOutCubic(t);
    // Quadratic Bezier through the bowed control point.
    const inv = 1 - e;
    let x = inv * inv * from.x + 2 * inv * e * cx + e * e * to.x;
    let y = inv * inv * from.y + 2 * inv * e * cy + e * e * to.y;
    // Taper the jitter to zero at the target so the click lands exactly.
    const taper = Math.sin(Math.PI * t);
    if (jitter > 0 && i < steps) {
      x += (rand() - 0.5) * 2 * jitter * taper;
      y += (rand() - 0.5) * 2 * jitter * taper;
    }
    out.push({ x, y });
  }
  out[out.length - 1] = { x: to.x, y: to.y };
  return out;
}

/**
 * Resample a path to exactly `n` points, preserving its shape.
 *
 * Used to honour an explicit step count on a drag. The curve comes from computePath
 * (human easing); only the density is changed, because "how many intermediate moves"
 * and "what the trajectory looks like" are independent decisions — some drag engines
 * refuse to start until the pointer has moved far enough, which is a count question.
 */
export function resamplePath(path: Point[], n: number): Point[] {
  if (path.length === 0) return path;
  if (n <= 1) return [path[path.length - 1]];
  if (n >= path.length) {
    // Subdivide each segment so a larger request still interpolates smoothly.
    const out: Point[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const segs = Math.max(1, Math.round((n - 1) / (path.length - 1)));
      for (let k = 0; k < segs; k++) {
        const t = k / segs;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    out.push(path[path.length - 1]);
    return out.slice(0, n);
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const idx = (i / (n - 1)) * (path.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, path.length - 1);
    const t = idx - lo;
    out.push({ x: path[lo].x + (path[hi].x - path[lo].x) * t, y: path[lo].y + (path[hi].y - path[lo].y) * t });
  }
  return out;
}

/** Total glide duration for a path. Long travel takes longer (Fitts's law). */
export function pathDurationMs(from: Point, to: Point, opts: PathOptions = {}): number {
  const speed = opts.speed ?? "normal";
  if (speed === "instant") return 0;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(1400, Math.max(BASE_MS[speed], dist * (speed === "fast" ? 0.18 : speed === "slow" ? 0.9 : 0.42)));
}

/** Per-step delay so the trusted event stream matches the visual animation. */
export function stepDelaysMs(path: Point[], opts: PathOptions = {}): number[] {
  const total = pathDurationMs(path[0] ?? { x: 0, y: 0 }, path[path.length - 1] ?? { x: 0, y: 0 }, opts);
  if (path.length <= 1 || total === 0) return path.map(() => 0);
  const each = total / path.length;
  return path.map(() => each);
}

/* ── injected page script ───────────────────────────────────────────────── */

/**
 * Idempotent installer. Safe to call on every navigation.
 *
 * Exposes `window.__kruzVisual` with:
 *   ping()         REALTIME control heartbeat (see below) — extends the window
 *   setPos(x, y)   move the virtual cursor
 *   press(active)  toggle the pressed state
 *   ripple()       play the click ring
 *   setStatus(text|null)  update the corner chip
 *   destroy()      remove everything
 *
 * REALTIME CONTRACT (ping + idle watchdog):
 *   The router calls `ping()` continuously while a tool call is in flight. The
 *   overlay is visible if and only if a ping arrived within `IDLE_MS`. A page-side
 *   `setInterval` watchdog re-checks that deadline every ~50 ms, so the moment the
 *   model stops acting, sends no more pings, or is busy deciding what to do next,
 *   the overlay turns itself off — no server round-trip and no dependence on the
 *   Node process being alive. It also means a stalled/crashed client can never
 *   leave the overlay stuck on.
 */
export function visualLayerScript(): string {
  return `(() => {
  if (window.__kruzVisual) return 'already';
  const NS = 'kruz-visual';
  // A ping is valid for this long. The router pings every ~200 ms while acting.
  const IDLE_MS = 650;
  // No ping for this long means the turn has ended and a human is expected, so the
  // banner switches from "Model is thinking" to "Input needed on Browser/TUI".
  // Generous on purpose: a model can legitimately think between tool calls, and a
  // false "input needed" is worse than a slightly late one. An explicit
  // session.pause / human.takeover switches immediately.
  const AWAIT_MS = 20000;
  const host = document.createElement('div');
  host.setAttribute('data-kruz', 'control');
  // position:fixed + inset:0 → viewport-sized, never affects layout or scrollbars.
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = \`
    <style>
      :host { all: initial; }
      * { margin:0; padding:0; box-sizing:border-box; }
      .glow {
        position:fixed; inset:0; pointer-events:none;
        box-shadow: inset 0 0 0 3px rgba(37,99,235,.95),
                    inset 0 0 26px 4px rgba(59,130,246,.55),
                    inset 0 0 80px 12px rgba(37,99,235,.35),
                    inset 0 30px 52px -18px rgba(37,99,235,.6);
        transition: box-shadow .25s ease;
      }
      .glow.pulse { animation: kpulse 2s ease-in-out infinite; }
      @keyframes kpulse {
        0%,100% { box-shadow: inset 0 0 0 3px rgba(37,99,235,.95), inset 0 0 26px 4px rgba(59,130,246,.55), inset 0 0 80px 12px rgba(37,99,235,.35), inset 0 30px 52px -18px rgba(37,99,235,.6); }
        50%     { box-shadow: inset 0 0 0 5px rgba(59,130,246,1), inset 0 0 34px 6px rgba(147,197,253,.75), inset 0 0 110px 20px rgba(37,99,235,.45), inset 0 34px 58px -16px rgba(59,130,246,.75); }
      }
      .dot { width:8px; height:8px; border-radius:50%; background:#3b82f6; box-shadow:0 0 10px #3b82f6; }
      .dot.thinking { background:#facc15; box-shadow:0 0 10px #facc15; }
      .dot.awaiting { background:#e5e7eb; box-shadow:0 0 8px #9ca3af; }
      /* State 2 — model is thinking, not driving the browser. Amber, no pulse:
         the page is still the user's, but Kruz is mid-task and may act again. */
      .glow.thinking {
        box-shadow: inset 0 0 0 3px rgba(234,179,8,.9),
                    inset 0 0 26px 4px rgba(250,204,21,.45),
                    inset 0 0 80px 12px rgba(202,138,4,.28);
      }
      /* State 3 — waiting on a human. Deliberately NO glow: the absence of colour
         is the signal that the page is unattended and needs input. */
      .glow.awaiting { display:none !important; }
      .cur {
        position:fixed; top:0; left:0; width:0; height:0;
        transform:translate3d(-100px,-100px,0);
        will-change: transform; pointer-events:none;
      }
      .cur .ring {
        position:absolute; left:-9px; top:-9px; width:18px; height:18px;
        border-radius:50%; border:2px solid rgba(56,189,248,.95);
        box-shadow:0 0 10px rgba(56,189,248,.5);
        transition: transform .09s ease-out, opacity .25s ease;
      }
      .cur .core {
        position:absolute; left:-2.5px; top:-2.5px; width:5px; height:5px;
        border-radius:50%; background:#38bdf8; box-shadow:0 0 6px #38bdf8;
      }
      .cur.pressed .ring { transform:scale(.55); opacity:.85; }
      .cur .wave {
        position:absolute; left:-9px; top:-9px; width:18px; height:18px;
        border-radius:50%; border:2px solid rgba(56,189,248,.8);
        opacity:0; pointer-events:none;
      }
      .cur.ripple .wave { animation: kripple .5s ease-out; }
      @keyframes kripple {
        from { transform:scale(.4); opacity:.85; }
        to   { transform:scale(3.1); opacity:0; }
      }
      .cur { transition: opacity .12s ease; }
      .cur.hidden { opacity:0; }
      @media (prefers-reduced-motion: reduce) {
        .glow.pulse { animation:none; }
        .cur .ring, .cur .wave { transition:none; }
        .cur.ripple .wave { animation:none; }
      }
    </style>
    <div class="glow pulse" style="display:none"></div>
    <div class="cur hidden"><div class="wave"></div><div class="ring"></div><div class="core"></div></div>\`;

  // Takeover banner lives in LIGHT DOM (not the closed shadow): the user must
  // be able to click Takeover/Resume, tests must reach the buttons, and
  // assistive tech must see them. all:initial + inline styles isolate it.
  //
  // Positioned TOP-LEFT on request: it used to sit top-centre, where it covered
  // page chrome (search bars, primary nav) and moved as the viewport resized.
  // Top-left is out of the way of page headers on most sites and gives the three
  // states one stable, predictable anchor.
  const bubble = document.createElement('div');
  bubble.setAttribute('data-kruz', 'bubble');
  bubble.style.cssText = 'all:initial;position:fixed;top:10px;left:10px;z-index:2147483646;pointer-events:none;display:none;';
  const PILL_CSS = 'display:flex;align-items:center;gap:8px;font:700 12.5px/1 ui-sans-serif,system-ui,sans-serif;color:#ffffff;background:linear-gradient(180deg,#2563eb,#1d4ed8);border:1px solid rgba(147,197,253,.95);border-radius:999px;padding:8px 14px;letter-spacing:.2px;white-space:nowrap;box-shadow:0 4px 18px rgba(29,78,216,.55),0 0 0 1px rgba(255,255,255,.12) inset;';
  const DOT_CSS = 'width:8px;height:8px;border-radius:50%;background:#bfdbfe;box-shadow:0 0 10px #93c5fd;flex:none;';

  // Attach to <html>, never to the Document itself.
  //
  // evaluateOnNewDocument runs on a brand-new document where documentElement is
  // still null. Appending a host straight to the Document in that window (as an
  // earlier "documentElement || document" fallback did) inserts a div as a
  // Document child before the parser creates <html>, and Chrome then treats that
  // div as the documentElement - leaving the page with no <head> and no <body>,
  // so querySelectorAll('button') returns nothing and the agent sees an empty
  // page. Wait for the real root instead.
  const attach = () => {
    const parent = document.documentElement;
    if (parent && parent.appendChild) { parent.appendChild(host); parent.appendChild(bubble); return true; }
    return false;
  };
  if (!attach()) {
    const onReady = () => { if (!host.isConnected) attach(); };
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
    // Belt and braces: documentElement may appear without DOMContentLoaded when
    // a document is parsed as a fragment (SPA shell, bfcache restore).
    try {
      const obs = new MutationObserver(() => { if (host.isConnected) obs.disconnect(); else attach(); });
      obs.observe(document, { childList: true });
    } catch { /* observer unavailable — DOMContentLoaded is enough */ }
  }

  const cur = root.querySelector('.cur');
  const glow = root.querySelector('.glow');
  const at = { x: -100, y: -100 };
  const paint = () => { cur.style.transform = 'translate3d(' + at.x + 'px,' + at.y + 'px,0)'; };

  let pressTimer = 0;

  // ── Model-control lock ───────────────────────────────────────────
  // One rule: WHILE the blue overlay is alive the model is in control, and the
  // page accepts no input from anyone else. While the overlay is gone (model
  // idle) the page is fully interactive again — no lock, no listeners.
  //
  // How that is enforced: the overlay host is pointer-events:none, so
  // hit-testing is untouched. Input is blocked instead by capture-phase
  // listeners that cancel every event EXCEPT the model's own input, which
  // always arrives inside a dispatch window (__kruzExpectingInput, opened by
  // the engine for the whole duration of a click/key/fill) or with the
  // synthesized-input bypass flag (__kruzAutomationBypass).
  //
  // Visibility itself is heartbeat-driven: see the realtime lifecycle below.
  const LOCK_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'keyup', 'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart'];
  let lockOn = false;
  const lockHandler = (e) => {
    if (!lockOn) return;
    try {
      if (window.__kruzExpectingInput) return;   // the model's own dispatch
      if (window.__kruzAutomationBypass) return; // the model's own synthesized input
    } catch (err) {}
    try { if (e.cancelable) e.preventDefault(); } catch (err) {}
    try { e.stopPropagation(); } catch (err) {}
    try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (err) {}
  };
  const setLockListeners = (on) => {
    const doc = document.documentElement || document;
    for (const type of LOCK_EVENTS) {
      try {
        if (on) doc.addEventListener(type, lockHandler, { capture: true, passive: false });
        else doc.removeEventListener(type, lockHandler, { capture: true });
      } catch (err) {}
    }
  };
  /**
   * Self-heal: a same-document replacement (document.open/write/close, which
   * bfcache restores and same-document navigations both perform) keeps the same
   * window — so the API object survives but the nodes appended to
   * documentElement are discarded. Re-attach them (the closed shadow tree
   * travels with the node) instead of silently losing the overlay.
   */
  const ensureAttached = () => {
    const parent = document.documentElement;
    if (!parent) return false;
    try { if (!host.isConnected) parent.appendChild(host); } catch (err) {}
    try { if (!bubble.isConnected) parent.appendChild(bubble); } catch (err) {}
    return host.isConnected && bubble.isConnected;
  };
  /**
   * Status text per state. Kept here so the banner and the glow cannot drift.
   */
  const MODE_TEXT = {
    controlling: 'Controlled by Kruz',
    thinking: 'Model is thinking',
    awaiting: 'Input needed on Browser/TUI',
  };

  const showStatus = (text, state) => {
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
    const pill = document.createElement('div');
    pill.style.cssText = PILL_CSS;
    const dot = document.createElement('span');
    dot.style.cssText = DOT_CSS;
    if (state === 'thinking') dot.classList.add('thinking');
    if (state === 'awaiting') dot.classList.add('awaiting');
    pill.appendChild(dot);
    const txt = document.createElement('span'); txt.setAttribute('data-kruz-text', '1'); txt.textContent = text;
    pill.appendChild(txt);
    bubble.appendChild(pill);
    bubble.style.display = 'block';
  };

  // ── Realtime overlay lifecycle ────────────────────────────────────
  // Two clocks, because they answer two different questions:
  //
  //   lastPing     "is a tool call in flight RIGHT NOW?"  -> controlling (blue)
  //   lastEngaged  "did the model do anything recently?"   -> thinking (amber)
  //
  // Three states:
  //
  //   controlling  blue glow    a call is in flight (ping within IDLE_MS)
  //   thinking     amber glow   nothing in flight, but the model engaged within
  //                             AWAIT_MS, so it is mid-task and may act again
  //   awaiting     no glow      either declared (session.pause / human.takeover)
  //                             or quiet for AWAIT_MS, meaning the turn has ended
  //                             and a human is expected
  //
  // Two decisions worth spelling out:
  //
  //  - The banner is ALWAYS visible; only the glow changes. The glow keeps its
  //    meaning as the input-lock indicator, so the page is freely interactive in
  //    thinking and awaiting.
  //  - The explicit "awaiting" flag is sticky until a ping, because pause and
  //    takeover are declarations of intent, not states that should lapse. The
  //    "thinking" case is NOT sticky: it is a deadline on lastEngaged, so a page
  //    that has been quiet for AWAIT_MS auto-promotes to awaiting. Without that,
  //    session.resume would show "Model is thinking" forever and the very TUI
  //    case this banner exists for (model stopped, waiting for input) could never
  //    happen on its own.
  let lastPing = 0;
  let lastEngaged = 0;
  let mode = 'controlling';
  let explicitAwaiting = false;
  let visible = false;
  let watchdog = 0;

  const applyMode = (next) => {
    // tick() runs every 50ms. Rebuilding the banner node on every tick would
    // churn the DOM 20x/second for a ~12-char text change, so act only on an
    // actual state transition (plus the one forced first paint).
    const changed = next !== mode;
    if (!changed && bubble.style.display === 'block') return;
    mode = next;
    const locked = next === 'controlling';
    if (changed) { visible = locked; lockOn = locked; setLockListeners(locked); }
    if (glow) {
      glow.classList.toggle('thinking', next === 'thinking');
      glow.classList.toggle('awaiting', next === 'awaiting');
      // the pulse animation drives a blue box-shadow, so it must not fight the
      // amber state; pulse is re-enabled only while controlling.
      glow.classList.toggle('pulse', next === 'controlling');
      glow.style.display = next === 'awaiting' ? 'none' : '';
    }
    if (cur) cur.classList.toggle('hidden', next !== 'controlling');
    showStatus(MODE_TEXT[next] ?? MODE_TEXT.thinking, next);
  };

  const tick = () => {
    try {
      const now = Date.now();
      const pingAge = lastPing ? now - lastPing : Infinity;
      const quietFor = lastEngaged ? now - lastEngaged : Infinity;
      // Order matters: a call in flight wins over everything, an explicit
      // pause/takeover wins over inference, and only then is it inferred.
      if (pingAge <= IDLE_MS) applyMode('controlling');
      else if (explicitAwaiting) applyMode('awaiting');
      else if (quietFor <= AWAIT_MS) applyMode('thinking');
      else applyMode('awaiting');
    } catch (err) {}
  };
  const startWatchdog = () => {
    if (watchdog) return;
    try { watchdog = setInterval(tick, 50); } catch (err) { watchdog = 0; }
  };

  const api = {
    /**
     * REALTIME heartbeat. Call continuously while the model is acting; the
     * overlay stays on for IDLE_MS after the last ping and turns itself off.
     */
    ping() {
      const now = Date.now();
      lastPing = now;
      lastEngaged = now;
      // A ping clears any explicit "awaiting" claim — otherwise the page would be
      // stuck on "Input needed" forever after session.pause, because tick() gives
      // explicitAwaiting priority over the activity it just recorded.
      explicitAwaiting = false;
      ensureAttached();
      startWatchdog();
      tick();
      return true;
    },
    setPos(x, y) {
      at.x = x; at.y = y; paint();
      if (cur) cur.classList.remove('hidden');
      return true;
    },
    getPos() { return { x: at.x, y: at.y }; },
    press(active) {
      clearTimeout(pressTimer);
      if (active) cur.classList.add('pressed');
      else { cur.classList.remove('pressed'); pressTimer = setTimeout(() => cur.classList.remove('pressed'), 90); }
      return true;
    },
    ripple() {
      cur.classList.remove('ripple');
      void cur.offsetWidth; // restart the animation
      cur.classList.add('ripple');
      return true;
    },
    setStatus(text) {
      if (text == null) { bubble.style.display = 'none'; return true; }
      const t = bubble.querySelector('[data-kruz-text]');
      if (t) t.textContent = text;
      bubble.style.display = 'block';
      return true;
    },
    setGlow(active) { if (glow) glow.style.display = active === false ? 'none' : ''; return true; },
    /**
     * Set the banner state explicitly. awaiting is the one a caller normally
     * needs - it is how session.pause / human.takeover announce that a human is
     * required. Passing thinking or controlling clears the explicit flag so the
     * watchdog resumes driving the state from activity.
     */
    setMode(next) {
      ensureAttached();
      if (next === 'awaiting') {
        explicitAwaiting = true;
      } else if (next === 'controlling') {
        explicitAwaiting = false;
        lastPing = lastEngaged = Date.now();
      } else {
        // thinking: the model holds the page but is not mid-action. Marking it
        // ENGAGED (not pinged) is what puts it in the amber state instead of
        // blue, and restarts the AWAIT_MS window that will later promote it to
        // awaiting on its own.
        explicitAwaiting = false;
        lastEngaged = Date.now();
      }
      startWatchdog();
      tick();
      return true;
    },
    /** Current banner state: 'controlling' | 'thinking' | 'awaiting'. */
    getMode() { return mode; },
    /**
     * Explicit toggle (sessions, pause/resume). true pings now; false marks the
     * page as awaiting a human, so the banner says so instead of going blank.
     */
    setLock(on) {
      ensureAttached();
      const next = on === true;
      if (next) { explicitAwaiting = false; lastPing = Date.now(); startWatchdog(); }
      else { explicitAwaiting = true; }
      tick();
      return true;
    },
    /** Diagnostic: is Kruz actively driving (glow up, input locked)? */
    isLocked() { return mode === 'controlling'; },
    /** Diagnostic: who owns the page right now. */
    owner() { return mode === 'controlling' ? 'model' : 'idle'; },
    /**
     * Diagnostic read-out of everything the three states depend on. The glow
     * lives in a CLOSED shadow root, so neither page scripts nor a harness can
     * otherwise see whether the amber ring or the "no glow" rule is in effect —
     * only the mode itself is reachable from outside. Tests assert on this.
     */
    snapshot() {
      const r = bubble.getBoundingClientRect();
      return {
        mode,
        locked: mode === 'controlling',
        explicit_awaiting: !!explicitAwaiting,
        ping_age_ms: lastPing ? Date.now() - lastPing : null,
        quiet_ms: lastEngaged ? Date.now() - lastEngaged : null,
        banner_text: (bubble.querySelector('[data-kruz-text]') || {}).textContent || null,
        banner_display: bubble.style.display || 'none',
        banner_top: r.top,
        banner_left: r.left,
        glow_classes: glow ? String(glow.className) : null,
        glow_display: glow ? (glow.style.display || 'inline') : null,
        idle_ms: IDLE_MS,
        await_ms: AWAIT_MS,
      };
    },
    destroy() {
      try { if (watchdog) clearInterval(watchdog); } catch (err) {}
      watchdog = 0;
      try { host.remove(); } catch (e) {}
      try { bubble.remove(); } catch (e) {}
      try { delete window.__kruzVisual; } catch (e) {}
      return true;
    },
  };
  Object.defineProperty(window, '__kruzVisual', { value: api, configurable: true, writable: true });
  // Cold start: no ping has ever arrived, so Kruz is not driving and blue would
  // be a lie — but showing nothing is worse than showing something. The model has
  // just created this session and is working out what to do, which is "thinking";
  // if nothing pings within AWAIT_MS it promotes itself to awaiting. A ping (the
  // next action) promotes it to controlling.
  lastEngaged = Date.now();
  explicitAwaiting = false;
  applyMode('thinking');
  return 'ok';
})()`;
}
