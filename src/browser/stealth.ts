/**
 * Injected at document_start in the MAIN world (same as the visual-cursor layer).
 *
 * Chrome's own automation tells are removed here instead of with
 * --disable-blink-features=AutomationControlled, which triggers the
 * "unsupported command-line flag" infobar in the user's window. This is the
 * standard approach used by stealth stacks and by the CDP-native services
 * (browser-use, Stagehand, agent-browser): keep the launch flags clean and
 * normalise the observable surface in the page.
 *
 * Everything here is a getter/descriptor fix — no behaviour of the page changes,
 * and nothing is faked beyond the specific automation attributes.
 */
export function stealthScript(): string {
  return `(() => {
  try {
    // 1. navigator.webdriver — true whenever Chrome is driven over CDP.
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto && Object.getOwnPropertyDescriptor(proto, 'webdriver')) {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      } else {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
      }
    } catch (e) {}

    // 2. window.chrome — present in every real Chrome, absent under automation.
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          connect: () => ({ onConnect: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => {}, disconnect: () => {} }),
          sendMessage: () => undefined,
          id: undefined,
        };
      }
    } catch (e) {}

    // 3. Permissions.query leak: notify() reports "denied" for notifications
    // under automation while a normal profile reports "prompt".
    try {
      const origQuery = navigator.permissions && navigator.permissions.query;
      if (origQuery) {
        navigator.permissions.query = function (params) {
          const name = params && params.name;
          if (name === 'notifications') {
            return Promise.resolve({ state: Notification.permission === 'denied' ? 'denied' : Notification.permission, onchange: null });
          }
          return origQuery.call(this, params);
        };
      }
    } catch (e) {}

    // 4. Plugin/mimeTypes — headless Chrome reports an empty PluginArray.
    try {
      const mk = (name, filename, description) => ({ name, filename, description, length: 1 });
      const pdf = mk('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format');
      const chromePdf = mk('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format');
      if (navigator.plugins && navigator.plugins.length === 0) {
        const arr = [pdf, chromePdf, mk('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'), mk('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'), mk('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format')];
        Object.defineProperty(navigator, 'plugins', { get: () => arr, configurable: true });
      }
    } catch (e) {}

    // 5. WebGL vendor/renderer — headless reports SwiftShader; a real GPU does not.
    try {
      if (typeof WebGLRenderingContext !== 'undefined') {
        const describe = (proto) => {
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return 'Intel Inc.';
            if (p === 37446) return 'Intel Iris OpenGL Engine';
            return orig.apply(this, [p]);
          };
        };
        describe(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') describe(WebGL2RenderingContext.prototype);
      }
    } catch (e) {}

    // 6. languages / hardwareConcurrency stay untouched: they are genuine
    //    environment values and faking them is the strongest detector.
  } catch (e) {}
  return 'ok';
})()`;
}
