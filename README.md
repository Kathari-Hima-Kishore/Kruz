# Kruz — Headed Browser Automation MCP Server

A high-speed, low-token, accurate headed browser automation server for AI agents via the Model Context Protocol (MCP).

## What It Does

Launches a **visible Chrome browser** and exposes **44 tools** that let an AI agent navigate, interact with, and extract data from any website — including local HTML files, Workday, Oracle HCM, iCIMS, Greenhouse, Lever, Ashby, SmartRecruiters, SuccessFactors, Phenom, Taleo, Avature, and Eightfold career portals.

Optimized for the `job-finder-v9` skill flow: ATS detection, full-feed enumeration (Phase 1.5/3a), posting-page liveness verification (Phase 3c), result-card summarization (Phase 3b batching), stable pagination (Phase 3), and body-based experience/seniority classification with confidence scoring.

## Quick Start

### 1. Install prerequisites
- **Node.js** v18+: https://nodejs.org
- **Google Chrome**: https://www.google.com/chrome/

### 2. Setup

```bash
cd kruz
npm install
npm run build
```

The `postinstall` hook runs `install.mjs`, which auto-detects Chrome, generates `opencode.json`, and registers Kruz as an MCP server.

### 3. Use it

```bash
opencode
# Then: "Use kruz to open https://example.com"
```

If Kruz is already in your `opencode.json`, restart opencode to pick up the rebuilt `dist/`.

## Running

```bash
npm start          # Production (compiled)
npm run dev        # Development (tsx)
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/
```

## Tools (44 registered)

The authoritative tool list is returned by MCP `tools/list` and `kruz://tools`.
`server.info` reports the same registry count. The Azure addition is
`azureCV.clickText({text: "SEARCH JOBS"})`; the equivalent explicit mode is
`page.click({target: {text: "SEARCH JOBS"}, ocr: true})`.

Use normal selector clicks first. OCR sends a viewport screenshot to Azure,
requires a unique exact text line, scales image pixels into viewport CSS pixels,
and refuses Apply controls. Clear overlays explicitly and scroll the text into
view first. `clicked: true, verified: false` means an input was dispatched, not
that the destination or business action has been verified. Inspect the resulting
page. Never automatically repeat a click after an uncertain response.

Set `AZURE_CV_ENDPOINT` and `AZURE_CV_KEY` in the MCP server's environment.
MCP launchers may filter inherited variables; forward these two variables explicitly.
Credentials are read during initialization rather than module import.

`azureCVHelper.js` re-exports the built implementation. Programmatic callers use
`cvEnhancedClick(createKruzCVBridge(engine), text)` and inspect its result object;
the former fictional `kruz.page.screenshot/clickAt` object is no longer required.
An optional `verify` callback performs real post-click verification.

## Kruz Ctrl extension

This workspace's `config.json` enables the bundled `./extension` directory.
Paths in configuration resolve from the project root, independent of the MCP
launcher's working directory. `BROWSER_EXTENSION_PATH` overrides this path.
Chrome must support `Extensions.loadUnpacked`; Kruz uses a private debugging pipe
and Chrome's extension-debugging flag when an extension is configured. Failure
to load is reported rather than silently pretending the extension is active.

Check `server.info.config.engine`, `extension_configured`, and `extension_ready`
on an ordinary web page. For an explicit page-side check, evaluate
`window.__kruz__.ping()` or `window.__kruz__.queryOne("h1")` through Kruz.
Native clicking, selection, and scrolling use Kruz's Puppeteer-backed browser
input implementation; loading the extension does not turn synthetic JS events
into trusted browser input. No ChatGPT browser extension is involved.

After rebuilding, close the old Kruz session and reconnect the MCP server.

## Targeting System

Every interactive tool accepts a `target` object with semantic selectors (resolved in priority order):

```json
{
  "target": {
    "role": "button",
    "name": "Submit"
  },
  "fallback": {
    "text": "Submit",
    "css": "button.submit"
  }
}
```

