import { KNOWN_TOOLS } from "./tool-names.js";
import { KRUZ_VERSION } from "../version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ToolRouter } from "./router.js";
import { loadConfig } from "../config.js";

const T = z.object({
  ref: z.string().optional(), css: z.string().optional(),
  role: z.string().optional(), name: z.string().optional(),
  text: z.string().optional(), label: z.string().optional(),
  placeholder: z.string().optional(), testid: z.string().optional(),
  nameAttr: z.string().optional(), id: z.string().optional(),
  fallback: z.object({ text: z.string().optional(), css: z.string().optional(), xpath: z.string().optional() }).optional(),
  scope: z.string().optional(),
});

const F = z.object({ text: z.string().optional(), css: z.string().optional(), xpath: z.string().optional() }).optional();

export async function createServer(): Promise<{ server: McpServer; router: ToolRouter }> {
  const r = new ToolRouter();
  const s = new McpServer({ name: "kruz", version: KRUZ_VERSION });
  const registered = new Set<string>();
  const t = (name: string, desc: string, schema: Record<string, any>, handler: (a: any) => any = (a: any) => r.route(name, a)) => {
    if (!KNOWN_TOOLS.has(name) || registered.has(name)) throw new Error(`Invalid tool registration: ${name}`);
    registered.add(name);
    return s.tool(name, desc, schema, async (args: any) => handler(args));
  };

  // Session
  t("session.create", "Create a headed Chrome session, or reuse this server instance's live session without navigating or applying launch options. Close the session first to change launch settings.", {
    profile_dir: z.string().optional(), viewport_width: z.number().optional(), viewport_height: z.number().optional(),
    headless: z.boolean().optional(), user_agent: z.string().optional(), locale: z.string().optional(),
    proxy: z.string().optional(), download_dir: z.string().optional(), startup_url: z.string().optional(),
  });
  t("session.status", "Get session state, active tabs, page info.", {});
  t("session.close", "Close browser and cleanup.", { graceful: z.boolean().optional() });

  // Navigation — page.open only. Re-open the same URL to reload; history
  // back/forward is never needed for portal sweeps (leads are URLs, revisited directly).

  // Navigation
  t("page.open", "Navigate to URL (http, https, file://). Returns as soon as real rendered content is detected — a body-text/title poll every 250ms up to 15s (NOT a lifecycle-event wait; never deadlocks on slow portals). Check the returned '_ready' field for the actual observed state; if '_ready' is false, inspect with page_observe instead of looping navigate.", { url: z.string().min(1), wait_for: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().describe("Wait condition. Default: domcontentloaded. 'commit' returns after the first response; useful for slow portals behind bot-mitigation."), timeout_ms: z.number().optional().describe("Navigation timeout ms (default: 45000, max 60000). Raise for slow career portals (Siemens, Oracle HCM, Workday)."), detect_redirect: z.boolean().optional().describe("Set true when opening a job-detail deep link: flags a silent bounce back to the listing page (Accenture-style pattern).") });

  // Multi-tab (parallel boards / keep-JD-open while verifying)
  t("page.newTab", "Open a new tab and switch active to it. Use for parallel job boards or to stage a JD to verify while keeping the results list open.", { url: z.string().optional().describe("URL to load in the new tab (optional)") });
  t("page.switchTab", "Switch the active page to another open tab (parallel work).", { page_id: z.string().describe("Tab id from page.listTabs (e.g. 'p2')") });
  t("page.listTabs", "List all open tabs with id/url/title/active flag.", {});
  t("page.closeTab", "Close an open tab; active switches to the next remaining.", { page_id: z.string().describe("Tab id to close (e.g. 'p2')") });

  // Observe — single source of truth for "what is on screen". page.find was
  // redundant (observe + a target does the same job).
  t("page.observe", "Get compact page observation. Call FIRST to see elements.", {
    scope: z.string().optional().describe("CSS selector, or: main, nav, header, footer, dialog, form, table"),
    detail: z.enum(["minimal", "standard", "full"]).optional().describe("Detail level (default: minimal)"),
  });

  // Click — semantic target click (preferred: scrolls into view, force-retries
  // through overlays, stale-ref recovery). clickAt is the coordinate fallback
  // fed by computerUseList/Snapshot grounding.
  t("page.click", "Click a unique target, scrolling it into view. Known safe overlays are dismissed only when they obstruct the target, then the click is retried once. Reports click dispatch separately from rendered navigation; follows only a new tab opened by this page. Use wait_until for a specific destination/content predicate. ocr:true uses Azure directly; ocr_fallback:true uses it only when a text target was not found before dispatch. OCR sends a viewport screenshot to Azure and refuses Apply controls.", {
    target: T, fallback: F, scope: z.string().optional(), timeout_ms: z.number().optional(),
    ocr: z.boolean().optional(),
    ocr_fallback: z.boolean().optional(), dismiss_overlays: z.boolean().optional(),
    wait_for: z.enum(['auto','navigation','none']).optional(),
    wait_until: z.string().optional().describe('JavaScript predicate for the desired resulting page state; no automatic re-click if it times out.'),
    wait_timeout_ms: z.number().min(500).max(30000).optional(), follow_new_tab: z.boolean().optional(),
    button: z.enum(["left", "right", "middle"]).optional(), click_count: z.number().optional(),
    force: z.boolean().optional(), ignore_visibility: z.boolean().optional(),
  });

  t("azureCV.clickText", "Click unique visible text using Azure OCR on a viewport screenshot. Explicit fallback after selectors fail; clear overlays first. Never clicks Apply. Reports dispatch, not verified website success.", { text: z.string().min(1), timeout_ms: z.number().positive().max(10000).optional() });

  // Click - coordinate based only
  t("page.clickAt", "Click at exact pixel coordinates on the page.", {
    x: z.number().describe("X coordinate"), y: z.number().describe("Y coordinate"), button: z.enum(["left", "right", "middle"]).optional(),
  });

  // Computer-use grounding — List (poll) + Snapshot (one-call url+targets).
  // Mark/ClearMarks/ScrollTo deleted: screenshots-with-badges and scroll-to-index
  // are never used by portal sweeps (observe + scroll covers them, fewer round-trips).
  t("page.computerUseList", "List every interactive element in the current viewport as JSON: [{i, role, text, x, y, w, h}]. Coordinates are CSS pixels (same as clickAt). Re-run after navigation or scroll — coords go stale on re-render.", {});
  t("page.computerUseSnapshot", "One-call CUA-loop step 1: returns {url, scrollX, scrollY, vw, vh, targets[]} in a single round-trip. Cheaper than calling list separately.", {});

  // Keyboard & Text — fill (instant, React-safe) + press (Enter/Tab/Escape etc.).
  // page.type (char-by-char) and pressSequence deleted: fill+press covers every
  // portal search/filter interaction in 2 calls instead of 30+ keystroke round-trips.
  t("page.fill", "Fill a form field instantly (no keystroke events). Best for React/Angular.", {
    target: T, value: z.string().describe("Value to set"), fallback: F, scope: z.string().optional(), timeout_ms: z.number().optional(),
    force: z.boolean().optional().describe("Fill elements even if they are not actionable"),
    ignore_visibility: z.boolean().optional().describe("BUG-G2 fix: Fill hidden inputs (display:none) with automatic reveal detection"),
  });
  t("page.press", "Press a single key or combo. Key names: Enter, Tab, Escape, ArrowUp, Control+a, etc.", {
    key: z.string().describe("Key name: Enter, Tab, Escape, ArrowUp, or a + separated combo like Control+a, Control+Shift+s, Alt+F4."),
    target: T.optional().describe("Focus this element first (optional)"), fallback: F, scope: z.string().optional(), timeout_ms: z.number().optional(),
  });

  // Form — select + check only. Portals filter via dropdowns/checkbox facets;
  // sliders, steppers, date/color pickers, file uploads and form submits never
  // appear in job-portal sweeps (Apply is never clicked).

  // Form
  t("page.select", "Select a native dropdown, custom option, or radio/check menu item by value, label, or index; verify selected state or trigger value. Honors aria-controls when present.", {
    target: T, fallback: F, value: z.string().optional(), label: z.string().optional(), index: z.number().optional(),
    scope: z.string().optional(), timeout_ms: z.number().optional(),
  });
  t("page.check", "Check a checkbox. Works on native <input type=checkbox> AND custom SPA checkboxes (Snowflake, Greenhouse filters). Falls back to click if not a native checkbox.", { target: T, fallback: F, scope: z.string().optional(), timeout_ms: z.number().optional() });

  // Scroll — scroll (nudge) + paginate (drive to terminal state). scrollToBottom
  // and scrollAll deleted: paginate subsumes both (infinite-scroll + load-more +
  // next-page in one call).

  // Scroll
  t("page.scroll", "Scroll the page or an element.", {
    direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().optional().describe("Pixels (default: 500)"),
    target: T.optional(), fallback: F,
  });
  // Overlays + dialogs — handleOverlays dismisses banners/widgets; dialog answers
  // a pending native alert/confirm/prompt. setDialogPolicy deleted (dialog covers
  // the need; a standing policy hid real CAPTCHA/login walls from the run).
  t("page.paginate", "Enhanced pagination handler for job portals and search results. Handles infinite scroll and traditional pagination.", {
    max_pages: z.number().optional().describe("Maximum pages to process (default: 10)"),
    wait_ms: z.number().optional().describe("Wait between pagination actions (default: 1000)"),
    load_more_selector: z.string().optional().describe("Specific selector for load more button"),
    next_selector: z.string().optional().describe("Specific selector for next page button"),
    infinite_scroll: z.boolean().optional().describe("Use infinite scroll as fallback (default: true)"),
  });
  t("page.handleOverlays", "Explicitly scan known cookie, newsletter, chat, and app banners in a bounded pass. Click only scoped dismissal controls, verify disappearance, and report unresolved overlays. Never toggle chat launchers. Optional JS-dialog handling dismisses pending dialogs.", {
    close_cookie_banner: z.boolean().optional().describe("Try to dismiss cookie consent banner (default: true)"),
    close_newsletter_popup: z.boolean().optional().describe("Try to close newsletter popups (default: true)"),
    close_chat_widget: z.boolean().optional().describe("Try to close chat widgets (default: true)"),
    close_app_prompt: z.boolean().optional().describe("Try to dismiss app-install banners (default: true)"),
    handle_js_alerts: z.boolean().optional().describe("Handle JavaScript alert/confirm/prompt dialogs (default: true)"),
  });
  // Wait — content-predicate waits only (never lifecycle proxies on SPAs).
  t("page.wait", "Wait for a real condition. PREFER condition:'content' — polls a JS predicate in-page every interval until truthy (matches what is actually rendered, NOT a lifecycle proxy). 'element' waits for a visible element. load/domcontentloaded check document.readyState (never hang on an already-loaded page). networkidle auto-converts to domcontentloaded — never use it on SPAs with WebSockets.", {
    condition: z.enum(["load", "domcontentloaded", "networkidle", "element", "navigation", "hidden", "timeout", "content"]),
    predicate: z.string().optional().describe("JS expression evaluated in-page every interval_ms (condition:'content' only). Default: document.body?.innerText?.trim().length > 10. Examples: 'document.querySelector(\".job-card\")', 'document.querySelectorAll(\"tr\").length > 5'. Escapement: wrap in single quotes inside the string."),
    interval_ms: z.number().optional().describe("Poll interval for condition:'content' (default: 250)"),
    target: T.optional(), fallback: F, timeout_ms: z.number().optional(), scope: z.string().optional(),
  });

  // Dialogs — answer a pending native dialog. hover/drag deleted: hover-menus are
  // opened via page.click, drag-and-drop never occurs on job portals.
  t("page.dialog", "Respond to a pending native dialog (confirm, prompt, alert). Call after the dialog appears; this does not install a future auto-response policy.", {
    action: z.enum(["accept", "dismiss"]).describe("accept=OK, dismiss=Cancel"),
    value: z.string().optional().describe("Value for prompt() dialogs"),
  });

  // JS — evaluate is the SPA fallback (filter clicks, facet reads). readVariable
  // deleted: any window read is one evaluate call. Frame tools deleted: portals
  // render listings in the main frame; cross-origin iframes are login/captcha
  // walls (terminal states, not content to pierce).
  t("page.evaluate", "Execute JavaScript in page context. Returns result as JSON.", {
    expression: z.string().describe("JavaScript expression or function to evaluate"),
  });

  // Extract — extract.text only. extract.target deleted (text+scope does the job).
  // Screenshot deleted: text-model runs never look at pixels (badges/grounding
  // pairs with clickAt coordinates, not images).
  t("extract.text", "Extract exact text from element or scope with provenance.", { target: T.optional(), fallback: F, scope: z.string().optional(), timeout_ms: z.number().optional() });

  // ATS-specific helpers
  t("page.oracleHCMSearch", "Oracle HCM Cloud search helper. Fills search input via JS and dispatches native input events (URL params are silently ignored on Oracle HCM).", {
    keyword: z.string().describe("Search keyword (e.g. 'software engineer', 'react')"),
    wait_ms: z.number().optional().describe("Wait time after search in ms (default: 2000)"),
  });
  t("page.iCIMSSearch", "iCIMS search helper. Navigates to country-specific landing page first (iCIMS location filter uses internal IDs, not text strings).", {
    keyword: z.string().describe("Search keyword"),
    country_path: z.string().describe("Full URL to country-specific landing page (e.g. 'https://careers.company.com/global/en/india/etr-jobs')"),
    wait_ms: z.number().optional().describe("Wait time after search in ms (default: 2000)"),
  });
  t("page.extractExperience", "General-purpose experience/seniority extraction from job title text.", {
    title: z.string().describe("Job title to analyze"),
    body_text: z.string().optional().describe("Optional job description body text for additional signals"),
  });
  t("page.detectATS", "Auto-detect ATS type from current page URL and DOM. Returns ATS family (workday, oracle-hcm, icims, eightfold, etc.) and navigation strategy hints.", {});

  // ATS enumeration & verification — single detect entry (page.detectATS).
  // ats.detect deleted as a duplicate of page.detectATS.
  t("ats.enumerate", "Phase 1.5/3a: fetch the company's FULL job feed or sitemap via the live browser (same-origin, session cookies apply). Returns a compact job-ID baseline with title/location/department/posted-at for completeness reconciliation (C2). Handles Greenhouse/Lever/Ashby/SmartRecruiters JSON APIs and generic sitemap fallback for Oracle/SuccessFactors/iCIMS etc.", {
    ats: z.enum(["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "oracle-hcm", "oracle-orc", "icims", "avature", "eightfold", "successfactors", "phenom", "taleo", "unknown"]).describe("Detected ATS type (use page.detectATS to resolve if unknown)"),
    portal_url: z.string().describe("Canonical career-portal URL for the company (origin + path)"),
    company: z.string().optional().describe("Company slug/token if it cannot be derived from portal_url (e.g. Greenhouse board name, Lever/Ashby company token)"),
  });
  t("ats.verifyPosting", "Phase 3c: open a posting page and return its posting-page URL + title/company/location/body/Apply-present + terminal status (live/closed/broken/login_required/captcha_required), plus experience and job-family signals read from the body. NEVER clicks Apply or enters the flow — this is the liveness check that records the link to write out. Each call verifies in its own isolated tab. Callers MUST still confirm requested_url vs landed_url (identity_match) per result before trusting the body.", {
    url: z.string().describe("Posting page URL to verify live"),
  });
  t("ats.summarize", "Phase 3b batching: extract ALL job-card links + titles from the current results/listings page in one pass (no per-card open), so you can pre-filter obvious mismatches before spending an open-and-verify cycle on each candidate.", {});
  t("ats.paginate", "Phase 3: drive the results list to a stable terminal 'no more results' state. Default infinite-scrolls to bottom until height stabilizes; optionally force-clicks a 'load more'/'next' button repeatedly. Returns collected posting URLs + count and whether terminal is confirmed.", {
    max_scrolls: z.number().optional().describe("Max scroll/click rounds (default: 40)"),
    wait_ms: z.number().optional().describe("Wait between rounds in ms (default: 800)"),
    load_more_selector: z.string().optional().describe("CSS selector for a 'Load more' button to click repeatedly (preferred over scroll when present)"),
    next_selector: z.string().optional().describe("CSS selector for a 'Next page' button to click repeatedly"),
  });

  // Network body (read ATS feed JSON responses captured from traffic)
  t("network.body", "Return the captured HTTP response body for a network URL matching 'filter' (e.g. Workday cxs, Oracle sitemap, Lever postings, Greenhouse jobs). Reads full feed JSON/XML that isn't a simple GET-all. Pair with network.capture to ensure bodies are recorded.", {
    filter: z.string().describe("Regex/URL fragment of the request whose body to return (e.g. 'cxs', 'posting-api', 'greenhouse')"),
  });
  t("network.capture", "Enable/disable automatic capture of JSON/XML response bodies (for ATS feed enumeration). Default on. On: bodies for /json|xml|sitemap/ responses are retained.", {
    on: z.boolean().optional().describe("Set true to capture (default true), false to disable"),
  });

  // ATS JSON harvesters (v11 medium-product — direct API feeds)
  t("ats.greenhouseHarvest", "Fetch Greenhouse JSON API for a company. Returns direct-apply URLs for all open SWE roles.", {
    company: z.string().describe("Greenhouse board handle (e.g. 'razorpay', 'freshworks')"),
    query: z.string().optional().describe("Optional extra query params"),
  });
  t("ats.leverHarvest", "Fetch Lever JSON API for a company. Returns direct-apply URLs for all open SWE roles.", {
    company: z.string().describe("Lever handle (e.g. 'chargebee', 'mindtickle')"),
  });
  t("ats.ashbyHarvest", "Fetch Ashby JSON API for a company. Returns direct-apply URLs for all open SWE roles.", {
    company: z.string().describe("Ashby job-board handle (e.g. 'browserstack')"),
  });
  t("ats.smartRecruitersHarvest", "Fetch SmartRecruiters JSON API for a company. Returns direct-apply URLs.", {
    company: z.string().describe("SmartRecruiters company handle"),
  });
  t("ats.workdayHarvest", "Fetch Workday JSON API for a company. Returns direct-apply URLs.", {
    tenant: z.string().describe("Workday tenant (e.g. 'sprinklr')"),
    site: z.string().describe("Workday site (e.g. 'External')"),
    query: z.string().optional().describe("Search text"),
  });
  t("ats.bulkHarvest", "Fan out across companies and harvest ALL direct-apply URLs in under a minute.", {
    companies: z.array(z.object({ name: z.string().optional(), ats: z.string().optional(), handle: z.string().optional() })).optional().describe("Override list; empty = read target-companies.json"),
  });
  t("ats.discoverHandle", "Bug 4 fix: discover the real public board handle for a company (no credentials needed). Strategy: probe direct transforms, then scrape the public Greenhouse directory. For SmartRecruiters (no public directory) this is heuristic-only — fall back to ats.enumerate for unknown companies.", {
    ats: z.enum(["greenhouse", "smartrecruiters"]).describe("Which public ATS to discover a handle for"),
    company: z.string().describe("Company name as commonly known (e.g. 'The Trade Desk', 'Atlassian')"),
  });

  // Safety
  t("human.takeover", "Pause automation for manual action (login, CAPTCHA). Browser stays visible.", {
    message: z.string().optional(), timeout_ms: z.number().optional(),
  });
  // Safety — human.takeover only. action.confirm deleted: the safety layer is
  // log-only/autonomous (see router click path), so a confirm gate would just
  // stall portal sweeps waiting on a human that never comes.

  // Server info tool (no session required — for connection diagnostics)
  t("server.info", "Get Kruz server status, session state, and config. Use this to verify the server is connected. No browser session required.", {});

  // ── MCP Resources ──────────────────────────────────────────────────────
  // These make list_mcp_resources return meaningful data so agents can
  // verify Kruz is connected without falling back to platform-specific
  // commands like `claude mcp list` or `kilo mcp list`.

  const config = loadConfig();

  s.resource("kruz-info", "kruz://info", {
    description: "Kruz MCP server status, version, and uptime. Use to verify the server is connected.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: "kruz://info",
      mimeType: "application/json",
      text: JSON.stringify({
        name: "kruz",
        version: KRUZ_VERSION,
        status: "connected",
        uptime_seconds: Math.round((Date.now() - ((globalThis as any).__KRUZ_START__ ?? Date.now())) / 1000),
        platform: process.platform,
        node_version: process.version,
      }),
    }],
  }));

  s.resource("kruz-browser-status", "kruz://browser/status", {
    description: "Current browser session state, active pages, and connection health.",
    mimeType: "application/json",
  }, async () => {
    const sm = r.getSessionManager();
    const active = sm.getActive();
    let activePage = "about:blank";
    let pagesCount = 0;
    if (active?.engine) {
      try { activePage = await active.engine.url().catch(() => "about:blank"); } catch { /* ignore */ }
      try { pagesCount = (await active.engine.listTabs().catch(() => [])).length; } catch { /* ignore */ }
    }
    return {
      contents: [{
        uri: "kruz://browser/status",
        mimeType: "application/json",
        text: JSON.stringify({
          has_session: !!active,
          session_status: active?.status ?? "none",
          browser_connected: active?.engine?.connected ?? false,
          active_page: activePage,
          pages_count: pagesCount,
        }),
      }],
    };
  });

  s.resource("kruz-tools", "kruz://tools", {
    description: "List of browser automation tools exposed by this server.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: "kruz://tools",
      mimeType: "application/json",
      text: JSON.stringify({
        tools: [...KNOWN_TOOLS],
        total: KNOWN_TOOLS.size,
      }),
    }],
  }));

  const missing = [...KNOWN_TOOLS].filter(name => !registered.has(name));
  if (missing.length) throw new Error(`Missing tool registrations: ${missing.join(", ")}`);
  const transport = new StdioServerTransport();
  await s.connect(transport);
  return { server: s, router: r };
}
