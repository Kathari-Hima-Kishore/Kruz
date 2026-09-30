import type { BrowserEngine } from "./engine.js";
import type { ATSType } from "./ats-detector.js";

/**
 * ATS enumeration + posting-verification helpers tailored to job-finder-v9.
 * These implement the Phase 1.5/3a/3b/3c mechanics inside Kruz's own browser:
 *  - full-feed/sitemap enumeration per ATS (baseline for completeness C2)
 *  - posting-page liveness verification (3c) returning posting-page URL + terminal state (3d)
 *  - one-pass result-card summarization for pre-filtering before open-and-verify (3b batching)
 *  - stable pagination "load more / scroll to terminal" (Phase 3)
 * All navigation stays inside the live Kruz browser; nothing here switches drivers.
 */

export interface FeedJob {
  id: string;
  title: string;
  location?: string;
  url?: string;
  department?: string;
  posted_at?: string;
}

export interface EnumerateResult {
  ats: ATSType;
  method: "api" | "sitemap" | "ui" | "network";
  total: number;
  jobs: FeedJob[];
  truncated: boolean;
  endpoint?: string;
  note?: string;
}

export interface VerifyResult {
  posting_url: string;   // ALWAYS the posting-page URL, never apply/post-click URL (3c/3d)
  requested_url: string; // Echo of the caller's requested URL — callers MUST confirm requested_url vs landed_url identity per result
  landed_url?: string; // Actual observed URL; posting_url retains the requested identity.
  identity_match: boolean; // requested vs landed same-posting check (false = hold, never trust body)
  title: string | null;
  company: string | null;
  location: string | null;
  posted_at: string | null;
  body_text: string;
  apply_present: boolean;
  apply_liveness: "confirmed" | "no_apply" | "not_checked"; // read-only verification never enters the apply flow
  status: "live" | "closed" | "broken" | "login_required" | "captcha_required";
  verdict: "include" | "hold" | "exclude"; // 3b relevance: title+body experience band + job family alignment
  exclude_reason?: string[];
  hold_reason?: string[];
  experience: string[]; // short text signals (e.g. "2+ years", "0-3 years", "Senior")
  job_family: string[]; // signals (support/data/analytics/software/infra)
  max_years: number | null; // parsed upper bound of the stated experience range (null = unspecified)
  department: string | null;
  last_verified: string; // ISO timestamp (C7)
}

export interface SummarizeResult {
  title: string | null;
  url: string | null;
  items: { title: string; url: string; location?: string; department?: string; date?: string }[];
  count: number;
}

export interface PaginateResult {
  loaded: number;
  terminal: boolean;
  urls: string[];
  method: "scroll" | "next" | "load-more";
  /** P0-C/P1-E: why the loop stopped, and whether the work was partial. */
  reason?: "terminal" | "no_new_content" | "budget_exhausted" | "max_rounds" | "selector_gone" | "error" | "step_failed";
  partial?: boolean;
  iterations?: number;
  items_added?: number;
  remaining_budget_ms?: number;
}

const WORD = 200;

/** Compact text, cap length for body handling. */
function cap(s: string, n: number = WORD): string {
  if (!s) return s;
  return s.length > n ? s.substring(0, n) + "…" : s;
}

