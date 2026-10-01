# Kruz — Headed Browser Automation MCP Server

A reliable, verification-first MCP server that gives AI agents a **visible Chrome browser** to drive real websites. Kruz is not a computer-use vision loop: it is **deterministic selector-first control** with postcondition verification, recovery ladders, typed errors, and a human-in-the-loop handoff for login/CAPTCHA/2FA.

| | |
|---|---|
| **Version** | 1.7.1 |
| **Transport** | stdio (MCP JSON-RPC) |
| **Tools** | 49 registered |
| **Engine** | `puppeteer-core` + Chrome DevTools Protocol |
| **Node** | >= 18 |
| **License** | MIT |

> **Agent-facing docs:** [`SKILL.md`](./SKILL.md) is the runtime contract served to agents
> over MCP (`kruz://skill`) — read the interaction rules there before automating.
> [`MODEL_GUIDE.md`](./MODEL_GUIDE.md) is the deeper project-local manual with worked
> examples, recovery recipes and the ATS playbook.
> This README is the engineering/task-oriented overview.

---

## What It Does

Kruz launches a visible Chrome profile and exposes **49 tools** that let an agent navigate, observe, click, fill, select, extract, evaluate JavaScript, capture network responses, and run ATS (job-board) workflows across real sites — including Workday, Oracle HCM, iCIMS, Greenhouse, Lever, Ashby, SmartRecruiters, SuccessFactors, Phenom, Taleo, Avature, and Eightfold career portals.

Four properties define Kruz:

1. **Semantic targeting** — refs and role/name based locators, not brittle coordinates.
2. **Verified actions** — a click is not "done" when dispatched; it is checked against a postcondition (navigation, rendered destination, in-place change, new tab, dialog).
3. **Recovery ladders** — failed actions escalate: dismiss overlays → re-observe → visual click.
4. **Human-in-the-loop** — a headed browser, a control-status overlay, an input lock while the model acts, and explicit pause/resume/takeover.

---

## Quick Start

### 1. Prerequisites
- **Node.js** v18+ — https://nodejs.org
- **Google Chrome** — https://www.google.com/chrome/

### 2. Build

```bash
npm install
npm run build
```

### 3. Register with your MCP client

Add Kruz to your client config (example — `opencode.json` in this repo is already set up):

```json
{
  "mcp": {
    "kruz": {
      "type": "local",
      "command": ["node", "D:/project prototypes/Kruz/dist/index.js"],
      "cwd": "D:/project prototypes/Kruz",
      "enabled": true,
      "timeout": 60000
    }
  },
  "permission": { "kruz_*": "allow" }
}
```

Then restart the client and ask: *"Use kruz to open https://example.com."*

> After rebuilding `dist/`, close the old Kruz session and reconnect the MCP server.

### 4. Running

```bash
npm start          # Production (compiled dist/)
npm run dev        # Development (tsx, no build)
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/
npm test           # vitest run
```

---

## Tools (49 registered)

`KNOWN_TOOLS` (in `src/mcp/tool-names.ts`) is the single source of truth, enforced at startup against the actual registrations. MCP `tools/list` and the `kruz://tools` resource report the same set.

### Server & session
| Tool | Purpose |
|---|---|
| `server.info` | Server/session/config diagnostics (no session needed) |
| `session.create` | Create or reuse the headed Chrome session |
| `session.status` | Session state, tabs, navigation trace |
| `session.close` | Close the browser |
| `session.pause` | Release control for manual work (login/CAPTCHA/2FA) |
| `session.resume` | Hand control back to the model |

### Navigation & tabs
`page.open` · `page.newTab` · `page.switchTab` · `page.listTabs` · `page.closeTab`

### Observation
`page.observe` (scope + `detail`: `minimal` | `standard` | `full`) · `page.computerUseList` · `page.computerUseSnapshot`

### Clicking & input
`page.click` · `page.clickAt` · `page.fill` · `page.press` · `page.select` · `page.check` · `page.uncheck` · `page.scroll` · `page.paginate` · `page.wait`