**Resolution order:** ref → role+name → label → placeholder → text → testid → name → id → css → xpath

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_PATH` | Auto-detected | Chrome executable path |
| `BROWSER_HEADLESS` | `false` | Run headless |
| `BROWSER_VIEWPORT_WIDTH` | `1280` | Viewport width |
| `BROWSER_VIEWPORT_HEIGHT` | `720` | Viewport height |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent profile directory |
| `BROWSER_TIMEOUT_MS` | `30000` | Default timeout |
| `BROWSER_USER_AGENT` | (Playwright default) | Custom User-Agent |
| `BROWSER_LOCALE` | `en-US` | Browser locale |
| `BROWSER_PROXY` | (none) | Proxy server URL |
| `BROWSER_DOWNLOAD_DIR` | `./downloads` | Download directory |
| `SAFETY_POLICY` | `off` | `strict`, `lenient`, or `off` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `OBSERVATION_CACHE_SIZE` | `100` | LRU cache size for page observations |

### File Config

Create `config.json` in the project root to override defaults:

```json
{
  "browserPath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "headless": false,
  "viewportWidth": 1280,
  "viewportHeight": 720,
  "safetyPolicy": "off"
}
```

Environment variables take precedence over `config.json`.

## Architecture

```
src/
├── mcp/
│   ├── server.ts      # MCP server with Zod schemas for all 75 tools
│   └── router.ts      # Request routing to handlers (25s route timeout)
├── browser/
│   ├── launcher.ts    # Chrome launch (headed, persistent profile)
│   ├── controller.ts  # Page actions (75 methods)
│   ├── selectors.ts   # Semantic selector resolution (10-level priority)
│   ├── ats-detector.ts # ATS family detection (URL + DOM)
│   └── ats-tools.ts   # Phase 1.5/3a/3b/3c ATS helpers + verdict logic
├── extractor/
│   ├── observer.ts    # Compact page observation (cache + delta)
│   ├── cache.ts       # LRU observation cache
│   ├── delta.ts       # Change detection between observations
│   └── fidelity.ts    # Exact-fidelity extraction with provenance
├── session/
│   └── manager.ts     # Session lifecycle and page tracking
├── safety/
│   └── layer.ts       # Action classification and human takeover
├── types/
│   ├── schema.ts      # Zod schemas for all inputs
│   ├── observation.ts # Observation type definitions
│   └── extraction.ts  # Extraction result envelopes
├── config.ts          # Environment/file-based configuration
└── index.ts           # Entry point
```

## job-finder-v9 Phase Coverage

| Phase | Description | Tools |
|---|---|---|
| 1.5 / 3a | ATS register + full feed/sitemap enumeration | `ats.detect`, `ats.enumerate`, `network.body` |
| 2 | Ground check (facet matrix, category enumeration) | `page.open`, `page.observe`, `page.click`, `page.select` |
| 3a | Exhaustive enumeration + reconciliation | `ats.paginate`, `ats.summarize` |
| 3b | Relevance verdict from body (experience + job family + cap) | `page.extractExperience` (delegates to `extractExperienceSignals` in `ats-tools.ts`) |
| 3c | Posting-page verification (liveness probe + terminal state) | `ats.verifyPosting` |
| 3d | Terminal state per posting (`live/closed/broken/login_required/captcha_required`) | `ats.verifyPosting` |

The `page.extractExperience` tool now delegates to the same thorough `extractExperienceSignals` regex set used by `ats.verifyPosting`, so it correctly parses "0-3 years", "2+ years experience", "recent graduate", "entry-level", "fresher", "new grad", etc. and reports a `confidence` field: `"high"` (level + years both clear), `"low"` (only one), `"none"` (ambiguous/missing — no wrong guess).

## Security Notes

- Browser runs **headed by default** so you can see what Kruz is doing.
- `file://` URLs are supported for local file testing.
- Safety layer blocks destructive actions (delete, purchase, etc.) in `strict` mode; `off` by default.
- No passwords or session tokens are exposed to the AI agent.
- Human takeover is triggered for login, CAPTCHA, and 2FA pages.
- `session.attach` lets you drive an existing logged-in Chrome via CDP without sharing credentials.

## License

MIT
