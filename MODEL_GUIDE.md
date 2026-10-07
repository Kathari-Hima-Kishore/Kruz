# Kruz MCP — Model Instruction Manual

This guide is the deeper, project-local companion to [`SKILL.md`](./SKILL.md), which is
the global runtime contract served to agents over MCP. The skill carries the rules, the
closed loop and the tool list; this file carries worked examples, recovery recipes and
the ATS playbook. Read both.

---

## Quick Reference

| Goal | Tool | Example |
|---|---|---|
| Start browser | `session.create` | `{}` — returns the **measured** viewport |
| Navigate | `page.open` | `{url: "https://example.com"}` |
| See page | `page.observe` | `{detail: "standard"}` |
| **See the rendered page** | `page.screenshot` | `{"type": "jpeg", "quality": 70}` |
| **Inspect one element** | `page.screenshot` | `{"target": {ref: "e5"}}` |
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

### The viewport decides which elements exist

`session.create` returns `browser.viewport` — the viewport **measured** in-page
(`window.innerWidth/innerHeight`), not the configured default. On a headed Windows
session these routinely differ:

```json
"browser": { "viewport": { "width": 1536, "height": 730 },
             "viewport_requested": { "width": 1280, "height": 720 } }
```

Trust the measured one. It is the width responsive breakpoints key off, so it decides
whether the page served you the desktop nav or the mobile hamburger — and therefore
which elements exist to observe at all. `server.info`'s `config.viewport` reports the
same measured value.

**It is also pinned, so it cannot change under you.** `session.create` measures the
window and then pins that CSS viewport with CDP device metrics, so un-maximizing the
window can no longer flip a live session into its mobile layout. The pin is at the
*measured* size, not the configured default — creating a session does not silently
narrow it below the window's real width.

If a layout still looks wrong, ask rather than guess:

```json
{"name": "session.status"}                 // browser_viewport (live) + viewport_drifted
{"name": "page.setViewport", "arguments": {"width": 1440, "height": 900}}
```

`page.setViewport` does not resize the OS window, and it **preserves the device scale
factor**, so element screenshots stay in device pixels (`css × dpr`). When a control
you just observed is suddenly "not visible", check `session.status` before assuming
the click target was wrong.

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
- **same-href twins are the normal case on a storefront.** A nav link, a card and a
  footer link often share one URL, and they usually have *different* names
  (`RC Planes & Drones` vs `RC Planes and Drones` vs `Aeromodelling`). The name is
  what separates them — see "Same-href twins" below.

```json
{"target": {"role": "combobox", "name": "Theme"}}
{"target": {"label": "Location"}}
{"target": {"ref": "e7"}}
```

### Ref numbering and lifetime

- Ids restart in each new document: a busy page shows `e1…e400`, not `e8000`.
- A session keeps the 6000 most recent refs. Older ones are retired and then return
  `UNKNOWN_REFERENCE` — re-observe instead of reconstructing the id.

### Resolution tier — read it

Every successful action reports `resolution_tier`:

| Tier | Meaning |
|---|---|
| `1` | The **exact node** you observed, found by its recorded path |
| `2` | Recovered by exact semantic identity (role + name) |
| `3` | Recovered by bounded re-resolution inside the original match set |

Tier 1 is the normal, strongest case. If routine work keeps landing at tier 2/3, the
original node is not being found by path — worth reporting, because it means identity
is being reconstructed rather than pinned.

### `page.fill` — what `ok: true` now guarantees

Fill has its own recovery ladder: when the first resolution misses, it re-observes,
re-resolves and writes. A success from that path is marked:

```json
{"ok": true, "recovered_by": "re-observe-and-fill", "result": {"value_written": true}}
```

This matters because the ladder used to get this **backwards**. Its action re-threw
unconditionally, so after the escalation had genuinely written the value, Kruz still
reported a *failure* — which tells the caller a field did not take when it did, and
invites a retry that writes it twice. That is the shape of the Canva numeric-field
failures in the error log (`Fill did not retain the requested value` on fields that
were fine). It is fixed: an escalation that wrote reports success.