### Page interaction
`page.handleOverlays` · `page.dialog` · `page.evaluate` · `page.frameObserve` · `page.frameEvaluate` · `extract.text`

### Site helpers
`page.oracleHCMSearch` · `page.iCIMSSearch` · `page.extractExperience` · `page.detectATS`

### Network
`network.capture` · `network.body`

### ATS / job hunting
`ats.enumerate` · `ats.verifyPosting` · `ats.summarize` · `ats.paginate` · `ats.greenhouseHarvest` · `ats.leverHarvest` · `ats.ashbyHarvest` · `ats.smartRecruitersHarvest` · `ats.workdayHarvest` · `ats.bulkHarvest` · `ats.discoverHandle` · `human.takeover`

---

## Targeting System

Every interactive tool accepts a `target` object. Resolution order:

**`ref` → `role`+`name` → `label` → `placeholder` → `text` → `testid` → `nameAttr` → `id` → `css` → `xpath` → fallback**

```json
{
  "target": { "role": "button", "name": "Submit" },
  "fallback": { "text": "Submit", "css": "button.submit" },
  "scope": "#checkout-form"
}
```

Notes:
- **Prefer refs.** `page.observe` returns a `ref` per element; refs survive minor DOM changes via a recovery ladder and are the most reliable input.
- **A ref is a promise.** `page.observe`, `page.probe`, and `AMBIGUOUS_TARGET` candidates all mint refs into **one per-session `RefRegistry`**, and every action tool resolves from that same registry. A ref you were just handed is therefore directly actionable.
- **Ambiguity is refused, not guessed.** If several visible elements match, Kruz returns `AMBIGUOUS_TARGET` with candidate refs rather than clicking the first. Pick a candidate ref, or narrow it with `scope` / a unique selector.
- **Verification is explicit.** `clicked: true` means input was dispatched. `verified: true` means a postcondition was observed (`verification: rendered_destination | target_disappeared | in_place_change | predicate`). `verified: false` with an `unverified_reason` means nothing changed — inspect the page before retrying.

### Accessible name is one shared implementation

Accessible name is **element identity**, so the observer and the action-path
matcher must not each compute it their own way. Both now embed the single
implementation in [`src/browser/accessible-name.ts`](./src/browser/accessible-name.ts),
embedded as a string into each in-page program. The two copies previously drifted
on five rules — `aria-labelledby` id count and precedence, whitespace collapsing,
the text-length cap, and whether a `<select>` is named from its own options — which
let one DOM node acquire two different logical identities depending on which
subsystem observed it.

Resolution order:

1. `aria-labelledby` (all referenced ids joined) — wins over `aria-label`
2. `aria-label`
3. associated `<label>`, with the control's own subtree text stripped, so
   `<label>Location<select>…</select></label>` is named `Location`, never
   `LocationBangalore`
4. `title`
5. `placeholder` (inputs and textareas only)
6. own text, whitespace-collapsed, up to 200 chars

A `<select>` is deliberately **not** named from its options: its options are the
control's value, not its label. A theme picker offering Auto/Light/Dark is named
`Theme` from its label, which is what both `page.observe` and `page.select` see.

`tests/integration/accessible-name-parity.test.ts` asserts both producers agree on
every rule above.

### Ref space is bounded

Refs are minted per observation (a `full` observe on a dense page is ~2000) and
every re-render mints a fresh set, so:

- `entries` is capped at **6000**, evicting oldest-first — the observation you are
  actually acting from is never what disappears
- counters **restart per document**, once the map is empty of the old document;
  that is the only moment id recycling is safe
- a retired ref returns `UNKNOWN_REFERENCE`, which is honest: it was minted long
  ago and is no longer offered

Ids are therefore small (`e1…e400`) rather than climbing to five digits across a
long session.

### The ref contract

Resolution walks a ladder and **never degrades into "act on whatever matched first"**:

| Tier | Basis |
|---|---|
| 1 | The exact live node, re-identified by its recorded path **and** verified against its recorded fingerprint (a path-only hit is positional and can rebind to a stranger after a re-render) |
| 2 | Exact semantic identity — canonical resolved destination (`href` compared after URL resolution, so relative / `../` / `#fragment` / query / `<base href>` all work), or testid / name / placeholder |
| 3 | Bounded re-resolution within the original match set, narrowed by identity, which must resolve to exactly one node |

Anything less is a structured failure with the true reason — `STALE_REFERENCE`, `DOCUMENT_CHANGED`, `AMBIGUOUS_TARGET`, `ELEMENT_NOT_VISIBLE`, `ELEMENT_DISABLED` — never a silent wrong-element action.

Identity is compared **after URL resolution**: Kruz records both the raw `href` attribute and the resolved `el.href`, because building `a[href="https://…"]` from a resolved URL matches nothing when the document says `href="3.13.html"`. That mismatch previously turned a valid ref into a false `STALE_REFERENCE` after a sidebar re-render.

Refs are scoped to a document. A ref minted in document A is refused in document B (`DOCUMENT_CHANGED`) even when the new page has a same-named element — that is a decoy, and it is never acted on for you.

---

## Action Semantics & Reliability

### Click verification (`verification` values)
| Value | Meaning |
|---|---|
| `rendered_destination` | Navigation completed and the destination rendered |
| `predicate` | Caller's `wait_until` JS predicate became true |
| `in_place_change` | Verified state change without navigation |
| `none_observed` | Nothing detected before the discovery window (1.5 s) |
| `new_tabs` | Click opened tabs (with `new_tabs` details) |
| `pending_dialog` | A native dialog is blocking |
| `wait_timed_out` | Overall deadline reached (`retry_safe: false`) |

### Recovery ladders
- **click**: `dismiss-overlays` → `re-observe` → `visual-click`
- **open**: `recreate-session` on `BROWSER_CRASHED`
- **type / fill**: `re-observe` → direct fill

### Error envelope
Every failure returns a typed envelope:

```json
{
  "code": "TARGET_NOT_FOUND",
  "message": "Element not found (css=#nope)",
  "retryable": false,
  "outcome": "refusal",
  "subsystem": "engine",
  "help": "Call page.observe to see what is actually on the page and pick a ref.",
  "trace": ["tool:page.click", "router", "controller"]
}
```

`outcome` distinguishes a **refusal** from a **failure**, and it decides whether
the result resolves or is raised as an error:

| `outcome` | Meaning | Delivery |
|---|---|---|
| `refusal` | Kruz did its job; the answer is "not safely". Nothing was guessed or clicked, and the payload carries what it was found (`candidates`, `region_candidates`). | resolves as a value — `if (!r.ok)` is sufficient, no `try/catch` |
| `failure` | The tool could not do its job: no session, crashed browser, timeout, unhandled exception. | raised as an error |

This split exists because `isError: true` is surfaced by most MCP clients as a
thrown exception with the JSON flattened into `Error.message`. That made the
documented `if (!r.ok)` branch unreachable and forced callers into `try/catch`
around tools that return values — and it made delivery depend on the client and
on which call it was, so code validated against the first call failed on the
second.

**Retryable** (the same call may succeed shortly): `NO_SESSION`, `BROWSER_CRASHED`, `ELEMENT_OBSCURED`, `ELEMENT_NOT_VISIBLE`, `ELEMENT_DISABLED`, `STALE_ELEMENT`, `ACTION_TIMEOUT`, `NO_MATCH`, `INTERNAL_ERROR`.

