// Kruz Ctrl Extension Content Script
// Runs at document_start in the MAIN world. Patches navigator for bot evasion,
// installs a MutationObserver for live DOM observation, and exposes the Kruz
// API on window.__kruz__ for BrowserController to call via page.evaluate.

(function () {
  'use strict';

  // Guard against re-injection on history navigations
  if (window.__kruz_ctrl_loaded__) return;
  Object.defineProperty(window, '__kruz_ctrl_loaded__', {
    value: true, configurable: false, writable: false,
  });

  // ─── Bot detection evasion ─────────────────────────────────────────
  // Patch navigator.webdriver — most sites check this first.
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) { /* ignore */ }

  // Patch navigator.plugins so we look like a real browser
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const fake = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', length: 2 },
        ];
        fake.item = i => fake[i] || null;
        fake.namedItem = n => fake.find(p => p.name === n) || null;
        fake.refresh = () => {};
        return fake;
      },
      configurable: true,
    });
  }

  // Patch navigator.languages
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  }

  // Patch permissions API
  if (navigator.permissions && navigator.permissions.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return origQuery(params);
    };
  }

  // Patch chrome.runtime to look installed
  if (window.chrome && !window.chrome.runtime) {
    window.chrome.runtime = { connect: () => ({ onMessage: { addListener: () => {} } }) };
  }

  // Patch WebGL vendor/renderer to avoid headless fingerprint
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return origGetParameter.call(this, param);
    };
  } catch (_) { /* WebGL may not be present */ }

  // ─── Live DOM observation (MutationObserver) ───────────────────────
  // Cheap by design: attribute observation is restricted to visibility-relevant
  // attributes (class/style/disabled/hidden) so SPA re-renders don't flood the
  // message channel; flush throttled to 250ms; buffer capped to avoid backlog
  // on fast-mutating portals (Workday/Oracle HCM grids).
  const updateBuffer = [];
  let flushTimer = null;
  const FLUSH_MS = 250;
  const MAX_BUFFER = 200;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (updateBuffer.length === 0) return;
      const batch = updateBuffer.splice(0, updateBuffer.length);
      window.postMessage({ type: '__kruz_dom_update__', updates: batch }, '*');
    }, FLUSH_MS);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        updateBuffer.push({
          kind: 'childList',
          added: m.addedNodes.length,
          removed: m.removedNodes.length,
          target: m.target.nodeName,
          ts: Date.now(),
        });
      } else if (m.type === 'attributes') {
        updateBuffer.push({
          kind: 'attributes',
          attr: m.attributeName,
          target: m.target.nodeName,
          ts: Date.now(),
        });
      }
    }
    if (updateBuffer.length < MAX_BUFFER) scheduleFlush();
    else flushTimer && clearTimeout(flushTimer), flushTimer = null,
      window.postMessage({ type: '__kruz_dom_update__', updates: updateBuffer.splice(0) }, '*');
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    // Visibility-relevant attributes only — a full attribute watch on a
    // 10k-node SPA grid is the single biggest content-script overhead.
    attributes: true,
    attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden'],
    characterData: false,
    attributeOldValue: false,
  });

  // ─── Kruz API ──────────────────────────────────────────────────────
  // Selector helpers
  function fastQuery(root, selector) {
    try { return root.querySelector(selector); } catch (_) { return null; }
  }

  function deepQuery(root, selector) {
    // Fast path first: 99% of portal elements live in the main document, and a
    // plain querySelector is O(selector) instead of the O(n) BFS below. Only
    // pay for shadow-piercing BFS when the fast path misses.
    const fast = fastQuery(root, selector);
    if (fast) return fast;
    // BFS across shadow roots for closed piercing
    const seen = new Set();
    const queue = [root];
    while (queue.length) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      let hit = null;
      try { hit = node.querySelector(selector); } catch (_) { continue; }
      if (hit) return hit;
      // Descend into shadow roots
      if (node.shadowRoot) queue.push(node.shadowRoot);
      // Descend into iframes
      if (node.tagName === 'IFRAME') {
        try {
          const doc = node.contentDocument;
          if (doc && doc.documentElement) queue.push(doc.documentElement);
        } catch (_) { /* cross-origin */ }
      }
      // Descend into children
      if (node.children) {
        for (const c of node.children) queue.push(c);
      }
    }
    return null;
  }

  function describe(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.className && typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean)
        : [],
      text: (el.textContent || '').trim().slice(0, 200),
      visible: rect.width > 0 && rect.height > 0,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      attrs: el.getAttributeNames ? Object.fromEntries(
        el.getAttributeNames().map(n => [n, el.getAttribute(n)])
      ) : {},
    };
  }

  // The API Kruz calls via page.evaluate(() => window.__kruz__.method(...))
  const api = {
    // === Read ===
    ping() { return { ok: true, version: '1.0.0', name: 'Kruz Ctrl' }; },

    queryOne(selector, opts = {}) {
      const root = opts.scope
        ? (typeof opts.scope === 'string' ? document.querySelector(opts.scope) : opts.scope)
        : document;
      const el = root ? deepQuery(root, selector) : null;
      return { ok: !!el, element: el ? describe(el) : null };
    },

    queryAll(selector, opts = {}) {
      const root = opts.scope
        ? (typeof opts.scope === 'string' ? document.querySelector(opts.scope) : opts.scope)
        : document;
      if (!root) return { ok: true, count: 0, elements: [] };
      const startNode = root;
      const results = [];
      const seen = new Set();
      const matched = new Set();
      const limit = opts.limit ?? 100;
      const queue = [startNode];
      while (queue.length && results.length < limit) {
        const node = queue.shift();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        let hits = [];
        try { hits = Array.from(node.querySelectorAll(selector)); } catch (_) { continue; }
        for (const h of hits) {
          if (matched.has(h)) continue;
          matched.add(h);
          results.push(describe(h));
          if (results.length >= limit) break;
        }
        if (node.shadowRoot) queue.push(node.shadowRoot);
        if (node.children) for (const c of node.children) queue.push(c);
      }
      return { ok: true, count: results.length, elements: results };
    },

    // === Write ===

    // Synthetic MAIN-world events for page listeners. dispatchEvent does not
    // create trusted input (isTrusted remains false). Scroll instantly first.
    click(selector, opts = {}) {
      const el = deepQuery(document, selector);
      if (!el) return { ok: false, error: 'Element not found' };
      try {
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
        el.dispatchEvent(new PointerEvent('pointerover', base));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
        el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
        el.focus && el.focus({ preventScroll: true });
        el.dispatchEvent(new PointerEvent('pointerup', base));
        el.dispatchEvent(new MouseEvent('mouseup', base));
        el.dispatchEvent(new MouseEvent('click', base));
        return { ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    fill(selector, value, opts = {}) {
      const el = deepQuery(document, selector);
      if (!el) return { ok: false, error: 'Element not found' };
      try {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    type(selector, text, opts = {}) {
      const el = deepQuery(document, selector);
      if (!el) return { ok: false, error: 'Element not found' };
      try {
        el.focus();
        for (const ch of text) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
          const v = el.value || '';
          const setter = Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
            'value'
          )?.set;
          if (setter) setter.call(el, v + ch); else el.value = v + ch;
          el.dispatchEvent(new InputEvent('input', { data: ch, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        }
        return { ok: true, value: el.value };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },

    hover(selector) {
      const el = deepQuery(document, selector);
      if (!el) return { ok: false, error: 'Element not found' };
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
      }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return { ok: true };
    },

    scrollIntoView(selector) {
      const el = deepQuery(document, selector);
      if (!el) return { ok: false, error: 'Element not found' };
      // behavior:'auto' — instant and deterministic. 'smooth' runs an async
      // animation that never settles inside automation wait windows, causing
      // follow-up clicks to land mid-scroll (wrong element).
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { ok: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    },

    boundingBox(selector) {
      const el = deepQuery(document, selector);
      if (!el) return { ok: false, error: 'Element not found' };
      const r = el.getBoundingClientRect();
      return { ok: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    },

    // === Read DOM ===
    text(selector) {
      const el = deepQuery(document, selector);
      return { ok: !!el, text: el ? (el.textContent || '').trim() : null };
    },

    attr(selector, name) {
      const el = deepQuery(document, selector);
      return { ok: !!el, value: el ? el.getAttribute(name) : null };
    },

    exists(selector) { return { ok: true, found: !!deepQuery(document, selector) }; },

    // === Shadow DOM piercing (Kruz Ctrl exclusive) ===
    pierce(selector) {
      const el = deepQuery(document, selector);
      return { ok: !!el, element: el ? describe(el) : null };
    },
  };

  Object.defineProperty(window, '__kruz__', { value: api, writable: false, configurable: false });
  // Legacy alias — the engine falls back to this if window.__kruz__ is missing
  Object.defineProperty(window, '__kruz_api__', { value: api, writable: false, configurable: false });

  // Signal readiness so ExtensionEngine.waitForPortal() can resolve
  window.__kruz_extension_ready__ = true;
  window.postMessage({ type: '__kruz_extension_ready__' }, '*');
  console.log('[Kruz Ctrl] Content script ready — bot evasion active, MutationObserver live.');
})();
