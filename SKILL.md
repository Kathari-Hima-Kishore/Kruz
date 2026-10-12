---
name: Kruz MCP
description: Kruz browser automation MCP server - 53 tools for driving a headed Chrome browser. Use when the user asks to browse, click, fill forms, scrape, navigate, take screenshots, analyse what a page looks like, handle cookie banners, interact with JS-heavy sites, or automate web workflows via Kruz/MCP. Triggers include "use Kruz", "browser MCP", "drive the browser", "open the site with Kruz", "what does this page look like", ATS job harvesting, or when an MCP session with server.info/session.create/page.* tools is available.
---

# Kruz MCP Skill

## Read the Model Guide before you drive the browser

This skill is the **global** runtime contract, and it is the shorter of the two
documents by design. The project-local manual is
[`MODEL_GUIDE.md`](./MODEL_GUIDE.md), which sits next to this file in the Kruz
install directory.

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
   thing".** `AMBIGUOUS_TARGET` returns a bounded candidate list under
   **`result.candidates`** — every entry carries a usable `ref`, `name`, `actionable`
   and `blocked_reason`. Pick the entry whose `name` matches what you observed and
   whose `actionable` is `true`, and act on that ref; re-observing and re-clicking the
   *original* ref will reproduce the identical refusal. `TARGET_NOT_FOUND` is terminal
   and returns fast; re-declare the target or re-observe rather than retrying it.
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
- **Realtime status banner**: A top-left banner always shows the current state — blue
  `Controlled by Kruz` while acting, amber `Model is thinking` between actions, clear
  `Input needed on Browser/TUI` when a human is expected
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
    ├─ McpServer (53 tools + 4 resources)
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

## Tool Catalog (53 tools)

### Server & Session
| Tool | Purpose |
|---|---|
| `server.info` | Diagnostics. Returns `docs` pointer to `kruz://skill` |
| `session.create` | Create/reuse headed Chrome session. `browser.viewport` is the **measured** viewport; `browser.viewport_requested` is what was asked for. The CSS viewport is **pinned** at the measured size, so it cannot drift when the window is resized. Pass `cdp_url` to attach to an already-running Chrome instead of launching one |
| `session.status` | Session state, tabs, navigation trace, **live** `browser_viewport` + `viewport_drifted` |
| `session.close` | Close browser |
| `session.pause` | Release lock for manual work |
| `session.resume` | Hand control back to model |

### Navigation
`page.open`, `page.newTab`, `page.switchTab`, `page.listTabs`, `page.closeTab`

### Observation
`page.observe` (detail: `minimal`/`standard`/`full`), `page.probe` (instant existence check), `page.computerUseList`, `page.computerUseSnapshot`

### Vision
`page.screenshot`

### Interaction
`page.click`, `page.clickAt`, **`page.drag`**, `page.fill`, `page.press`, `page.select`, `page.check`, `page.uncheck`, `page.scroll`, `page.paginate`, **`page.setViewport`**, **`page.uploadFile`**

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

## Inputs that click and press cannot express

### `page.drag` — press, move, release

Palette-to-canvas placement (Tinkercad, Canva, block builders), slider handles,
reorderable lists. Each endpoint is `{x,y}` in CSS pixels **or** any target
`page.click` accepts, which is scrolled into view and grabbed at its centre.

```json
{ "from": { "css": "#sidebar-item-box" }, "to": { "css": "#workplane" } }
```

- Dispatched as **trusted** input with **real per-step timing**. This matters: a
  custom drag engine ignores a press/move/release that arrives in one task, so a
  synthetic drag looks healthy and does nothing.
- `speed: "slow"` and a higher `steps` are the levers when a first drag is ignored.
- `mode: "html5"` dispatches `dragstart/dragenter/dragover/drop/dragend` with a
  DataTransfer for sites built on the HTML5 drag API. It needs two **targets**.
  **Seed `data` yourself** (`{"text/plain":"..."}`) — Chrome discards `setData`
  calls made by the page's own `dragstart` handler on a synthetic DataTransfer, so
  without `data` the drop handler reads an empty value.
- `modifiers` (e.g. `["Shift"]`) is held for the whole gesture.

**Read the result.** `verification` is `navigation` | `dom_change` | `no_change`, and
a drop that changed nothing returns `verified:false` with `unverified_reason` and a
`hint` — it never claims success. A canvas/WebGL editor draws without changing the
DOM, so confirm those with `page.screenshot`, not by re-reading `dom_changed`.

