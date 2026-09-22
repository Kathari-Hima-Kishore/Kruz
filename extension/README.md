# Kruz Ctrl — MV3 Browser Extension

Companion extension for the **Kruz** MCP browser automation server. Provides:

- **Bot detection evasion** — patches `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, permissions API, and WebGL vendor/renderer so JS-heavy ATS portals don't fingerprint Kruz.
- **Shadow DOM piercing** — `window.__kruz__.pierce()` walks shadow roots and iframes to find elements that `document.querySelector` can't see.
- **Live DOM observation** — MutationObserver on the document root streams `{type, target, added, removed, attr, ts}` batches back to the Kruz controller every 100 ms.
- **Persistent sessions** — runs in the `MAIN` world, so cookies and `localStorage` are tied to the user's Chrome profile, not a fresh context.

## Install (Unpacked)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select this `extension/` folder
5. The extension appears as **"Kruz Ctrl"** with the K logo

## File layout

```
extension/
├── manifest.json       MV3 manifest (name: "Kruz Ctrl")
├── background.js       Service worker — bridges tabs ↔ Kruz MCP
├── content.js          MAIN-world content script — patches + API
├── popup.html          Toolbar popup with status indicator
├── icons/
│   ├── icon.svg        Source vector
│   ├── icon16.png      (generated)
│   ├── icon48.png      (generated)
│   └── icon128.png     (generated)
└── build-icons.mjs     Generates PNGs from SVG via `sharp`
```

## Generate PNG icons

```bash
npm install -D sharp
node extension/build-icons.mjs
```

If `sharp` isn't installed, Chrome will still load the extension using the SVG as a fallback for some cases, but PNG icons are recommended.

## How Kruz detects the extension

`extension-engine.ts` waits for `window.__kruz_extension_ready__` to be set on every new page. The content script sets it on first execution. Until then, the engine falls back to the Puppeteer implementation automatically.

## Message protocol

`background.js` accepts messages on a port named `kruz-extension`:

```js
port.postMessage({ method: 'executeScript', params: { code: '...', allFrames: false } });
port.postMessage({ method: 'patchNavigator', params: { patches: { 'navigator.webdriver': false } } });
port.postMessage({ method: 'setupMutationObserver', params: { options: {...} } });
port.postMessage({ method: 'getTabs' });
port.postMessage({ method: 'getCookies', params: { domain: 'example.com' } });
```

## JS-heavy website support

The content script runs at `document_start` in the `MAIN` world, so:

- React, Vue, Angular SPAs see Kruz as a real user (webdriver is `undefined`).
- Sites that fingerprint via WebGL return plausible Intel Iris strings.
- Sites that watch for `MutationObserver` timing (e.g. credential forms that disable paste) get a real observer from the extension, not a synthetic one from Puppeteer.

## Troubleshooting

- **Extension not detected** — open DevTools console and check for `[Kruz Ctrl] Content script ready — bot evasion active, MutationObserver live.`
- **Service worker not connecting** — in `chrome://extensions/`, click **"service worker"** under the Kruz Ctrl card to see the worker console.
- **Stale extension** — click the **"Update"** button on the extension card after editing any file.