App-side behaviours that look identical and are **not** Kruz bugs:

| Symptom | Cause | Response |
|---|---|---|
| `ok: true`, value reverts a moment later | app commits on blur, not on input | follow with `page.press({key:"Tab"})` or `Enter` |
| `FILL_NOT_RETAINED` | a script handler rewrote or rejected the value | check the app's input handling; do **not** retry with `force:true` |
| second field loses its value | consecutive fills race | one field at a time, each followed by `Tab` |

### Same-href twins — the recovery, when tier 1 misses

The normal case on that page needs none of this — the card's ref now resolves at
`resolution_tier: 1`. This is what to do when a ref *does* land ambiguously, measured
on `makerbazar.in`, where four anchors share `/collections/rc-planes-and-drones`.

```json
// 1. Observe, and NOTE THE NAME you saw
{"detail": "standard"}                    // -> { ref: "e81", name: "RC Planes and Drones" }

// 2. Click it
{"target": {"ref": "e81"}}

// 3. If AMBIGUOUS_TARGET: read result.candidates, not just the message
{
  "error": { "code": "AMBIGUOUS_TARGET",
             "message": "Reference 'e81' re-resolved to 3 candidate(s)...",
             "help": "Act on one of the returned candidate refs..." },
  "result": { "count": 4, "candidates": [
    { "ref": "e401", "name": "RC Planes & Drones",  "actionable": false,
      "blocked_reason": "not rendered (display:none, visibility:hidden, hidden ancestor, or zero size)" },
    { "ref": "e402", "name": "RC Planes & Drones",  "actionable": true },
    { "ref": "e403", "name": "RC Planes and Drones", "actionable": true },
    { "ref": "e404", "name": "Aeromodelling",       "actionable": true }
  ]}
}

// 4. Act on the one whose NAME matches what you observed and is actionable
{"target": {"ref": "e403"}}                // -> verified, resolution_tier 1
```

**Never re-click the original ref after an ambiguity refusal.** It reproduces the
identical error. And never pick by position — pick by `name`, skipping any entry with a
`blocked_reason`.

---

## Inputs click and press cannot express

### `page.drag` — press, move, release

Some editors have exactly one gesture for their core action: Tinkercad places a shape
**only** by dragging a palette tile onto the workplane. Click-click is not a gesture it
recognises, and an in-page synthetic `PointerEvent` drag is silently discarded — the
run looks healthy while doing nothing.

```json
{ "from": { "css": "#sidebar-item-box" }, "to": { "css": "#workplane" } }
```

Each endpoint is `{x,y}` in CSS pixels **or** any target `page.click` accepts (which
is scrolled into view and grabbed at its centre). It dispatches **trusted** input with
**real per-step timing**, which is the part that matters: a press/move/release that
arrives in a single task is dropped by custom drag engines.

- `speed: "slow"`, or a higher `steps`, is the lever when the first attempt is ignored.
- `modifiers: ["Shift"]` is held for the whole gesture.
- `mode: "html5"` uses the HTML5 drag API and needs two **targets**. Seed `data`
  explicitly — Chrome discards `setData` made by the page's own `dragstart` handler on
  a synthetic DataTransfer, so without `data` the drop handler reads an empty value.

**Read `verification`:** `navigation` | `dom_change` | `no_change`. A drop that changed
nothing returns `verified: false` plus `unverified_reason` and a `hint` — it never
claims success. Canvas/WebGL editors draw without touching the DOM, so verify those
with `page.screenshot`.

### `modifiers` on `page.click`

Keys held across the click, then released. Shift-click / ctrl-click multi-select and
additive range selection cannot be expressed by a key **combo** (`page.press
"Control+g"`) because a combo is atomic while multi-select needs the modifier held
across the click. Always released — a plain click afterwards is never still
shift-modified.

### `page.uploadFile`

