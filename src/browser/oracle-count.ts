/** Read the rendered total, including Oracle's Jobs tab ("Jobs 797"). */
export const ORACLE_COUNT_SCRIPT = `(() => {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const parse = text => {
    const value = (text || '').replace(/\\s+/g, ' ').trim();
    const match = value.match(/^(?:jobs?|results?)\\s*[:(]?\\s*([\\d,]+)\\s*\\)?$/i) ||
      value.match(/^([\\d,]+)\\s+(?:jobs?|results?)(?:\\s+found)?$/i) ||
      value.match(/\\bof\\s+([\\d,]+)\\s+(?:jobs?|results?)\\b/i);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  };
  for (const el of document.querySelectorAll('[role="tab"], h1, h2, h3, [class*="result-count"], [class*="job-count"], [class*="results-count"], [aria-label*="Jobs" i]')) {
    if (!visible(el)) continue;
    const count = parse(el.textContent) ?? parse(el.getAttribute('aria-label'));
    if (count !== null) return count;
    if (/count/i.test(el.className || '') && /^\\s*[\\d,]+\\s*$/.test(el.textContent || '')) return Number(el.textContent.replace(/,/g, '').trim());
  }
  for (const line of (document.body?.innerText || '').split(/\\n/)) {
    const count = parse(line);
    if (count !== null) return count;
  }
  // Oracle sometimes puts the label and number on separate lines.
  const pair = (document.body?.innerText || '').match(/(?:^|\\n)\\s*Jobs\\s*\\n\\s*([\\d,]+)\\s*(?:\\n|$)/i);
  return pair ? Number(pair[1].replace(/,/g, '')) : null;
})()`;
