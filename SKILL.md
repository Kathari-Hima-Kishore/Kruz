---
name: Kruz MCP
description: Kruz browser automation MCP server — 49 tools for driving a headed Chrome browser. Use when the user asks to browse, click, fill forms, scrape, navigate, take screenshots, handle cookie banners, interact with JS-heavy sites, or automate web workflows via Kruz/MCP. Triggers include "use Kruz", "browser MCP", "drive the browser", "open the site with Kruz", ATS job harvesting, or when an MCP session with server.info/session.create/page.* tools is available.
---

# Kruz MCP Skill

## Read the Model Guide before you drive the browser

This skill is the **global** runtime contract, and it is the shorter of the two
documents by design. The project-local manual is
[`MODEL_GUIDE.md`](./MODEL_GUIDE.md) in the Kruz repository
(`D:/project prototypes/Kruz/MODEL_GUIDE.md`).

**Do this at the start of a Kruz task, not "if something goes wrong":** open and
read `MODEL_GUIDE.md` before your first `page.open`. It carries what this file
deliberately omits — worked examples per tool, recovery recipes for stubborn
overlays, the ATS/job-hunting playbook, and the full error taxonomy. Reading it
up front is cheaper than rediscovering a recipe mid-task.

| Want | Read |
|---|---|
| The rules, the closed loop, the tool list, error codes | **this file** |
| Worked examples, deep recipes, naming edge cases, ATS playbook | **`MODEL_GUIDE.md`** |

**This skill is global; the model guide is local.** That is why the guide is
referenced by path here rather than embedded: on another machine the skill still
applies, and the guide is read when it is present. If the guide is missing, carry
on with this file alone — it is sufficient to drive the browser correctly.

Concretely, consult the guide when you are about to: pick a targeting strategy
other than a ref, handle a cookie/consent overlay, drive a `<select>`, or run an
ATS harvest.

## Browser interaction rules (READ FIRST)

Kruz is a **closed-loop** browser: every action returns the evidence you need to choose
the next one. Follow these rules or you will reintroduce the guess→stall→guess failure mode.

1. **Never invent a deep URL.** A navigation target must come from the user, an observed
   `href`, a returned navigation state, or a discovery tool — not from a plausible-looking
   guess like `/company/careers/jobs`. Open the root/observed page, then follow links.
2. **Act → verify → decide.** After any action that can change the page (open, click,
   press, select), use the returned `state`/verification BEFORE choosing the next
   dependent action. Do not chain assumptions about screens you have not observed.
3. **Targets come from the page, not from memory.** Prefer a `ref` from `page.observe`
   over a guessed CSS selector or a remembered button label.
4. **A ref is a promise: any ref Kruz hands you is actionable.** `page.observe`,
   `page.probe`, and `AMBIGUOUS_TARGET` candidates all mint refs into ONE per-session
   `RefRegistry`, and every action tool (`page.click`, `page.fill`, `page.select`,
   `page.check`, `page.uncheck`, `page.scroll(target)`) resolves from that same registry.
   So a ref you were just given can be acted on directly. If it cannot, you get a precise
   structured reason (`STALE_REFERENCE`, `DOCUMENT_CHANGED`, `ELEMENT_NOT_VISIBLE`,
   `ELEMENT_DISABLED`, `ELEMENT_OBSCURED`) — never a silent click on something else.
5. **Zero candidates or many candidates means "reconsider", not "retry exactly the same
   thing".** `AMBIGUOUS_TARGET` returns a bounded `candidates` list where every entry
   carries a usable `ref` — act on the one you want. `TARGET_NOT_FOUND` is terminal and
   returns fast; re-declare the target or re-observe rather than retrying it.
6. **`page.wait` is settled-aware.** If the predicate stays false while the page stops
   changing, it fails early with `CONDITION_NOT_MET` (not a 20s burn). When you see that,
   observe/probe what IS on the page — do NOT wait on the same predicate again.
7. **`page.evaluate` is for reading, not for workflows.** Never encode a multi-step
   state-dependent sequence (click → assume new screen → click → submit) in one
   expression; those steps run with no intermediate observation. Use the atomic tools.