**Non-retryable** (replaying cannot work — reconsider or re-declare): `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `STALE_REFERENCE`, `DOCUMENT_CHANGED`, `UNKNOWN_REFERENCE`, `CONDITION_NOT_MET`, `INVALID_TARGET`, `INVALID_INPUT`, `UNKNOWN_TOOL`, `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_EDITABLE`, `OVERLAY_NO_DISMISS_INTENT`.

> The same taxonomy, with recovery recipes, is in [`SKILL.md`](./SKILL.md) — that is what
> agents read at runtime.

### Timeouts
25 s for most tools, 55 s for navigation-class tools (`session.create`, `page.open`, `page.reload`, `page.iCIMSSearch`, `ats.verifyPosting`).

### Timing
Actions report their own server-side timing, so callers can spot a stall without wrapping
calls in external timestamps. Diagnostic metadata only — never a decision input.

| Tool | Fields |
|---|---|
| `page.probe` | `probe_ms` |
| `page.open` | `_timing.total_ms` (+ `navigate_ms`, `poll_ms`) |
| `page.click` | `timing.total_ms`, `resolve_ms`, `action_ms`, `verify_ms` |
| `page.fill` | `timing.total_ms`, `resolve_ms`, `action_ms` |
| `page.scroll` | `timing.total_ms`, `action_ms` |
| `page.observe` | `timing.total_ms`, `generate_ms` |
| `page.handleOverlays` | `timing.total_ms`, `discovery_ms`, `dismissal_ms` |

---

## Human-in-the-loop

- A **blue overlay** shows when Kruz is controlling the browser. It is **realtime**: a heartbeat (`ping`) keeps it visible only while a tool call is in flight. The moment the call ends — the model is back to thinking/deciding — the overlay turns itself off within ~650ms, even if the server process dies.
- A **visible cursor** tracks every click and hover, so you can see exactly where the model is acting.
- Page input is locked only while the overlay is alive; when it disappears the page is fully interactive again.
- **`session.pause`** (or **`human.takeover`**) releases the lock and stands down for manual login/CAPTCHA/2FA; **`session.resume`** hands control back.
- There is no automatic takeover button — pausing is model/client initiated and explicit.

---

## Configuration

Environment variables always override `config.json` (project root).

| Variable | Default | Description |
|---|---|---|
| `BROWSER_PATH` | Auto-detected | Chrome executable path |
| `BROWSER_HEADLESS` | `false` | Run headless (Kruz is headed by design) |
| `BROWSER_VIEWPORT_WIDTH` / `BROWSER_VIEWPORT_HEIGHT` | `1280` / `720` | Viewport size |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent profile directory |
| `BROWSER_USER_AGENT` | `null` | Custom User-Agent |
| `BROWSER_LOCALE` | `en-US` | Browser locale |
| `BROWSER_PROXY` | `null` | Proxy server URL |
| `BROWSER_DOWNLOAD_DIR` | `./downloads` | Download directory |
| `BROWSER_TRACING` | `false` | Tracing |
| `BROWSER_SCREENSHOTS` | `false` | Screenshot capture |
| `BROWSER_TIMEOUT_MS` | `30000` | Default timeout |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SAFETY_POLICY` | `off` | `strict` \| `lenient` \| `off` |
| `OBSERVATION_CACHE_SIZE` | `100` | LRU cache size for observations |

```json
{
  "browserPath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "headless": false,
  "viewportWidth": 1280,
  "viewportHeight": 720,
  "safetyPolicy": "off"
}
```

---

## Architecture

```
                 MCP client (LLM agent)
                        │  JSON-RPC over stdio
                        ▼
  src/index.ts  (entry, signals, global error handlers)
      └─ createServer()  src/mcp/server.ts  ── 49 tools + 4 resources
           ├─ ToolRouter  src/mcp/router.ts
           │    ├─ sanitizeToolName (tool-names.ts)
           │    ├─ timeouts · retry ladders · control-lock lifecycle
           │    └─ SessionManager  src/session/manager.ts
           └─ handlers ── BrowserController  src/browser/controller.ts
                             ├─ BrowserEngine (interface)
                             │    └─ PuppeteerEngine
                             ├─ Observer / FidelityExtractor (src/extractor/)
                             ├─ click-completion.ts · selectors.ts
                             ├─ visual-cursor.ts · stealth.ts
                             ├─ overlays.ts · computer-use.ts
                             └─ ats-json.ts · ats-tools.ts
                        │  CDP / puppeteer-core
                        ▼
              Headed Chrome (persistent profile)
```

**Layering rule:** the router owns policy (retries, timeouts, verification, control lock); the controller owns semantics (targets, strictness, refs); the engine owns mechanics (CDP, input synthesis, probes); the observer owns perception.