### `modifiers` on `page.click` — shift-click / ctrl-click

Keys held across the whole click, then released. This is how multi-select and
additive range selection are expressed; a key **combo** (`page.press "Control+g"`)
cannot be, because a combo is atomic while multi-select needs the modifier held
across the click. Always released, so a plain click afterwards is never
accidentally still shift-modified.

### `page.setViewport` — pin the layout

Sites flip between mobile and desktop variants at a media-query breakpoint. Below
the breakpoint the desktop control **is not in the DOM at all**, so observing and
clicking it is impossible rather than merely awkward. `session.create` pins the
viewport for you; use this to re-pin mid-session:

```json
{ "width": 1440, "height": 900 }
```

- Applies CDP device metrics — the **OS window is not resized**.
- **Device scale factor is preserved**, so element screenshots stay in device pixels
  (`css × dpr`); `result.image_space` restates this.
- `session.status` reports the **live** viewport and `viewport_drifted`, so "the
  control vanished" can be read as "the layout moved".

### `page.uploadFile` — the only real upload route

`DOM.setFileInputFiles` plus the change event. An in-page `DataTransfer` cannot
populate a real file input, so there is no `page.evaluate` recipe for this. The
input does not need to be visible — file inputs are normally `display:none` behind
a styled button.

```json
{ "target": { "css": "input[type=\"file\"]" }, "paths": ["C:/models/part.stl"] }
```

Paths resolve on the machine running Kruz; a missing path is rejected up front.

---

## Known unsupported flow: Google-account sign-in

**Do not attempt Google credentials through Kruz.** Google classifies a
Puppeteer-*launched* Chrome as automation and rejects sign-in with *"This browser or
app may not be secure"*, **even when a human types the credentials by hand** during
`session.pause`. The rejection is transport/protocol-level (the CDP attach itself,
and profile-freshness signals), not page-visible: `navigator.webdriver` is masked,
`window.chrome.runtime` is present, and plugin counts look normal — and it still
rejects.

What to do instead, in order of preference:

1. **`session.create` with `cdp_url`** — attach to the user's own daily-driver Chrome
   (started with `--remote-debugging-port=9222`). That browser carries real profile
   reputation, so sign-in works. `session.close` then **disconnects** and leaves
   their browser running.
2. **Point `profile_dir` at a copy of a real Chrome `User Data` folder** that already
   carries the Google session — sidesteps sign-in entirely. Copy it; do not hand
   Kruz the live profile.
3. Any non-Google SSO or a site that does not fingerprint the client is unaffected —
   `session.pause` remains the right tool for CAPTCHA, 2FA and ordinary logins.

---

## Vision — `page.screenshot`

Returns the **actual pixels** as an MCP image content block, so you can analyse the
page rather than only read its markup. This is image *analysis*, not OCR: you receive
the image and interpret it.

```json
{"full_page": false, "type": "jpeg", "quality": 70}          // viewport
{"target": {"ref": "e81"}}                                    // one element
{"target": {"css": ".nav-bar__link"}}                         // by any target
```

The metadata block reports `mime_type`, `width`, `height`, `bytes`, `mode`
(`viewport`/`full_page`/`element`), and — for a `ref` crop — the `ref` it used, so a
visual finding can be clicked directly with no second resolve.

**Reach for it when the DOM cannot answer the question:**

- an icon or control with no accessible name, no alt text, no class
- canvas / WebGL / image-based UI
- "is this actually visible, obscured, or overlapping?"
- layout or rendering checks, and screenshot-to-screenshot comparison
- a user describes something **by appearance** — *"the card with the aeroplane on it"*

**Two traps, both measured:**

- **Captures are in DEVICE pixels; `page.clickAt` takes CSS pixels.** Every capture now
  declares this for you — `scale` (the device pixel ratio), `viewport_css`,
  `image_space: "device_px"`, `target_space: "css_px"`. Convert with
  `css = image / scale`. Do **not** read coordinates off an image and pass them to
  `clickAt` unchanged; that lands on a different element entirely.
- **Use `type: "jpeg"` for `full_page`.** A long storefront capture runs megabytes as PNG.

Vision is the *perception* channel; refs are the *action* channel. Use vision to decide,
then act through `page.click` on a ref. Do not try to click by eyeballing coordinates.

### The look → act loop

This is the normal way to hit a target you can only identify by appearance:

