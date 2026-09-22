/**
 * ATS (Applicant Tracking System) family detector.
 * Detects which ATS platform a career portal uses based on URL patterns and DOM signatures.
 * Used to apply the right navigation strategy per ATS family.
 */

export type ATSType =
  | "workday"
  | "oracle-hcm"
  | "oracle-orc"
  | "icims"
  | "avature"
  | "eightfold"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "successfactors"
  | "phenom"
  | "taleo"
  | "unknown";

export interface ATSDetectionResult {
  type: ATSType;
  confidence: "high" | "medium" | "low";
  evidence: string;
}

/**
 * Detect ATS type from URL patterns.
 */
function detectFromURL(url: string): ATSDetectionResult | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const u = parsed.hostname.toLowerCase();

  // Workday
  if (u.includes("myworkdayjobs.com") || u.includes("wd1.myworkdayjobs") || u.includes("wd5.myworkdayjobs") || u.includes("wd12.myworkdayjobs")) {
    return { type: "workday", confidence: "high", evidence: "URL contains myworkdayjobs.com" };
  }

  // Oracle HCM Cloud / Oracle Recruiting Cloud
  if (u === "careers.oracle.com" || (u.endsWith(".oraclecloud.com") && /hcmui|candidateexperience/i.test(parsed.pathname))) {
    return { type: "oracle-hcm", confidence: "high", evidence: "URL contains oraclecloud.com with hcmUI" };
  }
  if (u.includes("fa-") && u.includes("saasfaprod") && u.includes("oraclecloud.com")) {
    return { type: "oracle-hcm", confidence: "high", evidence: "URL contains Oracle HCM tenant pattern" };
  }

  // iCIMS
  if (u.includes("icims.com") || u.includes("icims.co.in")) {
    return { type: "icims", confidence: "high", evidence: "URL contains icims.com" };
  }

  // Avature
  if (u.includes("avature.net")) {
    return { type: "avature", confidence: "high", evidence: "URL contains avature.net" };
  }

  // Eightfold AI
  if (u.includes("eightfold.ai") || u.includes("talentsuite.eightfold")) {
    return { type: "eightfold", confidence: "high", evidence: "URL contains eightfold.ai" };
  }

  // Greenhouse
  if (u.includes("greenhouse.io") || u.includes("boards.greenhouse.com")) {
    return { type: "greenhouse", confidence: "high", evidence: "URL contains greenhouse.io" };
  }

  // Lever
  if (u.includes("lever.co")) {
    return { type: "lever", confidence: "high", evidence: "URL contains lever.co" };
  }

  // Ashby
  if (u === "ashbyhq.com" || u.endsWith(".ashbyhq.com")) {
    return { type: "ashby", confidence: "high", evidence: "URL contains ashbyhq.com" };
  }

  // SmartRecruiters
  if (u.includes("smartrecruiters.com") || u.includes("smartrecruiterscareers.com")) {
    return { type: "smartrecruiters", confidence: "high", evidence: "URL contains smartrecruiters.com" };
  }

  // SuccessFactors
  if (u.includes("successfactors.com") || u.includes("sf-localpayroll")) {
    return { type: "successfactors", confidence: "high", evidence: "URL contains successfactors.com" };
  }

  // Phenom
  if (u.includes("phenom.com") || u.includes("phenompeople")) {
    return { type: "phenom", confidence: "high", evidence: "URL contains phenom.com" };
  }

  // Cornerstone CSOD (ses_f551: cornerstone.csod.com went undetected → wrong strategy).
  // No dedicated harvester exists; UI enumeration + sitemap attempt via ats.enumerate.
  if (u.includes("csod.com")) {
    return { type: "unknown", confidence: "medium", evidence: "URL contains csod.com (Cornerstone OnDemand — no harvester; use UI enumeration or sitemap)" };
  }

  // Taleo
  if (u === "taleo.net" || u.endsWith(".taleo.net")) {
    return { type: "taleo", confidence: "high", evidence: "URL contains taleo.net" };
  }

  return null;
}

/**
 * Check whether a marker appears in a technical context as a complete word/identifier,
 * not buried within other words or in prose text.
 *
 * Fix for BUG-G1: The old approach had two problems:
 * 1. Plain substring matching ("workday" matched in "everyday workday routine")  
 * 2. No word-boundary checking (marked "phenompeople.com" as "phenom" ATS)
 * 
 * This enhanced version requires:
 * 1. Technical context (code/markup, not prose)
 * 2. Word boundaries or technical delimiters around the marker
 * 3. Higher specificity for generic terms
 */