`DOM.setFileInputFiles` plus the change event. An in-page `DataTransfer` cannot
populate a real file input, so there is no `page.evaluate` recipe for this. The input
does not need to be visible. Paths resolve on the machine running Kruz.

```json
{ "target": { "css": "input[type=\"file\"]" }, "paths": ["C:/models/part.stl"] }
```

## Known unsupported flow: Google-account sign-in

Google classifies a Puppeteer-**launched** Chrome as automation and rejects sign-in
with *"This browser or app may not be secure"* — **even when a human types the
credentials by hand** during `session.pause`. The check is transport-level, not
page-visible: `navigator.webdriver` masked, `window.chrome.runtime` present, plugin
counts normal, and it still rejects. Do not spend turns on it.

Prefer `session.create {"cdp_url": "http://127.0.0.1:9222"}` to attach to the user's
own daily-driver Chrome (started with `--remote-debugging-port=9222`), which carries
real profile reputation; `session.close` then disconnects and leaves it running.
Alternatively point `profile_dir` at a **copy** of a profile that already carries the
Google session. Other SSO flows and ordinary logins are unaffected — `session.pause`
remains correct for those.

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

## Vision — `page.screenshot`

Delivers the real pixels as an MCP image content block. This is **image analysis, not
OCR**: you get the image and interpret it yourself.

| Call | Returns |
|---|---|
| `{"type": "jpeg", "quality": 70}` | current viewport |
| `{"full_page": true, "type": "jpeg", "quality": 60}` | whole scrollable page (large — use jpeg) |
| `{"target": {"ref": "e81"}, "type": "png"}` | that one element only |
| `{"target": {"css": ".nav-bar__link"}}` | any target, same syntax as `page.click` |
| `{"target": {"ref": "e81"}, "path": "dump/card.png"}` | same image **and** a copy kept on disk |

`path` is additive, not exclusive — you still receive the image to look at. Point
scratch captures at the repo's gitignored `dump/` folder so they stay out of
`git status` and are yours to delete.

Alongside the image you get a metadata block: `mime_type`, `width`, `height`, `bytes`,
`mode`, and — for a `ref` crop — the `ref` it used.

```json
{"ok": true, "ref": "e81",
 "result": { "mime_type": "image/png", "width": 298, "height": 313,
             "bytes": 47335, "mode": "element", "ref": "e81",
             "scale": 1.25, "viewport_css": { "width": 1536, "height": 730 },
             "image_space": "device_px", "target_space": "css_px",
             "image_attached": true }}
```

### Coordinate spaces — the trap that bites

A capture is in **device pixels**. `page.clickAt` takes **CSS pixels**. These differ by
`devicePixelRatio`, which is frequently 1.25 and is **not** the same in both axes when
a window has been resized.

Every capture now declares its own space, so the conversion is arithmetic rather than
guesswork:

```json
"scale": 1.25, "viewport_css": { "width": 1536, "height": 730 },
"image_space": "device_px", "target_space": "css_px"
```

```
DOM coords = image coords / scale
```

Verified: `1536 x 730` CSS at `scale 1.25` → a `1920 x 912` capture (±1; Chrome floors).

**Never pass image pixels straight to `clickAt`.** Doing so on a Canva canvas hit an
unrelated `<h5>Suggested palettes</h5>` instead of the intended colour chip, and the
hit-test is what revealed it. Derive coordinates from `getBoundingClientRect` and use
captures as visual context only.

**Never cache coordinate math across sessions.** Another agent can resize the window
mid-task, silently changing `scale`.

### When to reach for it

- a control or icon with **no accessible name, no alt, no class** — the DOM genuinely
  cannot tell you what it is
- canvas / WebGL / image-based UI
- *"is this actually visible / obscured / overlapping?"* — computed style is a weak
  proxy for sight, and `offsetWidth` is non-zero even on `visibility:hidden`
- layout and rendering checks; comparing two captures
- **the user described something by appearance** — *"the card with the aeroplane on it"*

That last case is the one vision genuinely wins. A DOM sweep finds the markup; vision
answers the question actually asked.

### Two measured traps