```json
{"detail": "standard"}                          // 1. observe; note the element's name
{"target": {"ref": "e81"}, "type": "png"}       // 2. crop that ref — you SEE it now
{"target": {"ref": "e81"}}                      // 3. click the same ref
```

Measured end-to-end on `makerbazar.in` (a page with four same-href anchors):

| Step | Result |
|---|---|
| crop by ref `e81` | `298x313` device px = `238x250` CSS × `dpr 1.25` — the observed node, not a twin |
| capture echoes | `ref: "e81"` — the same ref, no second resolve |
| click that ref | `verified: true`, `resolution_tier: 1` |
| landed on | `/collections/rc-planes-and-drones` |

`resolution_tier: 1` is the point: the ref resolved to the **exact node** you looked
at, not to something reconstructed from a matching name. Step 3 needs no `text` or
`css` fallback — a text target reports `resolution_tier: 0`, which bypasses identity
resolution entirely and is a weaker guarantee.

### When a ref is genuinely ambiguous — the recovery

Ambiguity is the **exception**, not the routine: it means the recorded path missed and
identity had to be rebuilt from semantics. Same-href twins (nav link + card + footer
link on one URL) are the usual cause.

1. `page.click` the observed ref → `AMBIGUOUS_TARGET`.
2. **Read `result.candidates`**, not just the message. Each entry carries `ref`, `role`,
   `name`, `href`, `actionable`, and `blocked_reason`.
