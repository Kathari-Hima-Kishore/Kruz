/** One bounded DOM pass; never probe absent selectors with per-selector waits. */
export function overlayScript(config: { cookie: boolean; newsletter: boolean; chat: boolean; app: boolean }): string {
  return `(${dismissOverlays.toString()})(${JSON.stringify(config)})`;
}

async function dismissOverlays(config: { cookie: boolean; newsletter: boolean; chat: boolean; app: boolean }) {
  const dismissed: string[] = [], failed: string[] = [];
  const visible = (el: Element) => el.isConnected && (!('open' in el) || (el as any).open !== false) && el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' &&
    !el.closest('[hidden], [aria-hidden="true"]');
  const groups: [boolean, string, string][] = [
    [config.cookie, 'cookie', '#onetrust-banner-sdk, #CybotCookiebotDialog, #system-ialert, .truste-banner, [id*="cookie" i][id*="banner" i], [class*="cookie" i][class*="banner" i], [class*="cookie" i][class*="consent" i], .cookie-notice, .cookie-bar, .gdpr-banner'],
    [config.newsletter, 'newsletter', '[class*="newsletter" i][class*="popup" i], [class*="subscribe" i][class*="modal" i], .newsletter-modal, .subscription-popup, .email-capture'],
    [config.chat, 'chat', '.intercom-messenger, .drift-chat, .crisp-client, .tawk-widget, [class*="chat" i][class*="widget" i]'],
    [config.app, 'app', '.app-banner, .install-banner, #app-install-banner, .mobile-app-banner, .pwa-install'],
    [config.app, 'dialog', 'dialog[open], [role="dialog"], [aria-modal="true"], sl-dialog[open]'],
  ];
  // Dialogs and their dismiss controls may live in open shadow roots. Keep
  // searches scoped to the overlay; never click similarly named page controls.
  const deepQuery = (root: ParentNode, selector: string): Element[] => {
    const result = Array.from(root.querySelectorAll(selector));
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) result.push(...deepQuery(node.shadowRoot, selector));
    return result;
  };
  const seen = new Set<Element>();
  const deadline = Date.now() + 2500;
  for (const [enabled, kind, selector] of groups) {
    if (!enabled) continue;
    for (const container of deepQuery(document, selector)) {
      if (seen.has(container) || !visible(container)) continue;
      seen.add(container);
      if (Date.now() >= deadline) { failed.push(`${kind}: scan budget reached`); continue; }
      const controls = deepQuery(container, 'button, [role="button"], a, sl-button') as HTMLElement[];
      // Prefer rejection to granting consent when both are available.
      controls.sort((a, b) => Number(/^(decline|reject|deny)/i.test(b.innerText?.trim())) - Number(/^(decline|reject|deny)/i.test(a.innerText?.trim())));
      const control = controls.find(el => {
          if (!visible(el) || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim();
          // Never guess a control from a broad class such as "apply" or toggle a chat launcher.
          if (/apply|sign.?in|log.?in|submit|captcha/i.test(label + ' ' + (el.getAttribute('href') || ''))) return false;
          return /^(close|dismiss|no,? thanks|maybe later|not now|×|✕|x)$/i.test(label) ||
            (kind === 'cookie' && /^(accept( all)?( cookies)?|allow( all)?( cookies)?|decline|deny|reject( all)?|agree|i agree|got it|ok)$/i.test(label));
        });
      if (!control) { failed.push(`${kind}: no safe dismiss control`); continue; }
      control.click();
      // A resolved click is not proof that dismissal happened.
      const settle = Math.min(deadline, Date.now() + 400);
      while (visible(container) && Date.now() < settle) await new Promise(resolve => setTimeout(resolve, 50));
      if (!visible(container)) dismissed.push(kind);
      else failed.push(`${kind}: still visible after dismissal`);
    }
  }
  return { dismissed, failed, summary: `Dismissed ${dismissed.length} overlays, ${failed.length} unresolved` };
}