function isInTechnicalContext(html: string, marker: string): boolean {
  const m = marker.toLowerCase();
  const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  
  // Word boundary regex - marker must be standalone word
  const wordBoundaryMarker = `\\b${escaped}\\b`;
  
  // Inside <script>...</script> with word boundaries
  const scriptRe = new RegExp(`<script[^>]*>[^<]*${wordBoundaryMarker}[^<]*</script>`, "i");
  if (scriptRe.test(html)) return true;

  // Inside <meta> tags with word boundaries  
  const metaRe = new RegExp(`<meta[^>]*${wordBoundaryMarker}[^>]*>`, "i");
  if (metaRe.test(html)) return true;

  // In attribute values with technical delimiters (class names, IDs use -/_ separators)
  const attrRe = new RegExp(
    `(class|id|data-[a-z-]+|href|src|name|aria-label)\\s*=\\s*"[^"]*(?:^|[\\s\\-_./]|\\b)${escaped}(?:[\\s\\-_./]|\\b|$)[^"]*"`,
    "i"
  );
  if (attrRe.test(html)) return true;

  // JSON keys/values with proper delimiters
  const jsonRe = new RegExp(`"${escaped}"\\s*:|:\\s*"${escaped}"(?:\\s*[,}]|$)`, "i");
  if (jsonRe.test(html)) return true;

  // URL paths/parameters with delimiters
  const urlRe = new RegExp(`(?:https?://[^\\s"'<>]*[/?#&]|/)${escaped}(?:[/?#&]|$)`, "i");
  if (urlRe.test(html)) return true;

  // CSS class names with proper word boundaries  
  const cssClassRe = new RegExp(`class\\s*=\\s*"[^"]*(?:^|\\s)${escaped}(?:\\s|$)[^"]*"`, "i");
  if (cssClassRe.test(html)) return true;

  return false;
}

/**
 * Detect ATS type from DOM content with enhanced signature detection.
 *
 * BUG-G1 fix: Enhanced technical context checking with word boundaries and
 * more specific signatures to prevent false positives from prose mentions.
 */
