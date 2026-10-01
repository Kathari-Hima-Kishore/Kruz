# Kruz MCP — Model Instruction Manual

This guide is the deeper, project-local companion to [`SKILL.md`](./SKILL.md), which is
the global runtime contract served to agents over MCP. The skill carries the rules, the
closed loop and the tool list; this file carries worked examples, recovery recipes and
the ATS playbook. Read both.

---

## Quick Reference

| Goal | Tool | Example |
|---|---|---|
| Start browser | `session.create` | `{}` |
| Navigate | `page.open` | `{url: "https://example.com"}` |
| See page | `page.observe` | `{detail: "standard"}` |
| Click element | `page.click` | `{target: {ref: "e5"}}` |
| Click by role | `page.click` | `{target: {role: "button", name: "Submit"}}` |
| Fill form | `page.fill` | `{target: {ref: "e3"}, value: "text"}` |
| Press key | `page.press` | `{key: "Enter"}` |
| Select dropdown | `page.select` | `{target: {ref: "e7"}, label: "Option 1"}` |
| Check/uncheck | `page.check` / `page.uncheck` | `{target: {ref: "e9"}}` |
| Scroll | `page.scroll` | `{direction: "down", amount: 500}` |
| Wait | `page.wait` | `{condition: "content", predicate: "document.querySelector('.result')"}` |
| Run JS | `page.evaluate` | `{expression: "document.title"}` |
| Dismiss overlays | `page.handleOverlays` | `{close_cookie_banner: true}` |
| Handle dialog | `page.dialog` | `{action: "accept"}` |
| Pause for human | `session.pause` | `{message: "Please log in"}` |
| Resume | `session.resume` | `{}` |

---

## Targeting Elements

**Priority order:** `ref` → `role`+`name` → `label` → `placeholder` → `text` → `testid` → `nameAttr` → `id` → `css` → `xpath`

### Best Practice: Use refs

```json
// 1. Observe the page
{"target": {"ref": "e5"}}

// 2. Click by ref (most reliable)
{"target": {"ref": "e5"}}
```

Refs are stable handles that survive minor DOM changes. Always prefer refs over CSS selectors.

### Fallback: Role + Name

```json
{"target": {"role": "button", "name": "Submit"}}
```

Good for semantic elements. The `name` is the accessible name (aria-label, text content, etc.).

### Last resort: CSS

```json
{"target": {"css": "button.submit"}}
```

Avoid when possible — CSS selectors break on DOM changes.

### Text matching

```json
{"target": {"text": "Click here"}}
```

Matches elements containing the text. Use for links and buttons without accessible names.

### What the `name` field actually is

The observer and the action tools share **one** accessible-name implementation, so
a name you read in an observation is the name the resolver matches on. Order:

1. `aria-labelledby` (all ids joined — and it beats `aria-label`)
2. `aria-label`
3. associated `<label>`, with the control's own text stripped, so
   `<label>Location<select>…</select></label>` is named `Location` and never
   `LocationBangalore`
4. `title`
5. `placeholder` (inputs and textareas only)
6. own text, whitespace-collapsed, up to 200 chars

Worked consequences:

- `<label>Location<select><option>Bangalore</option></select></label>` is named
  `Location` — the option text is stripped, so `{"label": "Location"}` matches
- a theme `<select>` with Auto/Light/Dark options is named `Theme` (from its
  label), **never** `Auto Light Dark`; a `<select>` is not named from its options
- a page that ships both a desktop and a mobile copy of a control gives you two
  matches → `AMBIGUOUS_TARGET` with candidate refs. Act on one, or add a `scope`.

```json
{"target": {"role": "combobox", "name": "Theme"}}
{"target": {"label": "Location"}}
{"target": {"ref": "e7"}}
```

### Ref numbering and lifetime

- Ids restart in each new document: a busy page shows `e1…e400`, not `e8000`.
- A session keeps the 6000 most recent refs. Older ones are retired and then return
  `UNKNOWN_REFERENCE` — re-observe instead of reconstructing the id.

---

## Understanding Verification

Every click returns a verification status:

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