1. **Captures come back in DEVICE pixels.** Expected size = client rect ×
   `devicePixelRatio`. On a `dpr 1.25` display a `238×250` CSS card correctly captures
   as `298×313`. Comparing a device-pixel capture to a CSS-pixel rect looks like a bug
   and is not one — check `devicePixelRatio` before reporting anything.
2. **`full_page` at PNG runs megabytes.** Pass `type: "jpeg"` with `quality` 60–80.

### Vision is perception, refs are action

Use a capture to **decide**, then act through `page.click` on a ref. Do not click by
eyeballing coordinates from an image, and do not treat "I described the picture" as
verification — `verified: true` is still the only confirmation that a click did what
you meant.

---

## The Control Banner (three states)

The banner is **always visible, top-left**, and always states which of three states the
browser is in. Only the glow changes; the banner never disappears.

| State | Glow | Banner | Input locked? |
|---|---|---|---|
| `controlling` | blue, pulsing | `Controlled by Kruz` | **yes** |
| `thinking` | amber, no pulse | `Model is thinking` | no |
| `awaiting` | none (no colour) | `Input needed on Browser/TUI` | no |

- **Cursor** = shows where the next action will land (blue state only)
- **Input lock** = blue state only; the page is interactive in the other two

### How it is driven

A single page-side watchdog ticks every 50ms off two clocks:

- `lastPing` — *is a call in flight?* → blue within ~650ms of the last heartbeat.
- `lastEngaged` — *did the model do anything recently?* → amber within 20s of the last
  activity, clear after that.

So amber covers the ordinary "model is generating/deciding" gap, and **clear happens on
its own** once the model has been quiet for 20s — which is exactly the state it reaches
when its turn ends and it is waiting for you, without anything having to call
`session.pause`.

Measured on a live session, 600 samples at 50ms (`dump/overlay-states-verify.mjs`):

```
    54–  699ms  controlling   action in flight
   753– 2505ms  thinking      heartbeat lapsed
  2551– 5004ms  awaiting      session.pause
  5052–25014ms  thinking      session.resume
 25062–30013ms  awaiting      auto-promoted, NO call made
```

`session.pause` and `human.takeover` report the state they set as
`overlay: {mode: "awaiting", banner: "Input needed on Browser/TUI"}`; `session.resume`
answers `overlay: {mode: "thinking", banner: "Model is thinking"}`.

A ping clears any explicit `awaiting` claim, so the banner can never claim it needs
input while the model is actively working.

### An amber banner is usually correct, not a fault

Amber means the model is between actions and may act again. The input lock is lifted in
both amber and clear states, so the page is yours to touch. Never wait for blue before
acting.

Things that legitimately look like a wrong state:

- **Between calls.** By design. Never wait for it before acting.
- **Immediately after a navigation.** A new document reinstalls the layer at `thinking`;
  the first ping promotes it to blue.
- **Lifecycle tools.** `session.*`, `server.info` and `human.takeover` never raise the
  blue state; they drive the banner explicitly instead.

Do not try to observe the idle state *through* a tool call: every call pings before it
evaluates, so you will always read `controlling`. Use a page-side sampler — this is why
`__kruzVisual.snapshot()` exists, and why the verification harness registers a recorder
once and then makes no reads while it measures.

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

Argument-validation refusals are in the first group, not the second:
`INVALID_TARGET`, `INVALID_INPUT` and `NO_TAB` resolve with `ok: false` and a
`help` string naming the correct call shape. A `SyntaxError` in your own
`page.evaluate` expression is `INVALID_INPUT` and resolves; a runtime
`ReferenceError` is `OPERATION_FAILED` and throws. Every `code` is documented -
operations with no more specific classification report `OPERATION_FAILED` and put
the originating operation on `error.operation`.

### Retryable errors (the same call may succeed shortly)
`ELEMENT_NOT_VISIBLE`, `ELEMENT_OBSCURED`, `ELEMENT_DISABLED`, `STALE_ELEMENT`,
`NO_SESSION`, `BROWSER_CRASHED`, `ACTION_TIMEOUT`, `INTERNAL_ERROR`