function detectFromDOM(html: string): ATSDetectionResult | null {
  // Platform-owned script/style assets identify the frontend more reliably than
  // embedded Apply links to a different ATS or generic data-automation attributes.
  const assets = html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi);
  for (const [, asset] of assets) {
    try {
      const host = new URL(asset, "https://unknown.invalid").hostname.toLowerCase();
      if (host === "phenompeople.com" || host.endsWith(".phenompeople.com") || host === "phenom.com" || host.endsWith(".phenom.com")) {
        return { type: "phenom", confidence: "medium", evidence: `Phenom frontend asset host: ${host}` };
      }
    } catch { /* malformed asset */ }
  }
  // Workday indicators - more specific signatures to avoid false matches
  if (
    isInTechnicalContext(html, "wd-myworkdayjobs") ||
    isInTechnicalContext(html, "myworkdayjobs.com") ||
    html.includes("wd1.myworkdayjobs") ||
    html.includes("wd5.myworkdayjobs") ||
    html.includes("wd12.myworkdayjobs") ||
    (isInTechnicalContext(html, "workday") && (
      html.includes("workday.com") || 
      html.includes("wd-component") ||
      html.includes("wd-popup") ||
      html.includes("data-automation")
    ))
  ) {
    return { type: "workday", confidence: "high", evidence: "DOM contains Workday job-board signature with technical context" };
  }

  // Oracle HCM indicators - enhanced with specific Oracle patterns
  if (
    isInTechnicalContext(html, "oracle-hcm") ||
    isInTechnicalContext(html, "hcm-ui") ||
    isInTechnicalContext(html, "oj-cmp-") ||
    isInTechnicalContext(html, "fa-ext-rv") ||
    html.includes("oraclecloud.com") ||
    html.includes("hcmUI") ||
    html.includes("candidateexperience") ||
    (isInTechnicalContext(html, "oracle") && html.includes("hcm"))
  ) {
    return { type: "oracle-hcm", confidence: "high", evidence: "DOM contains Oracle HCM signature with technical context" };
  }

  // iCIMS indicators - enhanced detection  
  if (
    isInTechnicalContext(html, "icims") ||
    isInTechnicalContext(html, "iCIMS") ||
    html.includes("icims_content_iframe") ||
    html.includes("icims.com") ||
    html.includes("icimscommand")
  ) {
    return { type: "icims", confidence: "high", evidence: "DOM contains iCIMS signature with technical context" };
  }

  // Eightfold indicators
  if (
    isInTechnicalContext(html, "eightfold") ||
    isInTechnicalContext(html, "talentsuite") ||
    html.includes("eightfold.ai") ||
    html.includes("talentsuite.eightfold")
  ) {
    return { type: "eightfold", confidence: "high", evidence: "DOM contains Eightfold signature with technical context" };
  }

  // Greenhouse indicators
  if (
    isInTechnicalContext(html, "greenhouse") ||
    html.includes("greenhouse.io") ||
    html.includes("gh-job-board") ||
    html.includes("gh_widget") ||
    html.includes("boards.greenhouse") ||
    isInTechnicalContext(html, "gh-")
  ) {
    return { type: "greenhouse", confidence: "high", evidence: "DOM contains Greenhouse signature with technical context" };
  }

  // SmartRecruiters indicators
  if (
    isInTechnicalContext(html, "smartrecruiters") ||
    html.includes("smartrecruiters.com") ||
    html.includes("sr-widget") ||
    html.includes("smartrecruiterscareers")
  ) {
    return { type: "smartrecruiters", confidence: "high", evidence: "DOM contains SmartRecruiters signature with technical context" };
  }

  // Ashby indicators  
  if (
    isInTechnicalContext(html, "ashby") ||
    html.includes("ashbyhq.com") ||
    (html.includes("ashby") && html.includes("posting-api"))
  ) {
    return { type: "ashby", confidence: "high", evidence: "DOM contains Ashby signature with technical context" };
  }

  // SuccessFactors indicators
  if (
    isInTechnicalContext(html, "successfactors") ||
    html.includes("successfactors.com") ||
    isInTechnicalContext(html, "sf-wd")
  ) {
    return { type: "successfactors", confidence: "high", evidence: "DOM contains SuccessFactors signature with technical context" };
  }

  // Phenom indicators - enhanced to avoid false matches with "phenom" word in prose
  if (
    html.includes("phenom.com") ||
    html.includes("phenompeople.com") ||
    isInTechnicalContext(html, "phenompeople") ||
    isInTechnicalContext(html, "phenom-people") ||
    (isInTechnicalContext(html, "phenom") && (
      html.includes("phenom.com") ||
      html.includes("phenom-") ||
      html.includes("data-phenom")
    ))
  ) {
    return { type: "phenom", confidence: "high", evidence: "DOM contains Phenom signature with technical context" };
  }

  // Taleo indicators
  if (
    html.includes("taleo.net") ||
    isInTechnicalContext(html, "taleo") ||
    isInTechnicalContext(html, "tbe-taleo") ||
    isInTechnicalContext(html, "orgunit")
  ) {
    return { type: "taleo", confidence: "high", evidence: "DOM contains Taleo signature with technical context" };
  }

  // Avature indicators
  if (
    html.includes("avature.net") ||
    html.includes("avature.com") ||
    isInTechnicalContext(html, "avature")
  ) {
    return { type: "avature", confidence: "high", evidence: "DOM contains Avature signature with technical context" };
  }

  // Lever indicators  
  if (
    html.includes("lever.co") ||
    isInTechnicalContext(html, "lever") ||
    html.includes("lever-")
  ) {
    return { type: "lever", confidence: "high", evidence: "DOM contains Lever signature with technical context" };
  }

  return null;
}

/**
 * Detect ATS type from a URL and optional DOM content.
 * Combines URL-based and DOM-based detection for maximum accuracy.
 *
 * BUG-G1 fix (kruz-v1.6-generic-navigation.md): when the URL has no high-
 * confidence match and only the DOM-technical-context match fires, the result
 * is downgraded to `low` confidence so the calling agent can distinguish
 * "we know this is a Workday portal" from "we saw a Workday signature in some
 * script tag on a site whose URL says nothing about Workday". This prevents
 * the silent misclassification cascade observed on Naukri, Wikipedia, Reddit.
 */
