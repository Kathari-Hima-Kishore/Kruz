/**
 * Tool-name sanitizer + handle discoverer.
 *
 * Bug 1 (2026-09-06 transcript): GPT-OSS-20B leaked `<|channel|>commentary`
 * into tool-call names (e.g. `Kruz_page_open<|channel|>commentary`).
 * Every leak dumped the full ~150-tool list back into the conversation.
 *
 * Fix: validate/sanitize against the registered-tool set BEFORE dispatch.
 *  - Strip `<|...|>` special-token artifacts.
  *  - If a cleaned name matches a registered tool, dispatch it.
 *  - Otherwise return a SHORT, specific error (no tool-list echo).
 *
 * Bug 4: same module exposes `discoverGreenhouseHandle` /
 * `discoverSmartRecruitersHandle` so the harvesters auto-lookup the
 * real public board when a guessed handle 404s.
 */

export const KNOWN_TOOLS = new Set<string>([
  "server.info",
  "session.create", "session.status", "session.close", "session.pause", "session.resume",
  "page.open",
  "page.newTab", "page.switchTab", "page.listTabs", "page.closeTab",
  "page.observe",
  "page.probe",
  "page.click", "page.clickAt",
  "page.drag", "page.setViewport", "page.uploadFile",

  "page.computerUseList", "page.computerUseSnapshot",
  "page.screenshot",
  "page.fill", "page.press",
  "page.select", "page.check", "page.uncheck",
  "page.scroll", "page.paginate",
  "page.handleOverlays",
  "page.wait",
  "page.dialog", "page.evaluate",
  "page.frameObserve", "page.frameEvaluate",
  "page.oracleHCMSearch", "page.iCIMSSearch", "page.extractExperience",
  "page.detectATS",
  "ats.enumerate", "ats.verifyPosting", "ats.summarize", "ats.paginate",
  "ats.greenhouseHarvest", "ats.leverHarvest", "ats.ashbyHarvest",
  "ats.smartRecruitersHarvest", "ats.workdayHarvest", "ats.bulkHarvest",
  "ats.discoverHandle",
  "network.body", "network.capture",
  "extract.text",
  "human.takeover",
]);

const SPECIAL_TOKEN_RE = /<\|[^>]+\|>/g;
const CHANNEL_TAIL_RE = /\s*(?:commentary|final)\s*$/i;

export interface SanitizedName {
  ok: true;
  name: string;
  stripped: string[];
}
export interface SanitizedNameError {
  ok: false;
  code: "EMPTY_NAME" | "UNKNOWN_TOOL" | "MALFORMED_NAME";
  message: string;
  /** When the input contained special-token artifacts, the cleaned candidate. */
  candidate?: string;
}

/**
 * Validate and sanitize a tool name coming from the model.
 * - Strips any `<|...|>` special-token artifacts.
 * - Trims surrounding whitespace and quotes.
 * - Returns the canonical registered name if known, else a short error.
 */