function norm(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

/** Extract short, high-signal experience phrases from a job description body. */
export function extractExperienceSignals(text: string): string[] {
  const signals: string[] = [];
  const lower = text.toLowerCase();
  const patterns = [
    /\b0[- ]?3?\s*(?:to|-|–)?\s*\d?\s*years?\b/g,
    /(\d+\s*(?:to|-|–)?\s*\d+)\s*\+?\s*years?\b/g,
    /([0-9]\d?\+?)\s*years?\s*(?:of)?\s*experience\b/g,
    /\bentry\s*[- ]?level\b/g, /\bjunior\b/g, /\bassociate\b/g, /\bgraduate\b/g,
    /\bfresher\b/g, /\brecent graduate\b/g, /\bnew grad\b/g, /\bcampus\b/g,
    /\bsenior\b/g, /\blead\b/g, /\bmanager\b/g, /\bprincipal\b/g,
    /\bmid[- ]?level\b/g, /\b0[- ]to[- ]3\b/g,
  ];
  const seen = new Set<string>();
  for (const re of patterns) {
    const m = lower.match(re);
    if (m) { const t = m[0].trim(); if (!seen.has(t)) { seen.add(t); signals.push(t); } }
  }
  // Years-of-experience quantification
  const years = lower.match(/(?:minimum(?: of)?|at least|a minimum of)\s+(\d{1,2})\s*\+?\s*years?/i) ||
                lower.match(/(?:yrs?|years?)\s*[:\-]?\s*(\d{1,2})\s*\+?\s*[-–]?\s*(\d{1,2})?/i);
  if (years) signals.push(`~${years[1]}y${years[2] ? "-" + years[2] + "y" : "+"}`);
  return signals.slice(0, 8);
}

/** Detect job-family vs. out-of-scope markers from a body (3b tie-breaker). */
function extractJobFamilySignals(text: string): string[] {
  const lower = " " + text.toLowerCase() + " ";
  const out: string[] = [];
  const checks: [RegExp, string][] = [
    [/\b(task|technical|application|production|customer|desk|end[- ]user)\s*support\b/, "support-role"],
    [/\b(help desk|noc|service desk|l[12]\s*support|l[123]\s*levels?)\b/, "support-role"],
    [/\b(data\s*(engineer|analyst|scientist)|business\s*intelligence|analytics|data\s*science|machine\s*learning\s*engineer)\b/, "data/analytics"],
    [/\b(software\s*(engineer|developer)|full[- ]?stack|frontend|front[- ]?end|backend|back[- ]?end|devops|cloud\s*(engineer|developer)|site\s*reliability|platform\s*engineer|infrastructure\s*engineer|sre)\b/, "software/infra"],
    [/\b(android|ios|flutter|react\s*native|mobile\s*(developer|engineer))\b/, "mobile"],
    [/\b(react|next\.?js|typescript|node\.?js|python|java|\.net|golang|go\s*developer|api|rest|microservices?)\b/, "stack"],
  ];
  const seen = new Set<string>();
  for (const [re, label] of checks) {
    if (re.test(lower)) { if (!seen.has(label)) { seen.add(label); out.push(label); } }
  }
  // Seniority conflict guard
  const snr = /\b(senior|lead|principal|staff|architect)\b/.test(lower);
  if (snr) out.push("senior-scope");
  return out;
}

function classifyStatus(text: string, applyPresent: boolean): VerifyResult["status"] {
  const lower = text.toLowerCase();
  if (/login required|please log in|log in to see|sign[- ]in to view/i.test(lower)) return "login_required";
  if (/captcha|verify you are human|challenge platform|are you a robot/i.test(lower)) return "captcha_required";
  if (CLOSED_POSTING_RE.test(lower)) return "closed";
  // Broken/empty: no main content
  if (text.trim().length < 100 || !applyPresent) return "broken";
  return "live";
}

const CLOSED_POSTING_RE = /no longer accepting|not accepting applications|(?:position|job|posting|requisition)\s+(?:filled|closed|expired)|(?:position|job|posting|requisition)[^.!?\n]{0,120}\b(?:is|was|has been)\s+(?:filled|closed|expired|no longer available)/i;

/** Resolve the canonical ATS feed URL + parse function for a detected ATS + portal URL. */
function buildFeedFetch(ats: ATSType, portalUrl: string, companySlug?: string): { url: string; kind: "json" | "sitemap" | null } | null {
  const slug = (companySlug || "").trim();
  const u = portalUrl;
  // Cornerstone CSOD has no harvester but usually exposes a sitemap — try it
  // before falling back to UI enumeration (ses_f551 gap: returned "no pattern").
  if (/csod\.com/i.test(u)) {
    try { const origin = new URL(u).origin; return { url: `${origin}/sitemap.xml`, kind: "sitemap" }; } catch { return null; }
  }
  switch (ats) {
    case "greenhouse": {
      let co = slug;
      if (!co) {
        const m = u.match(/greenhouse\.io\/([^\/?#]+)/) || u.match(/boards\.greenhouse\.com\/([^\/?#]+)/);
        co = m ? m[1] : "";
      }
      if (!co) return null;
      return { url: `https://boards-api.greenhouse.io/v1/boards/${co}/jobs?content=true`, kind: "json" };
    }
    case "lever": {
      let co = slug;
      if (!co) { const m = u.match(/jobs\.lever\.co\/([^\/?#]+)/); co = m ? m[1] : ""; }
      if (!co) return null;
      return { url: `https://api.lever.co/v0/postings/${co}?mode=json`, kind: "json" };
    }
    case "ashby": {
      let co = slug;
      if (!co) { const m = u.match(/jobs\.ashbyhq\.com\/([^\/?#]+)/); co = m ? m[1] : ""; }
      if (!co) return null;
      return { url: `${u.startsWith("http") ? u : "https://" + u}posting-api/job-board/${co}`, kind: "json" };
    }
    case "smartrecruiters": {
      let co = slug;
      if (!co) { const m = u.match(/apply\.workable|careers\.smartrecruiters\.com\/([^\/?#]+)/); co = m ? m[1] : ""; }
      if (!co) return null;
      return { url: `https://api.smartrecruiters.com/v1/companies/${co}/postings?limit=500`, kind: "json" };
    }
    case "oracle-hcm":
    case "oracle-orc": {
      const ts = u.match(/hcmui/i) ? u : u;
      return { url: u.replace(/\/[^\/?#]*$/, "/sitemaps/sitemapIndex.xml"), kind: "sitemap" };
    }
    case "avature":
    case "icims":
    case "successfactors":
    case "phenom":
    case "taleo":
    case "eightfold": {
      try { const origin = new URL(u).origin; return { url: `${origin}/sitemap.xml`, kind: "sitemap" }; } catch { return null; }
    }
    default:
      return null;
  }
}

/**
 * Phase 1.5 / 3a — enumerate the full job feed/sitemap via the live browser.
 * Uses the engine's contextFetch (bypasses browser CORS) so API feeds load
 * even when the board origin restricts cross-origin fetch(); session cookies
 * are inherited from the live page context.
 */
export async function enumerate(engine: BrowserEngine, ats: ATSType, portalUrl: string, companySlug?: string): Promise<EnumerateResult> {
  const plan = buildFeedFetch(ats, portalUrl, companySlug);
  if (!plan || !plan.url) {
    return { ats, method: "ui", total: 0, jobs: [], truncated: false, note: "No API/sitemap pattern for this ATS — use UI enumeration." };
  }
  try {
    const response = await engine.contextFetch(plan.url, { timeoutMs: 20000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = response.text;
    const jobs: FeedJob[] = [];
    let total = 0;
    let truncated = false;
    if (plan.kind === "json") {
      let json: any;
      try { json = JSON.parse(text); } catch {
        return { ats, method: "api", total: 0, jobs: [], truncated: true, note: "Feed returned non-JSON", endpoint: plan.url };
      }
      const arr = Array.isArray(json) ? json : json?.jobs || json?.postings || json?.results || json?.data || [];
      total = Array.isArray(arr) ? arr.length : 0;
      for (const j of Array.from(Array.isArray(arr) ? arr : []).slice(0, 500)) {
        const jj: any = j;
        const title = (jj && (jj.title || jj.name || jj.jobTitle || jj.job_name)) + "";
        const id = (jj && (jj.id || jj.reqId || jj.uuid || jj.jobId || jj.requisitionId)) + "";
        const location = (jj && (jj.location?.name || jj.locationName || jj.location?.text || jj.job_location || jj.location)) + "";
        const department = (jj && (jj.department || jj.departmentName || jj.team?.name || jj.departments?.[0]?.name)) + "";
        const url = (jj && (jj.absolute_url || jj.job_url || jj.applyUrl || jj.url)) + "";
        const posted_at = (jj && (jj.updated_at || jj.created_at || jj.postedAt || jj.updatedAt || jj.published_at)) + "";
        jobs.push({ id, title, location, department, url, posted_at });
      }
      truncated = total > 500;
    } else if (plan.kind === "sitemap") {
      const urls = Array.from(text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)).map(m => m[1]);
      total = urls.length;
      jobs.push(...urls.slice(0, 500).map(u => ({ id: u, url: u, title: "", location: "", department: "", posted_at: "" })));
      truncated = total > 500;
    }
    return { ats, method: "api", total, jobs, truncated, endpoint: plan.url, note: plan.kind === "sitemap" ? "Sitemap enumeration (URLs may be posting pages or job IDs)." : undefined };
  } catch (e) {
    return { ats, method: "network", total: 0, jobs: [], truncated: false, endpoint: plan.url, note: `Direct feed fetch failed (${e}). Enable network.capture and reload the portal so the ATS feed appears in traffic, then read via network.body.` };
  }
}

/**
 * Read-only posting verification. Every evaluation uses the caller-owned page.
 * A failed/empty extraction is unverified (hold), never a relevance exclusion.
 */
export async function verifyPosting(engine: BrowserEngine, postingUrl: string): Promise<VerifyResult> {
  const empty: VerifyResult = {
    posting_url: postingUrl, requested_url: postingUrl, identity_match: false, title: null, company: null, location: null, posted_at: null,
    body_text: "", apply_present: false, apply_liveness: "not_checked", status: "broken", verdict: "hold",
    experience: [], job_family: [], max_years: null, department: null, last_verified: new Date().toISOString(),
  };
  const hold = (reason: string, landed_url?: string): VerifyResult => ({
    ...empty, landed_url, hold_reason: [reason], last_verified: new Date().toISOString(),
  });
  try { await engine.navigate(postingUrl, "domcontentloaded", 20000); }
  catch (error) { return hold(`Navigation failed: ${error}`); }

  // A rendered site shell can have hundreds of footer words and an Apply button
  // before the actual JD arrives. Wait for the description, not total body length.
  await engine.waitFor(
    `(() => { const data = ${POSTING_EXTRACT_SCRIPT}; return data.description_ready || ${CLOSED_POSTING_RE}.test(data.page_text) || /verify you are human|login required|sign[- ]in to view/i.test(data.page_text); })()`,
    15000, 250,
  ).catch(() => false);
  const dataResult = await engine.evaluate(POSTING_EXTRACT_SCRIPT).catch(() => ({ ok: false as const }));
  if (!dataResult.ok || !dataResult.result) return hold("Page extraction failed; verification required.");
  const data = dataResult.result as {
    url: string; text: string; title: string; company: string; location: string;
    posted: string; department: string; apply: boolean; page_text?: string; description_ready: boolean;
  };
  if (!samePostingIdentity(postingUrl, data.url)) {
    return hold("Posting identity changed or redirected; inspect the requested posting before classifying.", data.url);
  }
  const identity_match = true;
  let status = classifyStatus(data.page_text ?? data.text, data.apply);
  if (status === "live" && !data.description_ready) status = "broken";
  if (data.text.trim().length < 100 && status === "broken") return hold("Posting body is empty or incomplete; verification required.", data.url);
  const experience = extractExperienceSignals(data.text);
  const job_family = extractJobFamilySignals(data.text);
  const max_years = parseMaxYears(data.text);
  const verdict = status === "live" ? decideVerdict(data.text, experience, job_family, max_years)
    : status === "closed" ? "exclude" : "hold";
  return {
    ...empty, landed_url: data.url, identity_match,
    title: data.title || openingTitle(data.text), company: data.company || null,
    location: data.location || null, posted_at: data.posted || null,
    body_text: data.text, apply_present: data.apply,
    apply_liveness: data.apply ? "not_checked" : "no_apply",
    status, verdict,
    exclude_reason: verdict === "exclude" ? (status === "closed" ? ["Posting is closed"] : exclusionReasons(data.text, max_years, job_family)) : undefined,
    hold_reason: verdict === "hold" ? ["Ambiguous or incomplete posting; needs body verification."] : undefined,
    experience, job_family, max_years, department: data.department || null,
    last_verified: new Date().toISOString(),
  };
}

/** Fail closed on redirects to another job or listing; ignore fragments/trailing slash only. */
export function samePostingIdentity(requested: string, landed: string): boolean {
  try {
    const a = new URL(requested), b = new URL(landed);
    a.hash = b.hash = "";
    a.pathname = a.pathname.replace(/\/+$/, "") || "/";
    b.pathname = b.pathname.replace(/\/+$/, "") || "/";
    a.searchParams.sort(); b.searchParams.sort();
    return a.href === b.href;
  } catch { return false; }
}

export const POSTING_EXTRACT_SCRIPT = `(() => {
  const visible = el => !!el && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none" && !el.closest('[hidden], [aria-hidden="true"]');
  const selText = s => { const el = document.querySelector(s); return el ? (el.getAttribute("content") || el.textContent || "").trim() : ""; };
  let job = null;
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ([].concat(value["@type"] || []).includes("JobPosting")) job = value;
    if (value["@graph"]) visit(value["@graph"]);
  };
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(el.textContent || "")); } catch {}
  }
  const body = (document.body?.innerText || "").trim();
  const descriptions = Array.from(document.querySelectorAll('[itemprop="description"], .job-description, [class*="job-description"], .jd-job-details-description, [data-ph-at-id="job-description"]'));
  const oracleSections = Array.from(document.querySelectorAll('.job-details__section')).filter(visible).filter(el => /^(Job Description|Responsibilities|Qualifications)$/i.test(el.querySelector('h2')?.innerText?.trim() || ''));
  const oracleMeta = label => Array.from(document.querySelectorAll('.job-meta__item')).find(el => el.querySelector('.job-meta__title')?.innerText?.trim() === label)?.querySelector('.job-meta__subitem')?.innerText?.trim() || '';
  const oracleText = oracleSections.map(el => el.innerText.trim()).join('\\n');
  const description = oracleText.length >= 100 ? [selText('h1'), 'Years: '+oracleMeta('Years'), oracleText].join('\\n') : descriptions.filter(visible).map(el => (el.innerText || '').trim()).find(text => text.length >= 100);
  // A generic full-page fallback needs actual JD headings/signals. Branding and
  // equal-opportunity footer text alone cannot establish a verified description.
  const bodyHasDescription = body.length >= 300 && /responsibilities|qualifications|minimum requirements|what you.ll (?:do|bring)|about (?:the|this) role|years? (?:of )?experience/i.test(body);
  const text = description || (bodyHasDescription ? body : '');
  const controls = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'));
  const apply = controls.some(el => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
    (/\\bapply\\b/i.test(el.innerText || el.value || el.getAttribute("aria-label") || "") || /apply/i.test(el.getAttribute("href") || "")));
  const address = job?.jobLocation?.address || job?.jobLocation?.[0]?.address;
  return {
    url: location.href, text, page_text: body, description_ready: text.length >= 100,
    title: job?.title || selText('h1') || document.title?.trim() || "",
    company: job?.hiringOrganization?.name || selText('[data-company], .company, meta[property="og:site_name"]'),
    location: address ? [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(", ") : selText('.job-details__subtitle, [data-location], .location, [class*="job-location"]'),
    posted: job?.datePosted || oracleMeta('Posting Date') || selText('[data-posted], .posted-at, time'),
    department: oracleMeta('Job Category') || selText('[data-department], .department'), apply,
  };
})()`;

/** Parse the upper bound of the stated experience range in years (null = unspecified). */
export function parseMaxYears(text: string): number | null {
  const lower = " " + text.toLowerCase() + " ";
  const ranges = [...lower.matchAll(/\b(\d{1,2})\s*(?:to|through|[-–—])\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi)];
  if (ranges.length) return Math.max(...ranges.flatMap(m => [Number(m[1]), Number(m[2])]));
  const re = /(?:experience|years|yrs?|we require|must have|required)[^.\n]{0,40}?(\d{1,2})\s*(?:to|[-–—]|through)?\s*(\d{1,2})?\s*\+?\s*years?/gi;
  const m = re.exec(lower);
  if (!m) {
    const m2 = lower.match(/(?:minimum(?: of)?|at least|a minimum of|min\.?)\s+(\d{1,2})\s*\+?\s*years?/i);
    if (m2) return parseInt(m2[1], 10);
    const m3 = lower.match(/\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*\+?\s*years?\b/i);
    if (m3) return Math.max(parseInt(m3[1], 10), parseInt(m3[2], 10));
    return null;
  }
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  return Math.max(a, b);
}

/** 3b verdict: title family + body experience band + body job family alignment. */
function decideVerdict(text: string, _exp: string[], jobFamily: string[], maxYears: number | null): VerifyResult["verdict"] {
  const lower = " " + text.toLowerCase() + " ";
  const hasData = jobFamily.includes("data/analytics");
  const hasSupport = jobFamily.includes("support-role");
  const hasSw = jobFamily.includes("software/infra");

  if (maxYears !== null && maxYears > 3) return "exclude";
  if (hasSupport) return "exclude";
  const seniorOnly = /\b(senior|staff|principal|lead|architect|head of)\b/.test(lower) && !/0[- ]?3|(?:1|2|3)\s*(?:to|[-–—])\s*3|junior|entry|associate|early|graduate|fresher|campus/i.test(lower);
  if (seniorOnly) return "exclude";

  if (hasData) {
    if (hasSw) return "include";
    return /(build|develop|maintain|design|implement|engineer)[^.\n]{0,80}(pipeline|infrastructure|platform|service|api|system|backend|deployment|ci\/cd)/i.test(lower) ? "include" : "exclude";
  }

  if (hasSw) return "include";
  if (maxYears === null && extractExperienceSignals(text).length === 0) return "hold";
  return /(software|developer|engineer|full[- ]?stack|frontend|backend|cloud|devops|mobile|programmer|developer|coder)/i.test(lower) ? "include" : "hold";
}

function exclusionReasons(text: string, maxYears: number | null, jobFamily: string[]): string[] {
  const reasons: string[] = [];
  if (maxYears !== null && maxYears > 3) reasons.push(`experience ${maxYears}y exceeds 3y cap`);
  if (jobFamily.includes("support-role")) reasons.push("support-helpdesk role (excluded)");
  if (jobFamily.includes("data/analytics")) reasons.push("data/analytics role (excluded unless software-built)");
  return reasons.length ? reasons : ["title/body-verified mismatch"];
}

function openingTitle(text: string): string | null {
  const first = text.split("\n").map(s => s.trim()).filter(Boolean)[0];
  return first && first.length < 160 ? first : null;
}

/**
 * Phase 3b batching — one-pass extraction of all result-card links + texts on a
 * listing/results page, so the agent can pre-filter before opening individual cards.
 */
export async function summarize(engine: BrowserEngine): Promise<SummarizeResult> {
  const dataResult = await engine.evaluate(`(() => {
    const title = document.title?.trim() || null;
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const items = [];
    const seen = new Set();
    for (const a of anchors) {
      const t = (a.textContent || "").trim().replace(/\\s+/g, " ");
      if (t.length < 2) continue;
      const href = a.href || "";
      if (!/^https?:/i.test(href)) continue;
      const key = href.split(/[?#]/)[0] + "|" + t;
      if (seen.has(key)) continue;
      seen.add(key);
      if (/^https?:\\/\\/[^/]+\\/?$/.test(href)) continue;
      if (/(privacy|terms|about|contact|login|register|cookie|careers\\/?$|#)/i.test(href) && t.length < 40) continue;
      items.push({ title: t.substring(0, 200), url: href });
      if (items.length >= 200) break;
    }
    const jobLike = items.filter(i => i.title.length >= 3 && i.title.length <= 120);
    return { title, items: jobLike, count: jobLike.length, rawCount: items.length };
  })()`).catch(() => ({ ok: false as const }));

  const pageUrl = await engine.url();
  if (!dataResult.ok || !dataResult.result) return { title: null, url: pageUrl, items: [], count: 0 };
  const data = dataResult.result as { title: string | null; items: any[]; count: number };
  return { title: data.title, url: pageUrl, items: data.items, count: data.count };
}

/**
 * Phase 3 — stable pagination. Scroll to bottom until the page height or a sentinel
 * stabilizes (terminal "no more results"), collecting newly-visible posting links.
 * Optionally click a "next"/"load more" control repeatedly.
 */
export async function paginate(engine: BrowserEngine, opts: { maxScrolls?: number; waitMs?: number; loadMoreSelector?: string; nextSelector?: string; budgetMs?: number } = {}): Promise<PaginateResult> {
  const maxScrolls = opts.maxScrolls ?? 40;
  const waitMs = opts.waitMs ?? 800;
  // P0-C: the loop must never outlive the caller's route budget. Default 20s leaves a
  // 5s safety margin inside the 25s non-nav route timeout, so we return a partial
  // result instead of being killed with outcome:unknown.
  const budgetMs = Math.max(1000, opts.budgetMs ?? 20000);
  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);
  const estimatedIteration = waitMs + 500;
  const withMeta = (r: PaginateResult, iterations: number, terminal: boolean): PaginateResult => ({
    ...r,
    iterations,
    partial: !terminal,
    remaining_budget_ms: Math.max(0, remaining()),
  });

  try {
    if (opts.loadMoreSelector || opts.nextSelector) {
      const sel = opts.loadMoreSelector || opts.nextSelector!;
      let urls: string[] = [];
      let iterations = 0;
      let reason: NonNullable<PaginateResult["reason"]> = "terminal";
      for (let i = 0; i < maxScrolls; i++) {
        if (remaining() < estimatedIteration) { reason = "budget_exhausted"; break; }
        const before = new Set(await collectPostingUrls(engine));
        const foundCount = await engine.countElements({ css: sel });
        if (foundCount === 0) { reason = "selector_gone"; iterations = i; break; }
        const btn = await engine.queryOne({ css: sel });
        // P1-E: a step that cannot even resolve is a step failure, not a green light to
        // keep clicking blind. Stop and report partial progress.
        if (!btn) { reason = "step_failed"; iterations = i; break; }
        const clickRes = await engine.scrollIntoView(btn).then(() => engine.click(btn, { force: true, timeoutMs: 1500 })).then(() => ({ ok: true })).catch(() => ({ ok: false }));
        if (!clickRes.ok) { reason = "step_failed"; iterations = i; break; }
        // P1-E: verify the EFFECT of this step (new items appeared) before the next one.
        const after = await waitForNewItems(engine, before, waitMs);
        iterations = i + 1;
        urls = [...after];
        if (after.size === before.size) { reason = "no_new_content"; break; }
      }
      const terminal = reason === "terminal" || reason === "selector_gone";
      return withMeta({ loaded: urls.length, terminal, urls, method: opts.loadMoreSelector ? "load-more" : "next", reason }, iterations, terminal);
    }

    let prevH = -1;
    let stableRounds = 0;
    let urls: string[] = [];
    let iterations = 0;
    let reason: NonNullable<PaginateResult["reason"]> = "terminal";
    for (let i = 0; i < maxScrolls; i++) {
      if (remaining() < estimatedIteration) { reason = "budget_exhausted"; break; }
      await engine.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
      await engine.waitMs(waitMs).catch(() => {});
      const hResult = await engine.evaluate(`document.body.scrollHeight`).catch(() => ({ ok: false as const }));
      const h = hResult.ok ? (hResult.result as number) : 0;
      urls = await collectPostingUrls(engine);
      iterations = i + 1;
      if (h === prevH) {
        stableRounds++;
        if (stableRounds >= 2) { reason = "terminal"; break; }
        reason = "no_new_content";
      } else stableRounds = 0;
      prevH = h;
    }
    if (iterations >= maxScrolls && reason !== "terminal") reason = reason === "budget_exhausted" ? reason : "max_rounds";
    const terminal = reason === "terminal";
    return withMeta({ loaded: urls.length, terminal, urls, method: "scroll", reason }, iterations, terminal);
  } catch (e) {
    return { loaded: 0, terminal: false, urls: [], method: "scroll", note: `paginate failed: ${e}`, reason: "error", partial: true, iterations: 0, remaining_budget_ms: Math.max(0, remaining()) } as PaginateResult;
  }
}

/** P1-E: wait (bounded by waitMs) until the collected URL set grows past `before`. */
async function waitForNewItems(engine: BrowserEngine, before: Set<string>, waitMs: number): Promise<Set<string>> {
  const deadline = Date.now() + Math.max(300, waitMs);
  let after = new Set(await collectPostingUrls(engine));
  while (after.size <= before.size && Date.now() < deadline) {
    await engine.waitMs(150).catch(() => {});
    after = new Set(await collectPostingUrls(engine));
  }
  return after;
}

async function collectPostingUrls(engine: BrowserEngine): Promise<string[]> {
  try {
    const result = await engine.evaluate(`(() => {
      const out = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const a of anchors) {
        const href = a.href || "";
        const t = (a.textContent || "").trim();
        if (!/^https?:/i.test(href)) continue;
        if (t.length < 2) continue;
        const isJob = /(job|jobdetails|posting|position|cxid|reqid|apply\\/).*?(\\d{3,}|\\w{6,})/i.test(href) || (/\\/jobs?[\\/?#]/i.test(href)) || (t.length > 3 && t.length < 120 && !/privacy|terms|about|contact|login|register/i.test(t));
        if (!isJob) continue;
        const key = href.split(/[?#]/)[0];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(href);
        if (out.length >= 1000) break;
      }
      return out;
    })()`).catch(() => ({ ok: false as const }));
    if (result.ok && Array.isArray(result.result)) return result.result;
    return [];
  } catch { return []; }
}