3. Act on the candidate whose **`name` matches what you observed** and whose
   `actionable` is `true`; skip any entry with a `blocked_reason` (e.g. *"not rendered
   (display:none…)"*).
4. Do **not** re-click the original ref — it reproduces the identical refusal. And do
   not pick by position.

If you are landing here routinely on one page, that is a path-resolution problem worth
reporting, not something to work around indefinitely.

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

### Resolution tier — read it

A successful action reports `resolution_tier`:

| Tier | Meaning |
|---|---|
| `1` | Resolved to the **exact node** you observed, by its recorded path |
| `2` | Recovered by exact semantic identity (role + name) |
| `3` | Recovered by bounded re-resolution inside the original match set |

Tier 1 is the strongest guarantee Kruz offers and is the normal case. If a routine
action is landing at tier 2 or 3, say so — it means the original node was not found by
path and identity was reconstructed, which is weaker than it looks.

### Fill success is trustworthy — read `recovered_by`

`page.fill` has a recovery ladder: if the first resolution misses (SPA churn, a shifted
DOM), it re-observes, re-resolves and writes. When that path is taken, a success
response carries:

```json
{"ok": true, "recovered_by": "re-observe-and-fill", "result": {"value_written": true}}
```

**`ok: true` means the value is in the field.** It did not used to: the ladder's action
re-threw unconditionally, so Kruz reported a *failure* for a fill its own escalation had
already performed — which invites a retry that writes the field twice. If you see
`recovered_by`, the write happened; move on.

Two app-side caveats that are not Kruz bugs:

- Some apps commit on blur, not on input. `fill` returns `ok:true` and the value
  reverts a moment later. Follow the fill with `page.press({key:"Tab"})` or `Enter`.
- Controlled/reactive inputs can drop consecutive fills. Fill one field at a time.
path and identity was reconstructed, which is weaker than it looks.

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

## The Control Banner (three states)

The banner is **always visible, top-left** (`10px, 10px`), and always says which of
three states the browser is in. Only the glow changes between states; the banner
never disappears.

| State | Glow | Banner text | Input locked? | Meaning |
|---|---|---|---|---|
| `controlling` | **blue**, pulsing | `Controlled by Kruz` | **yes** | a tool call is in flight |
| `thinking` | **amber**, no pulse | `Model is thinking` | no | model is engaged but nothing is running |
| `awaiting` | **none** (no colour) | `Input needed on Browser/TUI` | no | a human is expected |

- **Cursor** = Shows where the next action will land (only while `controlling`).
- **Input lock** = only while `controlling`. In `thinking` and `awaiting` the page is
  fully interactive.

### How the states are driven

Two clocks, because they answer two different questions:

- `lastPing` — *is a call in flight right now?* → `controlling` (within ~650ms of the
  last heartbeat).
- `lastEngaged` — *did the model do anything recently?* → `thinking` (within 20s of the
  last activity), otherwise `awaiting`.

The banner is driven by a single page-side watchdog ticking every 50ms, so all three
transitions happen in-page without another round trip.

Measured on a live session (`dump/overlay-states-verify.mjs`, 600 samples at 50ms):

```
    54–  699ms  controlling   action in flight
   753– 2505ms  thinking      heartbeat lapsed
  2551– 5004ms  awaiting      session.pause
  5052–25014ms  thinking      session.resume
 25062–30013ms  awaiting      auto-promoted, NO call made
```

Three things that fall out of that trace:

- The lapse to `thinking` lands within **650ms** of the last ping.
- `session.pause` and `human.takeover` jump straight to `awaiting`; their responses
  report it as `overlay: {mode: "awaiting", banner: "Input needed on Browser/TUI"}`.
- **`awaiting` also happens on its own.** When the model's turn ends and nothing calls
  `session.pause` — the normal opencode-TUI case — the banner promotes itself after 20s
  of quiet. `session.resume` answers with `overlay: {mode: "thinking", ...}`.

### The banner being amber is not a fault

Amber means the model is between actions: it is generating or deciding, and may act
again. The input lock is lifted in both amber and clear states, so the page is yours to
touch at any point in them. Do not read amber as Kruz having stalled, and do not wait
for blue before acting.

State has exactly **one** mechanism: a heartbeat (`ping`) that the page's own watchdog
expires. There is no paired on/off call, so a slow renderer, a hung call, or a crashed
server cannot strand it on — and nothing can switch it off in the middle of a call.
A ping also clears any explicit `awaiting` claim, so a page can never get stuck
claiming it needs input while the model is actively working.

Two consequences worth knowing:

- **A new document starts at `thinking`.** After a navigation the layer is reinstalled
  fresh with no heartbeat yet; the first ping promotes it to `controlling`.
- Some tools are lifecycle tools (`session.*`, `server.info`, `human.takeover`) and
  deliberately never raise the blue state — they drive the banner explicitly instead
  (`session.pause` → `awaiting`, `session.resume` → `thinking`).

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

- **`outcome: "refusal"`** - Kruz did its job and the answer is "not safely".
  It guessed nothing and clicked nothing; the payload holds what it found
  (`candidates` on `AMBIGUOUS_TARGET`, `region_candidates` on
  `OVERLAY_NO_DISMISS_INTENT`). Re-plan deliberately rather than retrying.
  Argument-validation refusals are here too — `INVALID_TARGET`, `INVALID_INPUT`,
  `NO_TAB`: Kruz read the call, understood it, rejected it, and `help` says what
  a correct call looks like. Fix the argument; never retry it unchanged.
- **`outcome: "failure"`** - the tool could not do its job: no session, crashed
  browser, timeout, a runtime exception in your own JS, an unhandled error.
  These *are* raised as errors.

Every `code` is one of the documented codes below. Operations that fail without a
more specific classification report `OPERATION_FAILED` and carry the originating
operation on `error.operation`.

### Retryable (safe to retry)
`ELEMENT_NOT_VISIBLE`, `ELEMENT_OBSCURED`, `STALE_ELEMENT`, `ELEMENT_DISABLED`, `NO_SESSION`, `BROWSER_CRASHED`, `ACTION_TIMEOUT`, `INTERNAL_ERROR`

**One exception inside that list.** A `ROUTE_TIMEOUT` response carries
`retryable: false` and `retry_safe: false` together, even though `ACTION_TIMEOUT` is
retryable in general. Completion is *unknown* and work may still be running, so
replaying risks a double-submit. **Observe before you retry** — `page.observe` or
`session.status` — and if the action already landed, do not repeat it.

### Non-retryable (fix the input — do NOT replay the same call)
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `STALE_REFERENCE`, `DOCUMENT_CHANGED`,
`CONDITION_NOT_MET`, `INVALID_TARGET`, `INVALID_INPUT`, `UNKNOWN_TOOL`,
`UNKNOWN_REFERENCE`, `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_EDITABLE`,
`OVERLAY_NO_DISMISS_INTENT`, `NO_TAB`, `FILL_NOT_RETAINED`

`FILL_NOT_RETAINED` means the field **took the input event but did not keep the value**
— a script handler rejected or reformatted it. It is deliberately not `CLICK_FAILED`:
`force:true` and overlay checks are click remedies and are wrong here. If the app commits
on blur, follow the fill with `page.press({key:"Tab"})` or `Enter`. For controlled
inputs, fill **one field at a time**; consecutive fills race each other.

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

### `BROWSER_LAUNCH_FAILED` — decide before you kill anything

`session.create` failed to start Chrome on the profile. Before killing processes, work
out **whether the lock holder is alive**, because the two cases need opposite responses
and the error text does not distinguish them:

| Lock holder | Diagnosis | Correct action |
|---|---|---|
| **Orphan** — a leftover Chrome with no MCP session driving it | dead process still holding `--user-data-dir` | Kill the tree. A separate `profile_dir` would *mask* the leak. |
| **Concurrent live session** — another agent/session is using Kruz right now | process is alive and in use | **Pass a separate `profile_dir`.** Killing it destroys real work, and that session's cookies/logins live in that profile. |

Diagnose before acting:

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'Kruz\\browser-profile' } |
  Select-Object ProcessId, ParentProcessId