export function sanitizeToolName(raw: string): SanitizedName | SanitizedNameError {
  if (raw == null || typeof raw !== "string") {
    return { ok: false, code: "EMPTY_NAME", message: "Tool name missing." };
  }
  const original = raw;
  // Strip surrounding whitespace and stray quotes from JSON-encoded tool names.
  let cleaned = raw.trim().replace(/^["']+|["']+$/g, "");
  const stripped: string[] = [];
  const matches = cleaned.match(SPECIAL_TOKEN_RE);
  if (matches) {
    for (const m of matches) stripped.push(m);
    cleaned = cleaned.replace(SPECIAL_TOKEN_RE, "");
  }
  // GPT-OSS channel tokens look like `<|channel|>commentary` or `<|channel|>final`.
  // The `<|channel|>` half is a special token we already strip above, but the
  // trailing `commentary`/`final` literal may appear either after the tool name
  // OR before it (`<|channel|>commentarypage.click`). Strip the literal in
  // either direction.
  if (stripped.length) {
    cleaned = cleaned.replace(CHANNEL_TAIL_RE, "");
    cleaned = cleaned.replace(/^(?:commentary|final)\s*/i, "");
  }
  // Trim again — strip may have left whitespace at the boundary.
  cleaned = cleaned.trim();

  if (!cleaned) {
    return {
      ok: false,
      code: "MALFORMED_NAME",
      message: `Tool name '${original}' is empty after stripping special tokens ${JSON.stringify(stripped)}. This is a model-output parsing bug — please report the offending model output to your model-runner maintainer.`,
    };
  }

  if (KNOWN_TOOLS.has(cleaned)) {
    if (stripped.length) {
      // Note: do NOT log to stdout (reserved for MCP); stderr is fine.
      process.stderr.write(`[kruz] sanitized tool name '${original}' → '${cleaned}' (stripped ${stripped.length} artifact(s))\n`);
    }
    return { ok: true, name: cleaned, stripped };
  }

  // Maybe the stripped name is the real tool but the model prepended a prefix
  // like "Kruz_" or used underscores where dots belong. Strip common MCP
  // prefixes and retry once.
  const prefixes = ["Kruz_", "kruz_"];
  for (const p of prefixes) {
    if (cleaned.startsWith(p)) {
      let candidate = cleaned.slice(p.length);
      // Normalize underscores → dots only as a fallback heuristic.
      const dotted = candidate.replace(/_/g, ".");
      if (KNOWN_TOOLS.has(candidate)) {
        process.stderr.write(`[kruz] sanitized tool name '${original}' → '${candidate}' (stripped prefix '${p}')\n`);
        return { ok: true, name: candidate, stripped: [p] };
      }
      if (KNOWN_TOOLS.has(dotted)) {
        process.stderr.write(`[kruz] sanitized tool name '${original}' → '${dotted}' (stripped prefix '${p}' + underscores→dots)\n`);
        return { ok: true, name: dotted, stripped: [p, "_→."] };
      }
    }
  }

  // Heuristic: cleaned name *looks like* a tool name but isn't registered.
  return {
    ok: false,
    code: "UNKNOWN_TOOL",
    message: `Unknown tool: '${cleaned}'${stripped.length ? ` (stripped artifacts: ${JSON.stringify(stripped)})` : ""}.`,
  };
}

// ─── Bug 4: Public-board handle discovery ──────────────────────────────

export interface HandleDiscoveryResult {
  ok: boolean;
  ats: "greenhouse" | "smartrecruiters";
  handle?: string;
  boardUrl?: string;
  tried: string[];
  /** Human-readable description of how the handle was found. */
  source?: string;
  error?: string;
}

/**
 * Discover the real Greenhouse board handle for a company without any credentials.
 * Strategy:
 *   1. Probe boards-api.greenhouse.io/v1/boards/<handle>/jobs with the guessed handle.
 *      If the candidate is empty/blank, skip ahead to lookup.
 *   2. Search the public Greenhouse job-boards directory page
 *      (`https://job-boards.greenhouse.io/`) for a slug that includes the company
 *      name; extract the first reasonable slug.
 *   3. Probe candidate slugs derived from common transforms
 *      (lowercase, hyphenate, strip punctuation, drop legal suffixes).
 *
 * Pure HTTP — works without Kruz/browser, called from `ats.greenhouseHarvest`.
 */
export async function discoverGreenhouseHandle(companyName: string): Promise<HandleDiscoveryResult> {
  const tried: string[] = [];
  if (!companyName.trim()) return { ok: false, ats: "greenhouse", tried, error: "Empty company name." };
  const normalize = (s: string) =>
    (s || "")
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|co|corp|corporation|gmbh|technologies|technology|software|labs|systems|io)\b\.?/gi, "")
      .replace(/[^a-z0-9]+/g, "")
      .trim();

  // 1) Try direct handle probes — most-common forms first.
  const directCandidates = Array.from(new Set([
    normalize(companyName),
    (companyName || "").toLowerCase().replace(/[^a-z0-9]+/g, ""),
    (companyName || "").toLowerCase().replace(/\s+/g, "-"),
    (companyName || "").toLowerCase().replace(/\s+/g, ""),
    (companyName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
  ].filter(c => /^[a-z0-9][a-z0-9-]{0,63}$/.test(c))));

  for (const c of directCandidates) {
    tried.push(c);
    try {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c)}/jobs?content=false`, { method: "GET", signal: AbortSignal.timeout(2500) });
      if (r.ok && Array.isArray((await r.json())?.jobs)) {
        return { ok: true, ats: "greenhouse", handle: c, boardUrl: `https://job-boards.greenhouse.io/${c}`, tried, source: "direct probe" };
      }
    } catch { /* network error — keep trying */ }
  }

  // 2) Scrape the public directory at job-boards.greenhouse.io.
  try {
    const r = await fetch("https://job-boards.greenhouse.io/", {
      headers: { "User-Agent": "kruz-handle-discovery/1.0" },
      signal: AbortSignal.timeout(2500),
    });
      if (r.ok && (!r.url || /^(job-boards|boards)\.greenhouse\.io$/.test(new URL(r.url).hostname))) {
      const html = await r.text();
      // The directory lists every board's slug as href="/<slug>".
      const slugRe = /href="\/?([a-z0-9][a-z0-9-]{1,40})"/gi;
      const normName = normalize(companyName);
      let best: { slug: string; score: number } | null = null;
      let m: RegExpExecArray | null;
      while ((m = slugRe.exec(html)) !== null) {
        const slug = m[1];
        if (/^(jobs?|embed|login|boards?|home|index|about|privacy|terms|press|blog|careers)$/.test(slug)) continue;
        if (tried.includes(slug)) continue;
        const s = scoreSlug(slug, companyName, normName);
        if (s >= 0.6 && (!best || s > best.score)) best = { slug, score: s };
      }
      if (best) {
        // Confirm the candidate actually returns jobs before returning it.
        tried.push(best.slug);
        const probe = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(best.slug)}/jobs?content=false`, { signal: AbortSignal.timeout(2500) });
        if (probe.ok && Array.isArray((await probe.json())?.jobs)) {
          return {
            ok: true, ats: "greenhouse", handle: best.slug,
            boardUrl: `https://job-boards.greenhouse.io/${best.slug}`,
            tried, source: `directory lookup (score ${best.score.toFixed(2)})`,
          };
        }
      }
    }
  } catch { /* network — fall through */ }

  return {
    ok: false, ats: "greenhouse", tried,
    error: `No working Greenhouse board handle found for '${companyName}'. Provide one explicitly (e.g. via ats.greenhouseHarvest).`,
  };
}