**Exception inside that list:** a `ROUTE_TIMEOUT` response sets `retryable: false`
alongside `retry_safe: false`, even though `ACTION_TIMEOUT` is retryable in general.
Completion is *unknown* and work may still be running. **Observe before retrying** —
a blind replay double-submits. Observed live: a click that reported timeout had in fact
succeeded and opened a new tab.

### Non-retryable errors (replaying cannot work — reconsider)
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `STALE_REFERENCE`, `DOCUMENT_CHANGED`,
`CONDITION_NOT_MET`, `UNKNOWN_REFERENCE`, `UNKNOWN_TOOL`,
`ELEMENT_NOT_FOUND`, `ELEMENT_NOT_EDITABLE`, `INVALID_TARGET`, `INVALID_INPUT`,
`NO_TAB`, `OVERLAY_NO_DISMISS_INTENT`, `FILL_NOT_RETAINED`

`FILL_NOT_RETAINED` means the field took the input event but did not keep the value —
a script handler rejected or reformatted it. Distinct from `CLICK_FAILED` because the
remedy is different: `force:true` is for clicks and is wrong here. Apps that commit on
blur need a following `page.press({key:"Tab"})` or `Enter`; controlled inputs need one
field at a time, because consecutive fills race.

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

**Ambiguous target?** This is the **exception**, not the routine — a well-behaved ref
resolves at `resolution_tier: 1`. Ambiguity means the recorded path missed and identity
had to be rebuilt from semantics; same-href twins (nav + card + footer on one URL) are
the usual cause. The candidates are under **`result.candidates`**, not in the message —
each entry has `ref`, `role`, `name`, `href`, `actionable`, `blocked_reason`.

1. Act on the `ref` of the candidate whose **`name` matches what you observed** and
   whose `actionable` is `true`; skip any entry carrying a `blocked_reason`
2. Or narrow with a `scope` / a more specific selector
3. Do NOT re-observe blindly, and do NOT re-click the original ref — the candidates are
   already in the response, and re-clicking the original reproduces the same refusal

If you hit this repeatedly on one page, report it as a path-resolution defect rather
than working around it forever.

**Browser failed to launch?** (`BROWSER_LAUNCH_FAILED` — the profile is locked)
Decide whether the holder is **alive** before killing anything; the two cases need
opposite responses and the message does not distinguish them:

| Holder | Correct action |
|---|---|
| Orphan — leftover Chrome, no session driving it | Kill the tree. A new `profile_dir` would **mask** the leak. |
| **Concurrent live session** — someone is using Kruz now | **Pass a separate `profile_dir`.** Killing it destroys real work and that session's cookies live in that profile. |

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'Kruz\\browser-profile' } |
  Select-Object ProcessId, ParentProcessId
```

Being wrong here costs a live browser, not a retry. Confirm the other session has
actually finished before killing its tree.

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

### Pattern 1b: Look → Act  (when the target is described by appearance)

```json
// 1. Look at the page — you receive the image and read it
{"type": "jpeg", "quality": 70}

// 2. Or inspect just the candidate: "which of these is the plane card?"
{"target": {"css": "a.collection-item"}, "type": "png"}