```

A parent whose children are all present and whose owning session is gone is an orphan.
Confirm the session is really finished before killing anything — the cost of being wrong
is a live browser, not just a retry.

**Prefer `graceful: true`.** A hard close is no longer a profile-lock risk — it
terminates the browser process and releases `--user-data-dir` — but it still discards
unsaved browser state, so it should be a deliberate choice rather than the default.

`session.close({graceful:false})` no longer orphans Chrome. It previously closed only
the *active tab*, leaving the process and every other tab running and holding the lock,
so the next `session.create` failed; it now terminates the browser outright.

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
| `page.open` | `_timing.total_ms` (+ `lifecycle_state`, `navigate_ms`, `poll_ms`, `readiness_budget_ms`, `readiness_phase`) |
| `page.click` | `timing.total_ms`, `resolve_ms`, `action_ms`, `verify_ms` |
| `page.fill` | `timing.total_ms`, `resolve_ms`, `action_ms` |
| `page.press` | `timing.total_ms`, `resolve_ms`, `action_ms`, `grace_ms` |
| `page.clickAt` | `timing.total_ms`, `hit_test_ms`, `action_ms` |
| `page.scroll` | `timing.total_ms`, `action_ms` |
| `page.observe` | `timing.total_ms`, `generate_ms` |
| `page.handleOverlays` | `timing.total_ms`, `discovery_ms`, `dismissal_ms` |

`page.open` reports `_timing.lifecycle_state` — `resolved` (your requested wait
mode was honoured), `pending` (had not fired yet when the page was already
usable) or `gave_up` (never fired within the navigation budget, and
`_warning: "LIFECYCLE_NOT_RESOLVED"` is set). Readiness is decided from rendered
content and does not block on the lifecycle event, so `pending` with `_ready: true`
is a healthy page, not a broken navigation.

`_wait_condition` reports `requested` (your argument, verbatim),
`lifecycle` (what the browser was actually asked for) and `downgraded`. They
differ only when your request could not be passed through — check `downgraded`
if the wait mode matters to you.

`wait_for: "networkidle"` is honoured as a bounded in-page quiescence check
(≤8s), reported as `network_idle_reached`. It is not the browser's networkidle
event, which never fires on a page holding a WebSocket or long-poll.

A high `resolve_ms` means target resolution was hard (often genuine ambiguity); a high
`action_ms` means the browser was slow. Both are measured server-side.

---

## Notes

- Browser is **headed** (visible) by default — `session.create` rejects `headless: true`
- **Status banner** is top-left and always present: blue `Controlled by Kruz` while a
  call is in flight, amber `Model is thinking` between calls, clear
  `Input needed on Browser/TUI` when a human is expected; the cursor shows where
  actions land while blue
- **Input is locked** while the banner is blue only — the page is interactive in the
  other two states
- `session.pause` / `human.takeover` set the clear state immediately and report it as
  `overlay: {mode, banner}`; `session.resume` returns to amber. With no call at all, the
  banner promotes itself to clear after 20s of quiet
- `page.click` and `page.observe` report `timing`, so a slow call can be attributed
  (click splits `capture / dispatch / complete / feedback` and nests the controller's
  `resolve / action / verify` under `timing.dispatch_detail`)
- Use `session.pause` / `human.takeover` for manual intervention (login, CAPTCHA, 2FA),
  then `session.resume`
- All diagnostics go to **stderr**; stdout is reserved for MCP protocol
- For worked examples, deep recovery recipes and the ATS playbook, read
  [`MODEL_GUIDE.md`](./MODEL_GUIDE.md)