8. **`page.probe` is for uncertainty, not ceremony.** Actions already resolve targets
   locally and return candidates; use `page.probe` when planning or testing a hypothesis.

### Two refusals you will meet, and what they actually mean

Both are **correct** behaviour, not bugs. Do not try to route around them.

- **`STALE_REFERENCE`** — the ref was minted in a document that has since been replaced,
  or the element it named is genuinely gone and nothing provably identical replaced it.
  The ref is not broken; the page moved on. Re-observe to mint a fresh ref.
- **`DOCUMENT_CHANGED`** — the ref belongs to a *different document* than the one now
  open (a navigation happened). A same-named element on the new page is a **decoy** and
  will never be acted on for you. Re-observe.

Kruz will refuse rather than guess, because clicking a stranger's "Apply" button is worse
than returning an error. Treat a refusal as evidence about the current page, not as a bug.

---

## What is Kruz?

Kruz is a **local, stdio-based MCP server** that gives an AI agent a **headed (visible) Chrome browser** to drive real websites. It exposes **50 semantic tools** for navigation, observation, clicking, form interaction, JavaScript evaluation, network capture, and ATS job harvesting.

**Key properties:**
- **Verification-first**: Every click is verified against a postcondition before reporting success
- **Realtime overlay**: A blue overlay + visible cursor shows when the model is actively controlling the browser
- **Human-in-the-loop**: Headed browser, explicit pause/resume for login/CAPTCHA/2FA
- **Persistent profile**: Chrome profile survives between sessions (cookies, logins)
- **Bot-evasion**: Injected stealth script masks automation tells

---

## Architecture

```
MCP Client (LLM agent)
    │  JSON-RPC over stdio
    ▼
src/index.ts → createServer()
    ├─ McpServer (49 tools + 4 resources)
    ├─ ToolRouter (dispatch, retries, overlay heartbeat)
    │   └─ SessionManager
    └─ BrowserController
        ├─ PuppeteerEngine (CDP mechanics, probes, input)
        ├─ Observer (page observation + refs)
        ├─ click-completion.ts (postcondition verification)
        ├─ visual-cursor.ts (overlay + cursor)
        └─ stealth.ts (bot-evasion)
    │
    ▼
Headed Chrome (persistent profile)
```

**Layering rule:** Router owns policy (retries, timeouts, verification). Controller owns semantics (targets, strictness, refs). Engine owns mechanics (CDP, input synthesis). Observer owns perception.

---

## Tool Catalog (49 tools)

### Server & Session
| Tool | Purpose |
|---|---|
| `server.info` | Diagnostics. Returns `docs` pointer to `kruz://skill` |
| `session.create` | Create/reuse headed Chrome session |
| `session.status` | Session state, tabs, navigation trace |
| `session.close` | Close browser |
| `session.pause` | Release lock for manual work |
| `session.resume` | Hand control back to model |

### Navigation
`page.open`, `page.newTab`, `page.switchTab`, `page.listTabs`, `page.closeTab`

### Observation
`page.observe` (detail: `minimal`/`standard`/`full`), `page.probe` (instant existence check), `page.computerUseList`, `page.computerUseSnapshot`

### Interaction
`page.click`, `page.clickAt`, `page.fill`, `page.press`, `page.select`, `page.check`, `page.uncheck`, `page.scroll`, `page.paginate`

**These actions return a compact post-action `state`** (`url`, `title`, `dom_changed`, `focus`, and for press/select `interactive_added`/`appeared_text`). Use it to decide the next step without a separate `page.observe`.

### Overlays & Dialogs
`page.handleOverlays`, `page.dialog`

### JavaScript
`page.evaluate`, `page.frameEvaluate`, `page.frameObserve`

### Extraction
`extract.text`, `page.extractExperience`, `page.detectATS`

### Network
`network.capture`, `network.body`

### ATS (Job Sites)
`ats.enumerate`, `ats.verifyPosting`, `ats.summarize`, `ats.paginate`, `ats.greenhouseHarvest`, `ats.leverHarvest`, `ats.ashbyHarvest`, `ats.smartRecruitersHarvest`, `ats.workdayHarvest`, `ats.bulkHarvest`, `ats.discoverHandle`