// 3. Act on the ref that observation minted for the thing you identified
{"target": {"ref": "e81"}}
```

Reach for this when the DOM cannot answer the question — unnamed icon controls,
canvas UI, visibility questions, or any request phrased by what something *looks
like*. Element crops are cheap (tens of KB) and pinpoint; a full-page capture is for
orienting yourself, not for finding things.

**Verified end-to-end** on `makerbazar.in`, a page with four same-href anchors:

| Step | Result |
|---|---|
| crop by ref `e81` | `298x313` device px = `238x250` CSS × `dpr 1.25` |
| capture echoes | `ref: "e81"` — same ref, no second resolve |
| click that ref | `verified: true`, `resolution_tier: 1` |
| landed on | `/collections/rc-planes-and-drones` |

`resolution_tier: 1` is the guarantee worth checking: the ref resolved to the **exact
node** you looked at. A `{text: …}` target reports tier `0` instead — it bypasses
identity resolution entirely, which is why it works even when ref resolution is
degraded, but it is a weaker guarantee about *which* element was hit.

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
`_timing.lifecycle_state: "pending"` as a broken navigation — it only says the
event had not fired yet when the page was already usable (common with slow
images, long-polling connections and SPAs). If `_ready` is true and `_waited_ms`
is small, the page is ready regardless. `"gave_up"` is the one to act on, and it
sets `_warning: "LIFECYCLE_NOT_RESOLVED"`.

Check `_wait_condition.downgraded` if your wait mode matters: `requested` echoes
your argument and `lifecycle` shows what the browser was really asked for.
`wait_for: "networkidle"` is honoured as a bounded (≤8s) in-page quiescence
check and reports `network_idle_reached`.

### Reading a slow `page.open`

`_timing` now carries two fields that make a slow open self-explaining:

- `readiness_budget_ms` — the ONE budget the readiness decision was allowed.
- `readiness_phase` — which phase produced the verdict.

Read them in that order before blaming or retrying:

| `readiness_phase` | Meaning | What to do |
|---|---|---|
| `content-poll` | The first content poll already had real content. | Normal. Use the page. |
| `pre-commit-repoll` | Not ready at first contact; the navigation had not committed yet, so Kruz kept polling content. | Normal for slow portals. |
| `budget-exhausted` | `timeout_ms` elapsed with no real content. **The page is genuinely not usable yet** — this is your timeout being too small, not a Kruz fault. | Raise `timeout_ms`, or `wait_for:"commit"`, or wait on the specific element with `page.wait` + a `predicate`. |

`poll_ms` is the readiness work and stays within `readiness_budget_ms`; total
`_timing.total_ms` adds a bounded 250 ms navigation-cleanup race and a bounded
1.5 s tab-id lookup on top. **A `page.open` will always return an answer** — it
never converts a known verdict into `ACTION_TIMEOUT` / `outcome:"unknown"`, so if
you see that, the budget itself was exhausted upstream and the run should be
re-examined rather than retried blindly.

When `_ready` is false you get `ok: true` with `_warning: "PAGE_NOT_READY"` plus
a message saying whether the navigation committed at all. That is a *result*, not
an error: the browser is alive and the previous document was never mistaken for
the new one (`_pre_nav_url` is present when it still shows the old page).

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
`page.click`, `page.clickAt`, `page.drag`, `page.fill`, `page.press`, `page.select`, `page.check`, `page.uncheck`, `page.scroll`, `page.paginate`, `page.setViewport`, `page.uploadFile`

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

> **Google accounts are the exception** — a launched Chrome is rejected regardless of
> who types. Use `cdp_url` attach or an existing Google session; see *Known
> unsupported flow* above. Everything else (including `session.pause` for a real login
> form) follows this shape.

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
- The **top-left banner** always states the current state: blue `Controlled by Kruz`
  while a call runs, amber `Model is thinking` between calls, clear
  `Input needed on Browser/TUI` when a human is expected (auto after 20s of quiet)
- The **cursor** shows where actions will land (blue state only)
- **Input is locked** while the banner is blue only
- Use `session.pause` for manual intervention (login, CAPTCHA, 2FA), then
  `session.resume` — both report the banner state they set as `overlay: {mode, banner}`
  — **except Google sign-in**, which a launched Chrome is rejected for regardless
- The CSS viewport is **pinned** at create, so the window manager cannot flip a live
  session into its mobile layout; `page.setViewport` re-pins it, and `session.status`
  reports the live value plus `viewport_drifted`
- `page.drag` / `page.uploadFile` / `page.setViewport` cover the input paths that
  click, press and `page.evaluate` cannot express
- `page.click` / `page.observe` report `timing`, so a slow call can be attributed
- All diagnostics go to **stderr**; stdout is reserved for MCP protocol