- **Visible** = Kruz is actively controlling the browser (a tool call is in flight)
- **Hidden** = The model is thinking/deciding; the page is yours
- **Cursor** = Shows where the next action will land
- **Input lock** = While the overlay is visible, page input is blocked (except Kruz's own actions)

The overlay is **realtime**: it turns off ~650ms after the last tool call ends.

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

### Check `r.ok` — expected refusals are values, not exceptions

`outcome` tells you which you are holding:

- **`"refusal"`** — Kruz did its job; the answer is "not safely". It guessed
  nothing and clicked nothing, and the payload carries what it found so you can
  decide. Delivered as a normal resolved value, so `if (!r.ok)` is sufficient.
  **Do not wrap tool calls in try/catch for these.**
- **`"failure"`** — the tool could not do its job (no session, crash, timeout,
  unhandled exception). Raised as an error.

### Retryable errors (the same call may succeed shortly)
`ELEMENT_NOT_VISIBLE`, `ELEMENT_OBSCURED`, `ELEMENT_DISABLED`, `STALE_ELEMENT`,
`NO_SESSION`, `BROWSER_CRASHED`, `ACTION_TIMEOUT`, `INTERNAL_ERROR`

### Non-retryable errors (replaying cannot work — reconsider)
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `STALE_REFERENCE`, `DOCUMENT_CHANGED`,
`CONDITION_NOT_MET`, `UNKNOWN_REFERENCE`, `INVALID_TARGET`, `INVALID_INPUT`,
`UNKNOWN_TOOL`, `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_EDITABLE`,
`OVERLAY_NO_DISMISS_INTENT`

`OVERLAY_NO_DISMISS_INTENT` means an overlay **was** detected but none of its
controls had a safe dismissal intent, so nothing was clicked. That is correct
behaviour, not a malfunction — do not retry. Use `result.region_candidates` to
see the controls that were present and click an explicit Close control by ref,
or pass `force:true`.

> `TARGET_NOT_FOUND` and `AMBIGUOUS_TARGET` used to be listed as retryable. They are not:
> replaying an identical target against a settled page cannot succeed, and marking them
> retryable invites a retry loop. `STALE_REFERENCE` and `DOCUMENT_CHANGED` are likewise
> non-retryable — the safe re-resolution ladder has already been exhausted internally.

### Common patterns

**Element not found?** (`TARGET_NOT_FOUND`, terminal, returns fast)
1. Call `page.probe` to see whether anything matches NOW
2. Call `page.observe` and use a `ref` from it
3. Do NOT retry the same selector

**Ambiguous target?** (the error carries `candidates`, each with a usable `ref`)
1. Act on the `ref` of the candidate you actually want
2. Or narrow with a `scope` / a more specific selector
3. Do NOT re-observe blindly — the candidates are already in the error

**Stale ref?** (`STALE_REFERENCE` / `DOCUMENT_CHANGED`)
1. Do NOT replay it — non-retryable by design
2. Re-observe to mint a fresh ref in the current document
3. On `DOCUMENT_CHANGED` the page navigated: base the next decision on the NEW page

**Element obscured?**
1. Call `page.handleOverlays` to dismiss overlays (also auto-attempted)
2. Scroll the element into view
3. Retry the click

---

## Efficient Patterns

### Pattern 1: Observe → Act

```json
// 1. Get the page state
{"detail": "standard"}

// 2. Find the element you want
// (look for ref, role, name in the observation)

// 3. Act on it
{"target": {"ref": "e5"}}
```

### Pattern 2: Wait for content

```json
{
  "condition": "content",
  "predicate": "document.querySelector('.results')",
  "timeout_ms": 10000
}
```

`page.open` decides readiness from **rendered content**, not from the lifecycle
event, and it no longer blocks on that event. So you do not need a lower
`wait_for` to get a faster return, and you should not read
`_timing.lifecycle_timed_out: true` as a broken navigation — it only says the
browser never resolved `load`/`domcontentloaded` (common with slow images,
long-polling connections and SPAs). If `_ready` is true and `_waited_ms` is
small, the page is ready regardless.

### Pattern 3: Handle overlays before clicking

```json
{"close_cookie_banner": true, "close_newsletter_popup": true}
```

If it answers `ok: false` with `OVERLAY_NO_DISMISS_INTENT`, that is **not** a
failure to clean up — it means an overlay IS present and Kruz refused to guess
which control closes it. Do not retry, and do not read it as "the page is clear".
Read `result.region_candidates` and click an explicit Close control by ref, or
pass `force:true` to the click.

`detected_overlay: false` is the only "nothing in the way" answer, and it is now
trustworthy for a control-less modal too — a full-screen `role=dialog` is detected
whether or not it happens to have a Close button.

### Pattern 4: Form filling

```json
// Fill multiple fields
{"target": {"ref": "e3"}, "value": "John"}
{"target": {"ref": "e4"}, "value": "Doe"}
{"target": {"ref": "e5"}, "value": "john@example.com"}
// Submit
{"target": {"ref": "e6"}}
```

---

## Tool Categories

### Navigation
`page.open`, `page.newTab`, `page.switchTab`, `page.listTabs`, `page.closeTab`

### Observation
`page.observe`, `page.computerUseList`, `page.computerUseSnapshot`

### Interaction
`page.click`, `page.clickAt`, `page.fill`, `page.press`, `page.select`, `page.check`, `page.uncheck`, `page.scroll`, `page.paginate`

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

### Session
`session.create`, `session.status`, `session.close`, `session.pause`, `session.resume`, `human.takeover`

---

## Best Practices

1. **Always observe first** — Know what's on the page before acting
2. **Use refs** — They're more stable than CSS selectors
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

Environment variables (full table in [`SKILL.md`](./SKILL.md); source of truth is `src/config.ts`):

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

### Workflow 1: Login and navigate

```json
// 1. Create session
{}

// 2. Navigate to login page
{"url": "https://example.com/login"}

// 3. Observe to find form elements
{"detail": "standard"}

// 4. Fill credentials
{"target": {"ref": "e3"}, "value": "username"}
{"target": {"ref": "e4"}, "value": "password"}

// 5. Submit
{"target": {"ref": "e5"}}

// 6. Wait for navigation
{"condition": "content", "predicate": "location.pathname !== '/login'"}
```

### Workflow 2: Job search on ATS

```json
// 1. Navigate to job board
{"url": "https://boards.greenhouse.io/company"}

// 2. Observe to find search elements
{"detail": "standard"}

// 3. Fill search
{"target": {"ref": "e5"}, "value": "software engineer"}

// 4. Submit search
{"target": {"ref": "e6"}}

// 5. Wait for results
{"condition": "content", "predicate": "document.querySelectorAll('.job').length > 0"}

// 6. Click first result
{"target": {"ref": "e10"}}
```

### Workflow 3: Handle cookie banner

```json
// 1. Navigate to page
{"url": "https://example.com"}

// 2. Dismiss cookie banner
{"close_cookie_banner": true}

// 3. Now interact with the page
{"target": {"ref": "e5"}}
```

---

## Notes

- The browser is **headed** (visible) by default — you can see what Kruz is doing
- The **blue overlay** indicates active control
- The **cursor** shows where actions will land
- **Input is locked** while the overlay is visible
- Use `session.pause` for manual intervention (login, CAPTCHA, 2FA)
- All diagnostics go to **stderr**; stdout is reserved for MCP protocol