/**
 * Discover the real SmartRecruiters company handle for a company.
 * Strategy: probe the SmartRecruiters public API. SmartRecruiters returns
 * 404 for unknown companies — and the public jobs listing page at
 * `https://careers.smartrecruiters.com/<Company>` returns 404 for unknown
 * slugs. Try common slug transforms; if all 404, return a clear error.
 *
 * NOTE: there is no public directory page equivalent to Greenhouse's
 * `job-boards.greenhouse.io/`, so this is heuristic-only. For known companies,
 * the SmartRecruiters handle usually matches the capitalized company name
 * (e.g. "Postman", "Bose"). For unknown companies, callers should fall back
 * to the browser-based `ats.enumerate` helper which inspects the careers page.
 */
export async function discoverSmartRecruitersHandle(companyName: string): Promise<HandleDiscoveryResult> {
  const tried: string[] = [];
  const base = (companyName || "").trim();
  if (!base) {
    return { ok: false, ats: "smartrecruiters", tried, error: "Empty company name." };
  }
  const transforms = (s: string) => [
    s,
    s.replace(/\s+/g, ""),
    s.toLowerCase(),
    s.toLowerCase().replace(/\s+/g, ""),
    s.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    s.replace(/[^A-Za-z0-9]+/g, ""),
  ];

  const candidates = Array.from(new Set(transforms(base).filter(Boolean)));
  for (const c of candidates) {
    tried.push(c);
    try {
      const r = await fetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c)}/postings?limit=1`);
      if (r.status === 200) {
        return { ok: true, ats: "smartrecruiters", handle: c, boardUrl: `https://careers.smartrecruiters.com/${c}`, tried, source: "API probe" };
      }
    } catch { /* keep going */ }
  }

  return {
    ok: false, ats: "smartrecruiters", tried,
    error: `No working SmartRecruiters handle found for '${companyName}'. SmartRecruiters has no public directory — try ats.enumerate(ats='smartrecruiters', portal_url='<careers URL>') instead.`,
  };
}

function scoreSlug(slug: string, raw: string, normalizedRaw: string): number {
  const normSlug = slug.replace(/[^a-z0-9]/g, "");
  if (!normalizedRaw) return 0;
  // Exact match (after normalization) is the strongest signal.
  if (normSlug === normalizedRaw) return 1;
  // Substring containment in either direction.
  if (normalizedRaw.length >= 3) {
    if (normSlug.includes(normalizedRaw)) return 0.7;
    if (normalizedRaw.includes(normSlug)) return 0.6;
  }
  // Common-token overlap (cheap fallback).
  const slugTokens = new Set(slug.split(/[-_]+/).filter(Boolean));
  const nameTokens = (raw.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let overlap = 0;
  for (const t of nameTokens) if (slugTokens.has(t)) overlap++;
  if (overlap > 0) return Math.min(0.4, overlap * 0.15);
  return 0;
}