### Safety
`human.takeover`

---

## Targeting Elements

**Priority:** `ref` → `role`+`name` → `label` → `placeholder` → `text` → `testid` → `nameAttr` → `id` → `css` → `xpath`

### Best Practice: Use refs

```json
// 1. Observe the page
{"detail": "standard"}

// 2. Click by ref (most reliable)
{"target": {"ref": "e5"}}
```

Refs are stable handles that survive minor DOM changes. Always prefer refs over CSS selectors.

### Fallback: Role + Name

```json
{"target": {"role": "button", "name": "Submit"}}
```

### Last resort: CSS

```json
{"target": {"css": "button.submit"}}
```

### Text matching

```json
{"target": {"text": "Click here"}}
```

### Accessible names — what the `name` field actually means

`page.observe` and the action tools compute accessible name with **one shared
implementation**, so a name you read in an observation is the same name the
resolver matches on. The order is:

1. `aria-labelledby` — **all** referenced ids joined, and it wins over `aria-label`
2. `aria-label`
3. associated `<label>` — for a wrapping label the control's own text is stripped,
   so `<label>Location<select>…</select></label>` is named `Location`, never
   `LocationBangalore`
4. `title`
5. `placeholder` — inputs and textareas only
6. own text content, collapsed to single spaces, up to 200 chars

**A `<select>` is never named from its own options.** Its options are the control's
*value*, not its label, so a theme picker offering Auto/Light/Dark is named `Theme`
(from its label) and not `Auto Light Dark`. Target it by its label or by the ref:

```json
{"target": {"role": "combobox", "name": "Theme"}}
{"target": {"label": "Location"}}
```

Pages often render a control more than once (a visible desktop copy and a hidden
mobile copy), so a genuinely duplicated name returns `AMBIGUOUS_TARGET` with
candidate refs. That is the answer to act on, not a fault.

### Ref numbers are small, and that is expected

Ref ids restart in each new document, so a busy page numbers `e1…e400` rather than
`e8000`. A session keeps the **6000 most recent** refs; older ones are retired and
then return `UNKNOWN_REFERENCE`. If a ref stops resolving, re-observe — do not try
to reconstruct it or hunt for a typo.

---

## Verification Semantics

Every click returns:

| Field | Meaning |
|---|---|
| `clicked: true` | Input was dispatched |
| `verified: true` | Postcondition was observed |
| `verification: "rendered_destination"` | Navigation completed and page rendered |
| `verification: "in_place_change"` | Page changed without navigation |
| `verification: "predicate"` | Custom wait condition was met |
| `verified: false` | Click happened but outcome unconfirmed |

**Rule:** `clicked: true` alone does NOT mean success. Check `verified: true` before proceeding.

---

## The Blue Overlay