| Path | Role |
|---|---|
| `src/index.ts` | Entry point; stdio; signal + global error handling |
| `src/config.ts` | Env + `config.json` resolution |
| `src/errors.ts` | Error taxonomy, envelopes, retry policies |
| `src/mcp/` | MCP server, tool registry, router, name sanitization |
| `src/session/manager.ts` | Session lifecycle, tabs, navigation trace |
| `src/browser/` | Engine contract, Puppeteer engine, controller, verification, cursor, stealth, ATS |
| `src/extractor/` | Observation (observer/cache/delta) + fidelity extraction |
| `src/safety/layer.ts` | Destructive-action classification |
| `src/browser/ref-registry.ts` | The ref contract: one mint/resolve authority per session |
| `src/browser/accessible-name.ts` | Canonical accessible name, embedded into both producers |
| `src/browser/inpage-scripts.ts` | Shared in-page matcher (probe + action path share these bytes) |
| `tests/` | Vitest unit + integration suites (fixtures included) |
| `SKILL.md` | Agent-facing runtime contract, served as `kruz://skill` |
| `MODEL_GUIDE.md` | Deeper local manual: worked examples, recipes, ATS playbook |

---

## ATS / job-finder Phase Coverage

| Phase | Description | Tools |
|---|---|---|
| 1.5 / 3a | ATS register + full feed/sitemap enumeration | `page.detectATS`, `ats.enumerate`, `network.body` |
| 2 | Ground check (facet matrix, category enumeration) | `page.open`, `page.observe`, `page.click`, `page.select` |
| 3a | Exhaustive enumeration + reconciliation | `ats.paginate`, `ats.summarize` |
| 3b | Relevance verdict from body (experience + job family + cap) | `page.extractExperience` |
| 3c | Posting-page verification (liveness probe) | `ats.verifyPosting` |
| 3d | Terminal state per posting (`live`/`closed`/`broken`/`login_required`/`captcha_required`) | `ats.verifyPosting` |

`page.extractExperience` and `ats.verifyPosting` share the same signal engine, parsing "0-3 years", "2+ years experience", "recent graduate", "entry-level", "fresher", "new grad", etc., with a `confidence` field: `"high"` (level + years), `"low"` (one), `"none"` (ambiguous — no wrong guess).

---

## Testing

```bash
npm test        # Vitest: unit + integration (live headed pages + local fixture)
```

- Unit suites cover the error taxonomy, visual cursor, ATS detection, session lifecycle, and regression fixes.
- Integration suites run against a **real headed Chrome** and `tests/fixtures/` (shadow DOM, dialogs, cookies, lists), plus a local HTTP server so relative-href resolution is exercised against a real base URL.
- Contract suites that guard the ref promise: `ref-contract`, `observe-ref-contract`, `href-identity`, `overlay-latency-timing`, `control-loop-fixes`, `reported-bugs`.

---

## Known Limitations

- **Observation caps** (`minimal` 120 / `standard` 400 / `full` 2000 elements) can starve very dense pages.
- **Closed shadow roots** are not pierced (open shadow roots and same-origin iframes are).
- **Cross-origin iframes** are skipped for evaluation.
- `contextFetch` uses a Node-side fetch **without the page's cookies** — it does not inherit the session.
- **Headless is not supported**; `session.create` rejects `headless: true` with `HEADED_REQUIRED`.
- The safety layer is **off by default** and non-blocking.

Known gaps and recommended follow-ups are tracked in the project issues; the
agent-facing consequences of each limitation are spelled out in
[`SKILL.md`](./SKILL.md).

---

## Security Notes

- Browser runs **headed by default** so you can see exactly what Kruz is doing.
- `file://` URLs are supported for local testing.
- No passwords or session tokens are exposed to the agent; the persistent profile keeps logins on disk under `browser-profile/`.
- Human takeover/wait handles login, CAPTCHA, and 2FA.
- The safety layer can classify destructive actions (delete/purchase) but is off by default.
- All diagnostics go to **stderr**; stdout is reserved for MCP.

---

## License

MIT