export function detectATS(url: string, dom?: string): ATSDetectionResult {
  // Try URL-based detection first (high confidence)
  const urlResult = detectFromURL(url);
  if (urlResult && urlResult.confidence === "high") return urlResult;

  // Try DOM-based detection if available
  if (dom) {
    const domResult = detectFromDOM(dom);
    if (domResult) {
      if (domResult.confidence === "medium") return domResult;
      // If we have no URL signature, downgrade to low confidence so callers
      // can tell "the URL has no ATS signature and we inferred from the DOM".
      // If we have a high-confidence URL signature, that's been returned
      // already; if we have a low/medium URL signature, the DOM match is
      // corroborating and the URL evidence is the primary anchor.
      if (!urlResult) {
        return {
          type: domResult.type,
          confidence: "low",
          evidence: `DOM only: ${domResult.evidence} (no URL signature for ${domResult.type})`,
        };
      }
      return domResult;
    }
  }

  // Fall back to URL-based medium/low confidence
  if (urlResult) return urlResult;

  return { type: "unknown", confidence: "low", evidence: "No ATS markers detected in URL or DOM" };
}

/**
 * Get ATS-specific navigation strategy hints.
 */
export function getATSStrategy(atsType: ATSType): {
  searchMethod: "url-params" | "js-evaluate" | "api-endpoint" | "country-path";
  paginationMethod: "url-params" | "scroll" | "click-next" | "api-endpoint";
  filterMethod: "url-params" | "js-evaluate" | "click-filter" | "country-path";
  notes: string[];
} {
  switch (atsType) {
    case "workday":
      return {
        searchMethod: "url-params",
        paginationMethod: "url-params",
        filterMethod: "url-params",
        notes: [
          "Workday supports URL-based search with ?q= and locationCountry params",
          "Pagination via startRecord parameter",
          "Filter facets available in cxs API response",
        ],
      };

    case "oracle-hcm":
    case "oracle-orc":
      return {
        searchMethod: "js-evaluate",
        paginationMethod: "scroll",
        filterMethod: "js-evaluate",
        notes: [
          "Oracle HCM ignores URL keyword params — must fill search input via JS",
          "Dispatch input/change events after filling",
          "Wait for DOM mutation, not network idle",
          "Job detail pages work once you have direct URL",
          "Empty keyword search may return HTTP 500",
        ],
      };

    case "icims":
      return {
        searchMethod: "country-path",
        paginationMethod: "click-next",
        filterMethod: "country-path",
        notes: [
          "iCIMS location filter uses internal IDs, not text strings",
          "Use country-specific landing page paths (e.g., /global/en/india/etr-jobs)",
          "Avoid URL-based location params — they silently fail",
        ],
      };

    case "avature":
      return {
        searchMethod: "api-endpoint",
        paginationMethod: "api-endpoint",
        filterMethod: "js-evaluate",
        notes: [
          "Avature SPAs often don't render job listings in headless browsers",
          "Try longer networkidle wait (30s+)",
          "Direct job URLs may 404 — navigate via search page instead",
          "Use firecrawl as fallback if SPA doesn't render",
        ],
      };

    case "eightfold":
      return {
        searchMethod: "url-params",
        paginationMethod: "scroll",
        filterMethod: "url-params",
        notes: [
          "Eightfold AI portals work well with URL-based search",
          "Job cards are clickable and render properly",
          "Pagination via infinite scroll",
        ],
      };

    case "greenhouse":
      return {
        searchMethod: "api-endpoint",
        paginationMethod: "api-endpoint",
        filterMethod: "url-params",
        notes: [
          "Greenhouse has a JSON API: /v1/boards/<company>/jobs",
          "Can enumerate all jobs via API before browser verification",
          "URL-based department/location filtering",
        ],
      };

    case "lever":
      return {
        searchMethod: "api-endpoint",
        paginationMethod: "api-endpoint",
        filterMethod: "url-params",
        notes: [
          "Lever has a JSON API: /v0/postings/<company>",
          "Can enumerate all jobs via API",
          "URL-based team/location filtering",
        ],
      };

    case "ashby":
      return {
        searchMethod: "api-endpoint",
        paginationMethod: "api-endpoint",
        filterMethod: "url-params",
        notes: [
          "Ashby has a job board API: /posting-api/job-board/<company>",
          "Can enumerate all jobs via API",
          "URL-based department filtering",
        ],
      };

    default:
      return {
        searchMethod: "url-params",
        paginationMethod: "click-next",
        filterMethod: "url-params",
        notes: ["Unknown ATS — try URL-based search first, fall back to UI navigation"],
      };
  }
}