- **Visible** = Kruz is actively controlling the browser (tool call in flight)
- **Hidden** = Model is thinking/deciding; page is yours
- **Cursor** = Shows where the next action will land
- **Input lock** = While overlay is visible, page input is blocked (except Kruz's own actions)

The overlay is **realtime**: turns off ~650ms after the last tool call ends, even if the server process dies.

---

## Error Handling

Errors return a typed envelope:

```json
{
  "code": "TARGET_NOT_FOUND",
  "message": "Element not found (css=#nope)",
  "retryable": false,
  "outcome": "refusal",
  "subsystem": "engine",
  "help": "Call page.observe to see what is actually on the page"
}
```

### `outcome`: refusal vs failure — always inspect `r.ok`

A tool that cannot do what you asked returns a **value**, not a thrown exception.
So `const r = await page_click(...); if (!r.ok)` is the correct and sufficient
pattern — **do not wrap tool calls in try/catch for expected refusals.**

- **`outcome: "refusal"`** — Kruz did its job and the answer is "not safely".
  It guessed nothing and clicked nothing; the payload holds what it found
  (`candidates` on `AMBIGUOUS_TARGET`, `region_candidates` on
  `OVERLAY_NO_DISMISS_INTENT`). Re-plan deliberately rather than retrying.
- **`outcome: "failure"`** — the tool could not do its job: no session, crashed
  browser, timeout, unhandled exception. These *are* raised as errors.

### Retryable (safe to retry)
`ELEMENT_NOT_VISIBLE`, `ELEMENT_OBSCURED`, `STALE_ELEMENT`, `ELEMENT_DISABLED`, `NO_SESSION`, `BROWSER_CRASHED`, `ACTION_TIMEOUT`, `INTERNAL_ERROR`

### Non-retryable (fix the input — do NOT replay the same call)
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `STALE_REFERENCE`, `DOCUMENT_CHANGED`,
`CONDITION_NOT_MET`, `INVALID_TARGET`, `INVALID_INPUT`, `UNKNOWN_TOOL`,
`UNKNOWN_REFERENCE`, `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_EDITABLE`,
`OVERLAY_NO_DISMISS_INTENT`

`OVERLAY_NO_DISMISS_INTENT` is the one to read carefully: an overlay **was**
found, but none of its controls carried a safe dismissal intent, so nothing was
clicked. That is the correct outcome — do not retry it, and do not read it as
"the page is clear". Read `result.region_candidates` for the controls that were
there and click an explicit Close control by ref, or pass `force:true` to click
through. `detected_overlay: false` is the only "nothing in the way" answer, and
it holds even for a full-screen modal that has no Close button.

> **Try again automatically** vs **reconsider the plan**: retryable = the same call may
> work shortly (a transient overlay/re-render). Non-retryable = the current plan is
> wrong for the current page; observe, probe, or re-declare the target first.
>
> `STALE_REFERENCE` and `DOCUMENT_CHANGED` are **non-retryable by design**: the safe
> re-resolution ladder has already been exhausted internally, so replaying the identical
> ref cannot succeed. Mint a fresh ref instead.

### Common patterns

**Element not found?** (`TARGET_NOT_FOUND`, terminal, returns fast)
1. Call `page.probe` to see whether anything matches NOW
2. Call `page.observe` for the full picture and use a `ref`
3. Do NOT retry the same selector

**Ambiguous target?** (error carries `candidates`, each with a usable `ref`)
1. Read `result.candidates` (ref/role/name/href/actionable)
2. Act on the `ref` of the candidate you actually want — no re-declaration needed
3. Or narrow with a `scope` / more specific selector
4. Do NOT re-observe blindly — the candidates are already in the error

**Stale ref?** (`STALE_REFERENCE` / `DOCUMENT_CHANGED`)
1. Do NOT replay it — it is non-retryable by design
2. Re-observe to mint a fresh ref in the current document
3. If it was `DOCUMENT_CHANGED`, note that the page navigated: your next decision must
   be based on the NEW page, not the one the ref came from

**Wait failed with `CONDITION_NOT_MET`?**
1. The page stopped changing and the predicate never became true
2. `page.probe` / `page.observe` to see what IS present
3. Do NOT wait on the same predicate again

**Element obscured?**
1. `page.handleOverlays` to dismiss overlays (also auto-attempted)
2. Scroll the element into view
3. Retry the click

---

## Efficient Patterns

### Pattern 1: Observe → Act
```json
{"detail": "standard"}
// Find ref, role, name in observation
{"target": {"ref": "e5"}}
```

### Pattern 2: Wait for content
```json
{"condition": "content", "predicate": "document.querySelector('.results')", "timeout_ms": 10000}
```

### Pattern 3: Handle overlays first
```json
{"close_cookie_banner": true, "close_newsletter_popup": true}
```

### Pattern 4: Form filling
```json
{"target": {"ref": "e3"}, "value": "John"}
{"target": {"ref": "e4"}, "value": "Doe"}
{"target": {"ref": "e5"}, "value": "john@example.com"}
{"target": {"ref": "e6"}}
```

---

## Best Practices

1. **Always observe first** — Know what's on the page before acting
2. **Use refs** — More stable than CSS selectors
3. **Check verification** — Don't assume success from `clicked: true`
4. **Handle overlays early** — Dismiss cookie banners before clicking
5. **Use scopes** — Narrow searches to avoid ambiguity
6. **Wait for content** — Use `page.wait` instead of fixed delays
7. **Batch independent calls** — Multiple `page.fill` calls can run in parallel
8. **Use `page.evaluate` sparingly** — Prefer semantic tools when possible

---

## Common Pitfalls

| Pitfall | Solution |
|---|---|
| Clicking without observing | Always `page.observe` first |
| Using CSS when ref is available | Use `ref` from observation |
| Ignoring `verified: false` | Check verification before proceeding |
| Not handling overlays | Call `page.handleOverlays` first |
| Ambiguous selectors | Add `scope` or use `ref` |
| Fixed delays | Use `page.wait` with predicates |
| Not checking errors | Read `code` and `help` in error responses |

---

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_PATH` | Auto-detect | Chrome executable |
| `BROWSER_HEADLESS` | `false` | Run headless (not supported) |
| `BROWSER_PROFILE_DIR` | `./browser-profile` | Persistent profile |
| `BROWSER_VIEWPORT_WIDTH` | `1280` | Viewport width |
| `BROWSER_VIEWPORT_HEIGHT` | `720` | Viewport height |
| `BROWSER_TIMEOUT_MS` | `30000` | Default timeout |
| `LOG_LEVEL` | `info` | Logging level |
| `SAFETY_POLICY` | `off` | Safety policy |

---

## Example Workflows

### Login and navigate
```json
{}
{"url": "https://example.com/login"}
{"detail": "standard"}
{"target": {"ref": "e3"}, "value": "username"}
{"target": {"ref": "e4"}, "value": "password"}
{"target": {"ref": "e5"}}
{"condition": "content", "predicate": "location.pathname !== '/login'"}
```

### Job search on ATS
```json
{"url": "https://boards.greenhouse.io/company"}
{"detail": "standard"}
{"target": {"ref": "e5"}, "value": "software engineer"}
{"target": {"ref": "e6"}}
{"condition": "content", "predicate": "document.querySelectorAll('.job').length > 0"}
{"target": {"ref": "e10"}}
```

### Handle cookie banner
```json
{"url": "https://example.com"}
{"close_cookie_banner": true}
{"target": {"ref": "e5"}}
```

---

## Timing

Actions report their own internal timing — use these fields to spot a stall instead of
guessing (and never wrap a call in a shell timestamp).

| Tool | Fields |
|---|---|
| `page.probe` | `probe_ms` |
| `page.open` | `_timing.total_ms` (+ `lifecycle_ms`, `lifecycle_timed_out`, `navigate_ms`, `poll_ms`) |
| `page.click` | `timing.total_ms`, `resolve_ms`, `action_ms`, `verify_ms` |
| `page.fill` | `timing.total_ms`, `resolve_ms`, `action_ms` |
| `page.scroll` | `timing.total_ms`, `action_ms` |
| `page.observe` | `timing.total_ms`, `generate_ms` |
| `page.handleOverlays` | `timing.total_ms`, `discovery_ms`, `dismissal_ms` |

`page.open` reports `_timing.lifecycle_ms` and `lifecycle_timed_out`. It decides
readiness from rendered content and no longer blocks on the lifecycle event, so
`lifecycle_timed_out: true` with `_ready: true` is a healthy page whose `load`
event never fired — not a broken navigation, and not a reason to re-navigate.

A high `resolve_ms` means target resolution was hard (often genuine ambiguity); a high
`action_ms` means the browser was slow. Both are measured server-side.

---

## Notes

- Browser is **headed** (visible) by default — `session.create` rejects `headless: true`
- **Blue overlay** indicates active control; the cursor shows where actions land
- **Input is locked** while the overlay is visible
- Use `session.pause` / `human.takeover` for manual intervention (login, CAPTCHA, 2FA),
  then `session.resume`
- All diagnostics go to **stderr**; stdout is reserved for MCP protocol
- For worked examples, deep recovery recipes and the ATS playbook, read
  [`MODEL_GUIDE.md`](./MODEL_GUIDE.md)
