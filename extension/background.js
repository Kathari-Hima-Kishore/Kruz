// Kruz Ctrl Extension Background Service Worker
// Handles communication between Kruz MCP and the browser extension.
// Provides bot evasion, DOM access, and live observation capabilities.

const KRUZ_VERSION = "1.0.0";
const KRUZ_NAME = "Kruz Ctrl";

// Track active connections from Kruz MCP server
const activePorts = new Map();

/**
 * Initialize the extension service worker
 */
self.addEventListener('install', (event) => {
  console.log(`[${KRUZ_NAME}] Service worker installed`);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log(`[${KRUZ_NAME}] Service worker activated`);
  event.waitUntil(clients.claim());
});

// Handle connection from Kruz MCP server
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'kruz-extension') return;

  console.log(`[${KRUZ_NAME}] Kruz connected`);
  const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activePorts.set(connectionId, port);

  // Send initial ready signal
  port.postMessage({
    type: 'extension_ready',
    name: KRUZ_NAME,
    version: KRUZ_VERSION,
    connectionId,
    capabilities: [
      'bot-detection-evasion',
      'shadow-dom-piercing',
      'live-dom-observation',
      'persistent-sessions',
      'mcp-integration'
    ]
  });

  port.onMessage.addListener(async (message) => {
    try {
      const response = await handleKruzMessage(message);
      port.postMessage({ id: message.id, ...response });
    } catch (err) {
      console.error(`[${KRUZ_NAME}] Error handling message:`, err);
      port.postMessage({
        id: message.id,
        ok: false,
        error: String(err)
      });
    }
  });

  port.onDisconnect.addListener(() => {
    console.log(`[${KRUZ_NAME}] Kruz disconnected`);
    activePorts.delete(connectionId);
  });
});

/**
 * Route incoming Kruz messages to the appropriate handler
 */
async function handleKruzMessage(message) {
  const { method, params = {} } = message;

  switch (method) {
    case 'ping':
      return { ok: true, result: { name: KRUZ_NAME, version: KRUZ_VERSION } };

    case 'executeScript':
      return await executeInActiveTab(params);

    case 'getActiveTab':
      return await getActiveTabInfo();

    case 'patchNavigator':
      return await patchNavigator(params);

    case 'setupMutationObserver':
      return await setupMutationObserver(params);

    case 'getTabs':
      return await listTabs();

    case 'getCookies':
      return await getCookies(params);

    case 'setCookie':
      return await setCookie(params);

    default:
      return { ok: false, error: `Unknown method: ${method}` };
  }
}

/**
 * Execute JavaScript in the active tab with bot evasion
 */
async function executeInActiveTab(params) {
  const { code, allFrames = false } = params;
  try {
    const tab = await getActiveTab();
    if (!tab) return { ok: false, error: 'No active tab' };

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames },
      func: (code) => {
        try {
          // Wrap in IIFE and return result
          const result = (0, eval)(code);
          return { ok: true, result };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      args: [code],
      world: 'MAIN'
    });

    if (chrome.runtime.lastError) {
      return { ok: false, error: chrome.runtime.lastError.message };
    }

    // Combine results from all frames
    const combined = results.map(r => r.result);
    return {
      ok: true,
      result: combined.length === 1 ? combined[0] : combined
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Get information about the active tab
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getActiveTabInfo() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'No active tab' };
  return { ok: true, result: { id: tab.id, url: tab.url, title: tab.title } };
}

/**
 * Patch navigator properties in the active tab to evade bot detection
 */
async function patchNavigator(params) {
  const { patches } = params;
  try {
    const tab = await getActiveTab();
    if (!tab) return { ok: false, error: 'No active tab' };

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (patches) => {
        const results = {};
        for (const [key, value] of Object.entries(patches)) {
          try {
            if (key === 'navigator.webdriver') {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => value,
                configurable: true
              });
              results[key] = 'patched';
            } else if (key === 'navigator.plugins') {
              Object.defineProperty(navigator, 'plugins', {
                get: () => value,
                configurable: true
              });
              results[key] = 'patched';
            } else if (key === 'navigator.languages') {
              Object.defineProperty(navigator, 'languages', {
                get: () => value,
                configurable: true
              });
              results[key] = 'patched';
            } else if (key === 'window.chrome') {
              Object.defineProperty(window, 'chrome', {
                get: () => value,
                configurable: true
              });
              results[key] = 'patched';
            } else {
              results[key] = 'unknown_key';
            }
          } catch (e) {
            results[key] = `error: ${String(e)}`;
          }
        }
        return results;
      },
      args: [patches],
      world: 'MAIN'
    });

    if (chrome.runtime.lastError) {
      return { ok: false, error: chrome.runtime.lastError.message };
    }

    return { ok: true, result: results[0]?.result || results };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Set up a MutationObserver in the active tab and stream updates to Kruz
 */
async function setupMutationObserver(params) {
  const { options = {} } = params;
  try {
    const tab = await getActiveTab();
    if (!tab) return { ok: false, error: 'No active tab' };

    // Inject the observer setup script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (opts) => {
        // Create or reuse the observer
        if (!window.__kruzObserver) {
          const updateQueue = [];
          const listeners = [];

          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              updateQueue.push({
                type: m.type,
                target: m.target.nodeName,
                timestamp: Date.now(),
                addedNodes: m.addedNodes.length,
                removedNodes: m.removedNodes.length,
                attributeName: m.attributeName
              });
            }

            // Flush to listeners every 100ms (debounced)
            if (updateQueue.length > 0) {
              const batch = updateQueue.splice(0);
              listeners.forEach(cb => {
                try { cb(batch); } catch (e) { /* ignore */ }
              });
            }
          });

          observer.observe(document.documentElement, {
            childList: opts.childList !== false,
            subtree: opts.subtree !== false,
            attributes: opts.attributes !== false,
            characterData: opts.characterData !== false,
            attributeOldValue: opts.attributeOldValue === true,
            characterDataOldValue: opts.characterDataOldValue === true
          });

          window.__kruzObserver = observer;
          window.__kruzObserverListeners = listeners;
          window.__kruzObserverQueue = updateQueue;

          console.log('[Kruz Ctrl] MutationObserver installed');
        }
        return { ok: true, active: !!window.__kruzObserver };
      },
      args: [options],
      world: 'MAIN'
    });

    return { ok: true, result: { observerActive: true } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * List all open tabs
 */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    result: tabs.map(t => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId
    }))
  };
}

/**
 * Get cookies for a domain
 */
async function getCookies(params) {
  const { domain } = params;
  try {
    const cookies = await chrome.cookies.getAll({ domain });
    return { ok: true, result: cookies };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Set a cookie
 */
async function setCookie(params) {
  const { url, name, value, domain, path = '/' } = params;
  try {
    await chrome.cookies.set({ url, name, value, domain, path });
    return { ok: true, result: { name, value, domain, path } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Handle extension lifecycle
chrome.runtime.onStartup.addListener(() => {
  console.log(`[${KRUZ_NAME}] Browser started`);
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[${KRUZ_NAME}] Extension installed:`, details.reason);
});
