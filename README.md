# Kruz — Headed Browser Automation MCP Server

A reliable, verification-first MCP server that gives AI agents a **visible Chrome browser** to drive real websites. Kruz is not a computer-use vision loop: it is **deterministic selector-first control** with postcondition verification, recovery ladders, typed errors, and a human-in-the-loop handoff for login/CAPTCHA/2FA.

| | |
|---|---|
| **Version** | 1.7.1 |
| **Transport** | stdio (MCP JSON-RPC) |
| **Tools** | 53 registered |
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

Kruz launches a visible Chrome profile and exposes **53 tools** that let an agent navigate, observe, click, drag, fill, upload, select, extract, evaluate JavaScript, capture network responses, and run ATS (job-board) workflows across real sites - including Workday, Oracle HCM, iCIMS, Greenhouse, Lever, Ashby, SmartRecruiters, SuccessFactors, Phenom, Taleo, Avature, and Eightfold career portals.

Four properties define Kruz:

1. **Semantic targeting** — refs and role/name based locators, not brittle coordinates.
2. **Verified actions** — a click is not "done" when dispatched; it is checked against a postcondition (navigation, rendered destination, in-place change, new tab, dialog).
3. **Recovery ladders** — failed actions escalate: dismiss overlays → re-observe → visual click.
4. **Human-in-the-loop** — a headed browser, a control-status overlay, an input lock while the model acts, and explicit pause/resume/takeover.

---

## Quick Start

### 1. Prerequisites
- **Node.js** v18+ — https://nodejs.org
- **A Chromium-based browser** — Google Chrome is the default target, but Chromium,
  Microsoft Edge and Brave are all detected and work identically (they speak the
  same DevTools Protocol). Nothing needs to be installed if you already have one.

### 2. Build

```bash
npm install
npm run build
```

`npm run build` does two things:

1. compiles TypeScript to `dist/`, and
2. **writes your OpenCode MCP registration** (see below).

### 3. Registration is generated — nothing to edit by hand

After `npm run build`, an `opencode.json` sits next to `package.json` containing
a fully-formed `kruz` server entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "kruz": {
        "type": "local",
        "command": ["C:\\path\\to\\node.exe", "C:\\path\\to\\kruz\\dist\\index.js"],
        "cwd": "C:\\path\\to\\kruz",
        "environment": { "LOG_LEVEL": "info" },
        "timeout": 60000
      }
    }
  },
  "permissions": [
    { "action": "kruz_*", "resource": "*", "effect": "allow" }
  ]
}
```

Then restart OpenCode and ask: *"Use kruz to open https://example.com."*

#### Why it is generated rather than committed

Every path above is **discovered at build time**, not stored in the repository:

| Value | How it is resolved | Why |
|---|---|---|
| `command[0]` (node) | `process.execPath` — the interpreter running the build | OpenCode launches MCP servers with an inherited environment where a bare `node` is often **not on PATH** (GUI launch, nvm/Volta, service account). That fails as `ENOENT` and the server shows as errored. |
| `command[1]` / `cwd` | derived from the build script's own location | Correct on `C:\tools\kruz`, `D:\project prototypes\kruz`, or a UNC share alike. |

Because the file is machine-specific, it is **gitignored**. Committing it would
hand every other checkout the first developer's paths — the exact hardcoded-path
failure this setup removes. Re-running `npm run build` regenerates it correctly
for whoever cloned. Move or rename the checkout and rebuild; you will never edit
a path by hand.

#### What it will not do

- **It never touches your personal config.** The project-local `opencode.json` is
  the default target. To register Kruz for *every* project on the machine:

  ```bash
  npm run register:global     # writes ~/.config/opencode/opencode.json
  ```

- **It never mixes config dialects.** OpenCode V1 placed servers directly under
  `mcp`; V2 nests them under `mcp.servers`. Writing the wrong shape is not a
  syntax error — the entry is simply **ignored and the server never connects**.
  The writer detects which dialect your existing file uses and matches it, so an
  older config keeps working instead of becoming a half-connected hybrid.

- **It never clobbers your settings.** Every unrelated key in the file —
  providers, models, permissions, your other MCP servers — is preserved,
  including comments and trailing commas in `.jsonc` files. If the existing
  config cannot be parsed, the build **fails loudly instead of overwriting it**.

- **It never registers a broken build.** If `dist/index.js` does not exist (a
  failed `tsc`), nothing is written.

Useful commands:

```bash
npm run register          # rewrite the project-local entry only
npm run register:global   # write the user-wide entry
npm run build:only        # compile without touching config
```

#### Other MCP clients

The generated file is OpenCode-specific, but the server is plain MCP over stdio,
so any client works. Point it at the built entry point with node as the command:

```bash
node "<install-dir>/dist/index.js"
```

### 4. Running

```bash
npm start          # Production (compiled dist/)
npm run dev        # Development (tsx, no build)
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/, then writes opencode.json
npm test           # vitest run
```

> After rebuilding `dist/`, close the old Kruz session and reconnect the MCP
> server — a rebuild does not change an already-running process.

---

## Tools (53 registered)

`KNOWN_TOOLS` (in `src/mcp/tool-names.ts`) is the single source of truth, enforced at startup against the actual registrations. MCP `tools/list` and the `kruz://tools` resource report the same set.

### Server & session
| Tool | Purpose |
|---|---|
| `server.info` | Server/session/config diagnostics (no session needed) |
| `session.create` | Create or reuse the headed Chrome session. `browser.viewport` is the **measured** viewport (`window.innerWidth/innerHeight`); `browser.viewport_requested` is what was asked for. The viewport is **pinned** at the measured size so it cannot drift. `cdp_url` attaches to an already-running Chrome instead of launching one |
| `session.status` | Session state, tabs, navigation trace, **live** `browser_viewport` + `viewport_drifted` |
| `session.close` | Close the browser |
| `session.pause` | Release control for manual work (login/CAPTCHA/2FA) |
| `session.resume` | Hand control back to the model |

### Navigation & tabs
`page.open` · `page.newTab` · `page.switchTab` · `page.listTabs` · `page.closeTab`

### Observation
`page.observe` (scope + `detail`: `minimal` | `standard` | `full`) · `page.computerUseList` · `page.computerUseSnapshot` · `page.probe`

### Vision
`page.screenshot` — viewport, `full_page`, or a single element (`target`). Returns the real image as an MCP image content block for visual analysis (not OCR), plus `mime_type` / `width` / `height` / `bytes` / `mode` / `ref`. Captures are in **device pixels**; use `type: "jpeg"` for full-page.

### Clicking & input
`page.click` (with `modifiers` for shift/ctrl-click) · `page.clickAt` · **`page.drag`** · `page.fill` · `page.press` · `page.select` · `page.check` · `page.uncheck` · `page.scroll` · `page.paginate` · `page.wait` · **`page.setViewport`** · **`page.uploadFile`**

- **`page.drag`** — trusted press→move→release between two `{x,y}` points or two targets, with real per-step timing (custom drag engines ignore a same-task gesture). `mode: "html5"` for the HTML5 drag API, with the `DataTransfer` payload seeded explicitly via `data`. Reports `verified` + `verification: navigation | dom_change | no_change`, and a drop that changed nothing returns `verified: false` with a reason rather than a false success.
- **`page.setViewport`** — pin the CSS viewport (CDP device metrics; the OS window is untouched) so a responsive layout cannot flip under the agent. Preserves the device scale factor, so element captures stay in device pixels.
- **`page.uploadFile`** — `DOM.setFileInputFiles` + change event. The only route a page cannot fake; the input may be `display:none`.

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

Recorded paths are built as **child chains** (`section > div > a:nth-of-type(2)`), not descendant chains. This matters: `:nth-of-type` is only emitted where an element has same-tag siblings, so a run of lone-child `div`s contributes bare `div` segments — joined as descendants those fan out and the "unique" path matches many nodes, which silently defeats tier 1 and pushes every ref onto name matching. On `makerbazar.in` the descendant form matched 4 unrelated anchors; the child form matches exactly 1.

Successful actions report **`resolution_tier`** — `1` means the exact node was pinned, `0` that the target was resolved without the ref ladder (e.g. a `text` target). Tier 1 is the guarantee; tier 0 works but is weaker evidence about *which* element was hit.

---

## Vision

`page.screenshot` returns the **actual pixels** as an MCP image content block — for image *analysis*, not OCR. The model receives the image and interprets it.

```json
{"type": "jpeg", "quality": 70}                        // viewport
{"full_page": true, "type": "jpeg", "quality": 60}     // whole page
{"target": {"ref": "e81"}, "type": "png"}             // one element
{"target": {"css": ".collection-item"}, "path": "dump/card.png"}   // + keep a copy
```

This closes a real gap: the engine has always had `screenshot()` and `screenshotElement()`, but the tool was never registered — deleted on the reasoning that *"text-model runs never look at pixels"*, which was a claim about consumers rather than about the code. Vision-capable models are now the norm.

**Captures are returned in DEVICE pixels** (`client rect × devicePixelRatio`) for both viewport and element modes — on a `dpr 1.25` display a `238×250` CSS card captures as `298×313`. Comparing a device-pixel capture against a CSS-pixel rect looks like a bug and is not one.

Because `page.clickAt` takes **CSS** pixels, every capture declares its own coordinate space so the conversion is arithmetic rather than guesswork:

```json
"scale": 1.25, "viewport_css": { "width": 1536, "height": 730 },
"image_space": "device_px", "target_space": "css_px"     // DOM coords = image coords / scale
```

Passing image pixels straight to `clickAt` hits a different element; a hit-test on
Canva returned an unrelated `<h5>` instead of the intended chip. And `scale` is not
stable across a session — another agent resizing the window changes it.

Element captures echo the `ref` they used, so a visual finding can be clicked with no second resolve. `dump/` is a gitignored scratch folder for keeping captures.

---

## Human-in-the-loop indicator

A persistent **top-left banner** states which of three states the browser is in; only
the glow changes, and the banner itself never disappears.

| State | Glow | Banner text | Input |
|---|---|---|---|
| `controlling` | blue, pulsing | `Controlled by Kruz` | locked |
| `thinking` | amber, no pulse | `Model is thinking` | interactive |
| `awaiting` | none | `Input needed on Browser/TUI` | interactive |

A virtual cursor (blue state only) shows where the next action will land.

**How the states are driven.** A page-side watchdog ticks every 50 ms off two clocks:
`lastPing` (is a call in flight? → blue, within ~650 ms) and `lastEngaged` (did the
model act recently? → amber within 20 s, clear after that). So the clear state happens
on its own when the model's turn ends and nothing calls `session.pause` — the normal
TUI case. `session.pause` / `human.takeover` set it immediately and report it as
`overlay: {mode: "awaiting", banner: "..."}`; `session.resume` returns to amber.

State has one mechanism: a heartbeat the page's own watchdog expires. There is no paired
on/off call, so nothing can switch it off mid-call, and a crashed or hung server cannot
strand it on. A duplicated server-side "force it off" call used to race the heartbeat and
darken an in-flight call; it was removed, which also dropped a CDP round-trip from every
call. A ping clears any explicit `awaiting` claim, so the banner can never claim it needs
input while the model is working.

Measured on a live session, 600 samples at 50 ms:

```
    54–  699ms  controlling   action in flight
   753– 2505ms  thinking      heartbeat lapsed
  2551– 5004ms  awaiting      session.pause
  5052–25014ms  thinking      session.resume
 25062–30013ms  awaiting      auto-promoted, NO call made
```

A new document starts at `thinking` (the layer reinstalls with no heartbeat yet) and is
promoted to blue on the next ping after a navigation. Lifecycle tools (`session.*`,
`server.info`, `human.takeover`) never raise blue; they drive the banner explicitly.

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
- **fill**: `re-observe-and-fill`

When a fill recovers through its ladder the success is marked, so a caller can tell a
straight write from a recovered one:

```json
{"ok": true, "recovered_by": "re-observe-and-fill", "result": {"value_written": true}}
```

This is a correctness fix, not a cosmetic one. The ladder's action used to re-throw
unconditionally, so once its escalation had genuinely written the value, Kruz still
reported a **failure** — telling the caller a field had not taken when it had, and
inviting a retry that writes it twice. An escalation that wrote now reports success.
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
| `refusal` | Kruz did its job; the answer is "not safely". Nothing was guessed or clicked, and the payload carries what it was found (`candidates`, `region_candidates`). Includes argument-validation refusals — `INVALID_TARGET`, `INVALID_INPUT`, `NO_TAB` — where `help` names the correct call shape. | resolves as a value — `if (!r.ok)` is sufficient, no `try/catch` |
| `failure` | The tool could not do its job: no session, crashed browser, timeout, unhandled exception, a runtime error in your own JS. | raised as an error |

Every `code` is one of the documented codes. An operation that fails with no more
specific classification reports `OPERATION_FAILED` and carries the originating
operation on `error.operation`, so `code` is always something you can branch on —
never a tool name.

This split exists because `isError: true` is surfaced by most MCP clients as a
thrown exception with the JSON flattened into `Error.message`. That made the
documented `if (!r.ok)` branch unreachable and forced callers into `try/catch`
around tools that return values — and it made delivery depend on the client and
on which call it was, so code validated against the first call failed on the
second.

On a failed response the six envelope fields (`code`, `message`, `retryable`,
`outcome`, `subsystem`, `help`) are readable **both** under `error` and directly
off the response, so `r.code` and `r.error.code` both work. Likewise `page_id`
appears at the top level of every tool response, not only inside a nested
`result`. Reading a documented field at the wrong depth previously produced
false bug reports against fields that were present and correct.

**Retryable** (the same call may succeed shortly): `NO_SESSION`, `BROWSER_CRASHED`, `ELEMENT_OBSCURED`, `ELEMENT_NOT_VISIBLE`, `ELEMENT_DISABLED`, `STALE_ELEMENT`, `ACTION_TIMEOUT`, `NO_MATCH`, `INTERNAL_ERROR`.

One deliberate exception: a `ROUTE_TIMEOUT` response reports `retryable: false` next to
`retry_safe: false`, overriding the `ACTION_TIMEOUT` default above. Completion is
*unknown* and work may still be running — a blind replay double-submits. Observed live:
a click that timed out had in fact succeeded and opened a new tab. Inspect with
`page.observe` or `session.status` before retrying.

**Non-retryable** (replaying cannot work — reconsider or re-declare): `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `STALE_REFERENCE`, `DOCUMENT_CHANGED`, `UNKNOWN_REFERENCE`, `CONDITION_NOT_MET`, `INVALID_TARGET`, `INVALID_INPUT`, `NO_TAB`, `UNKNOWN_TOOL`, `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_EDITABLE`, `OVERLAY_NO_DISMISS_INTENT`, `FILL_NOT_RETAINED`.

`FILL_NOT_RETAINED` means the field accepted the input event but did not keep the value — a script handler rejected or reformatted it. It is deliberately distinct from `CLICK_FAILED`: `force:true` and overlay checks are click remedies and are wrong here. If the app commits on blur, follow the fill with `page.press({key:"Tab"})` or `Enter`; for controlled inputs, fill one field at a time.

> The same taxonomy, with recovery recipes, is in [`SKILL.md`](./SKILL.md) — that is what
> agents read at runtime.

### One Kruz per project: the single-instance contract

The generated `opencode.json` sets each entry's `cwd` to the install directory, so
every Kruz process spawned against the same install shares **one ownership record**.

OpenCode restores **every workspace at once**, so a cold start spawns one Kruz per
project within a few milliseconds of each other. Two failure modes came out of that,
both fixed:

1. **The kill-storm (the startup bug).** Under "newest wins", a newcomer terminated any
   live server. On a simultaneous cold start they terminated *each other*, and the
   killed spawns exited with code 1 — shown in `/mcp` verbatim as
   `MCP server process exited with code 1: [kruz] single-instance: KRUZ_TAKEOVER=1 —
   terminating live Kruz server pid=...`. A manual `/mcp` retry appeared to "fix" it
   because the retry spawns a fresh process that wins the race. A newcomer now **leaves
   a live owner alone and serves alongside it**; takeover terminates only a *recorded*
   predecessor, never one merely inferred from a process scan (verified by
   `dump/coldstart-verify.mjs`, which launches three servers in the same instant).
2. **Killing the wrong process.** The record holds a pid, and Windows recycles pids, so
   a record surviving a crash can later name an unrelated program. Kruz verifies the
   command line *and* the OS start time before ever signalling, and treats an
   unreadable identity as "do not kill". Not theoretical: a plain `node -e` process
   recorded as the predecessor was SIGKILLed by the old code.

The rules that now hold:

- **Coexisting servers do not fight.** Several Kruz processes may be alive (one per
  open workspace); the single-writer Chrome profile is what actually serialises the
  browser, enforced at `session.create`.
- **One browser owner.** A process becomes the record's owner only when no live owner
  already exists. The owner reaps orphaned Chrome (and only when no peer is alive).
- **`KRUZ_TAKEOVER=1`** restores destructive newest-wins — it terminates a *recorded*
  predecessor. It no longer causes a cold-start error, because an unrecorded peer is
  never a kill target; if you genuinely prefer one process and see a stray loser exit,
  that is the price of newest-wins, not a crash.
- **`KRUZ_SINGLE_INSTANCE=0`** disables the guard entirely.

**To run Kruz in two projects at once, give each its own profile.** This is not
optional — it was measured, not assumed (`dump/mcp-server-verify.mjs`):

| Configuration | Result |
|---|---|
| Two sessions, **same** `profile_dir` | 2nd fails `BROWSER_LAUNCH_FAILED` — Chrome enforces a single-writer lock on a user-data-dir. |
| Two sessions, **distinct** `profile_dir` | Both launch, both stay independently responsive. |

So per project, give that project's Kruz entry its own `BROWSER_PROFILE_DIR` (e.g.
`./browser-profile/<project>`) **and** `KRUZ_SINGLE_INSTANCE: "0"`. The trade-off is
real and worth stating: separate profiles mean separate cookie jars, so logins are
not shared between projects. Orphaned Chrome is reaped by **profile directory**,
matched on the `--user-data-dir` argument with a path-boundary check — so
`browser-profile` is never reaped and `browser-profile-2` is never touched by it.

### `BROWSER_LAUNCH_FAILED` — a locked profile, not necessarily a stale one

`session.create` could not start Chrome on the profile. The profile is single-writer, so
a second session cannot attach while another holds it. **Decide whether the holder is
alive before killing processes** — the error message does not distinguish the two cases:

| Lock holder | Correct action |
|---|---|
| **Orphan** — leftover Chrome with no session driving it | Kill the process tree. A separate `profile_dir` would *mask* the leak instead of fixing it. |
| **Concurrent live session** — another agent is using Kruz right now | **Pass a separate `profile_dir`.** Killing the tree destroys real work, and that session's cookies and logins live in that profile. |

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'Kruz\\browser-profile' } |
  Select-Object ProcessId, ParentProcessId
```

A third cause is `session.close({ graceful: false })`, which used to close only the
active tab and leave Chrome holding the lock — so the next `session.create` failed
against a profile Kruz itself had orphaned. A hard close now terminates the browser
process, so this case no longer arises from Kruz; `graceful: true` is still preferable
because it preserves unsaved browser state.

### Timeouts
25 s for most tools, 55 s for navigation-class tools (`session.create`, `page.open`, `page.reload`, `page.iCIMSSearch`, `ats.verifyPosting`) and for `page.screenshot`, where a full-page capture of a long storefront outlasts the default.

### Timing
Actions report their own server-side timing, so callers can spot a stall without wrapping
calls in external timestamps. Diagnostic metadata only — never a decision input.

| Tool | Fields |
|---|---|
| `page.probe` | `probe_ms` |
| `page.open` | `_timing.total_ms` (+ `lifecycle_state`, `navigate_ms`, `poll_ms`, `readiness_budget_ms`, `readiness_phase`) |
| `page.click` | `timing.total_ms`, `capture_ms`, `dispatch_ms`, `complete_ms`, `feedback_ms` + `resolve_ms`, `action_ms`, `verify_ms` |
| `page.fill` | `timing.total_ms`, `resolve_ms`, `action_ms` |
| `page.press` | `timing.total_ms`, `resolve_ms`, `action_ms`, `grace_ms` |
| `page.drag` | `timing.total_ms`, `resolve_ms`, `action_ms`, `verify_ms` |
| `page.clickAt` | `timing.total_ms`, `hit_test_ms`, `action_ms` |
| `page.scroll` | `timing.total_ms`, `action_ms` |
| `page.observe` | `timing.total_ms`, `generate_ms` |
| `page.handleOverlays` | `timing.total_ms`, `discovery_ms`, `dismissal_ms` |

---

## Human-in-the-loop

- A **top-left banner** always shows what Kruz is doing: blue `Controlled by Kruz` while a tool call is in flight (plus a ~650 ms tail), amber `Model is thinking` between calls, and clear `Input needed on Browser/TUI` when a human is expected — automatically after 20 s of quiet, or immediately on `session.pause` / `human.takeover`.
- A **visible cursor** tracks every click and hover while blue, so you can see exactly where the model is acting.
- Page input is locked **only** while the banner is blue; in the amber and clear states the page is fully interactive again.
- **`session.pause`** (or **`human.takeover`**) releases the lock and stands down for manual login/CAPTCHA/2FA; **`session.resume`** hands control back. Both report the state they set as `overlay: {mode, banner}`.
- There is no automatic takeover button — pausing is model/client initiated and explicit.

---

## Performance

Two flat costs dominated the original experience, and both are removed.

### Navigation (the big one)

`page.open` reported content as ready in ~7 ms but still cost **~20.2 s**, because the
readiness guard awaited the navigation *lifecycle event* — `engine.navigate` capped at
20 000 ms — instead of the content poll that had already answered. Readiness has always
been content-based, so the lifecycle event was never needed to decide anything.

The guard now polls content while the navigation settles in the background and returns
as soon as the page is usable, and the leftover cleanup race dropped from 1500 ms to
250 ms. Measured wall time on the reference storefront (`dump/speed-verify.mjs`):

| Target | Before | After |
|---|---|---|
| `makerbazar.in` | ~20 200 ms | 1 300–2 500 ms |
| `makerbazar.in/collections/…` | ~20 200 ms | 1 400–2 500 ms |
| `example.com` | ~20 200 ms | 600–900 ms |

**≈ 11–15× faster**, and no navigation now pays the lifecycle cap at all. The residual
is genuine render time, not waiting.

### Per-action floor

`scrollHandleIntoView` slept 100 ms *before* its first stability comparison, so no
click, fill or press could ever return sooner than 100 ms — charged on every action,
including pages with no layout shift at all. The first probe is now after one frame
(16 ms); only a rect that actually *moved* pays the full 100 ms to wait it out.

Measured effect on a warm click (`dump/click-bench.mjs`): scroll step 127 ms → 47 ms,
whole call 431 ms → 263 ms.

### Where click time still goes

`page.click` now reports its own split, which is the honest picture for a heavy
storefront:

| Phase | What it is | Typical |
|---|---|---|
| `capture_ms` | pre-click page snapshot | 10–80 ms |
| `resolve_ms` | ref → live node + identity refresh | 80–800 ms (page-dependent) |
| `action_ms` | visibility, scroll-settle, trusted dispatch | 80–1160 ms |
| `complete_ms` | postcondition discovery window (≤1500 ms) | 150–1550 ms |
| `feedback_ms` | post-action `state` | 2–10 ms |

`resolve_ms` and `action_ms` vary with how busy the page's main thread is — a heavy
Shopify homepage makes CDP evaluates queue — so they are measured per call rather than
assumed. `complete_ms` is deliberately bounded: it is the verification that makes
`verified: true` mean something, and shortening the discovery window trades correctness
for latency.

---

## Configuration

Environment variables always override `config.json` (project root). Values are
validated: an unrecognised `LOG_LEVEL` or `SAFETY_POLICY` falls back to its
default instead of silently becoming an invalid value, and a non-numeric
`BROWSER_TIMEOUT_MS` falls back to `30000` rather than becoming `NaN` (which
would quietly disable every timeout downstream).

| Variable | Default | Description |
|---|---|---|
| `BROWSER_PATH` | Auto-detected | Browser executable. Auto-detection derives every candidate path from `PROGRAMFILES`, `PROGRAMFILES(X86)`, `LOCALAPPDATA` and `PROGRAMW6432` — **no drive letter is assumed** — then falls back to the `App Paths` registry key, so a relocated or per-user install is still found. Chromium, Edge and Brave are accepted alongside Chrome. |
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

```jsonc
{
  // Optional — leave browserPath out entirely to use auto-detection.
  "browserPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "headless": false,
  "viewportWidth": 1280,
  "viewportHeight": 720,
  "safetyPolicy": "off"
}
```

### Running without a writable install directory

`browser-profile` and `downloads` default to directories beside the project. When
that location is **not writable** — a global npm prefix under `%APPDATA%\npm`, a
copy inside Program Files, a read-only container image — those two defaults are
relocated automatically to a per-user location (`%LOCALAPPDATA%\kruz\…` on
Windows, `~/Library/Application Support/kruz/…` on macOS,
`$XDG_STATE_HOME/kruz/…` on Linux) instead of failing at `session.create`.
Setting either variable explicitly always wins.

### Running two projects at once

The Chrome profile is single-writer, so each project needs its own profile **and**
its own instance slot:

```jsonc
{
  "mcp": {
    "servers": {
      "kruz": {
        "type": "local",
        "command": ["node", "dist/index.js"],
        "cwd": ".",
        "environment": {
          "BROWSER_PROFILE_DIR": "./browser-profile/<project-name>",
          "KRUZ_SINGLE_INSTANCE": "0"
        }
      }
    }
  }
}
```

The trade-off is real: separate profiles mean separate cookie jars, so logins are
not shared between projects.

---

## Architecture

```
                 MCP client (LLM agent)
                        │  JSON-RPC over stdio
                        ▼
  src/index.ts  (entry, signals, global error handlers)
      └─ createServer()  src/mcp/server.ts  ── 53 tools + 4 resources
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
| `src/config.ts` | Env + `config.json` resolution; project-root discovery; browser auto-detection |
| `scripts/write-opencode-config.mjs` | Generates the OpenCode `mcp.servers.kruz` entry on build |
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

## Portability

Kruz is designed to run from a clone anywhere on any Windows machine (and on
macOS/Linux) without editing a single path.

**Nothing in the source encodes a location.** The rules that keep it that way:

- **The project root is discovered, not assumed.** It is found by walking up from
  the running module to the nearest `package.json`, so `src/`, `dist/`, a bundler
  output, or a future nested layout all resolve to the same root. Previously it
  was hardcoded to "one level above this file", which happened to be correct only
  because of the current layout.
- **Browser detection is environment-derived.** Every Windows candidate is built
  from `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PROGRAMW6432` and `LOCALAPPDATA`.
  There is no `C:` literal anywhere, so a machine whose system drive is `D:`, or
  whose Chrome is installed per-user, is detected correctly. The registry
  `App Paths` key is consulted next, which covers a relocated custom install that
  no well-known-path list can reach.
- **Unwritable installs relocate rather than crash.** Profile and download
  directories fall back to a per-user location when the install directory is
  read-only.
- **Path comparisons respect separators.** "Is this path inside our directory?"
  is answered with a separator-boundary test, not a string `startsWith`. A plain
  prefix test matches `D:\Kruz-tools` when the root is `D:\Kruz`, which
  misidentifies unrelated processes as Kruz servers and can get them killed.
- **Paths containing spaces work everywhere.** Module URLs are converted with
  `fileURLToPath`, never `URL.pathname` — the latter is percent-encoded, so a
  checkout under `D:\project prototypes\…` resolved to a path containing
  `%20` and pointed at a file that did not exist.

To move a checkout: copy it anywhere, run `npm install && npm run build`. The
OpenCode registration is rewritten for the new location automatically.

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

> **Not every working copy carries `tests/`.** `tests/` is not part of the published
> package, so a fresh install legitimately has none — `npm test` then exits **0**
> with "No test files found". That is deliberate: an absent suite and a *failing*
> suite must not look alike, and a non-zero exit for a missing suite reads as a
> broken build in CI. `vitest.config.ts` sets `passWithNoTests` for exactly this
> reason. For ad-hoc verification against the built output without a suite, a
> scratch harness can drive the router directly — import `dist/mcp/server.js` (not
> `dist/index.js`, which binds stdio on import) and call `router.route(tool, args)`.
> `dump/` is the conventional home for one.

### Standing harnesses in `dump/`

Each drives the built `dist` end-to-end and exits non-zero on failure:

| Harness | Guards |
|---|---|
| `ref-verify` | ref resolution tier 1, same-href capture, viewport reconciliation |
| `def5-verify` | reported viewport == measured viewport |
| `errorlog-verify` | `FILL_NOT_RETAINED`, screenshot device/CSS scale metadata |
| `overlay-verify` | heartbeat/watchdog control loop (no darkening mid-call) |
| `overlay-states-verify` | the three banner states, top-left position, automatic transitions (`21/21`) |
| `fill-verify` | fill recovery ladder, error taxonomy retryability |
| `speed-verify` | no navigation pays a lifecycle cap; readiness honours its own declared budget (live wall clock reported, **not** asserted — a threshold on a live site tests the network, not Kruz) |
| `readiness-verify` | the readiness budget is ONE real wall clock: a never-committing page costs the budget once (not twice, not 20x), every probe is clamped to the time remaining, and the answer is `PAGE_NOT_READY` rather than `ACTION_TIMEOUT`/`outcome:"unknown"` (`15/15`, local fixture, deterministic) |
| `input-verify` | drag (targets, coords, steps, html5+payload, no-op honesty), modifier release, `uploadFile`, viewport pinning/drift, post-click navigation truth, CDP-attach contract (`54/54`) |
| `netcap-verify` | `network.capture` actually truncates large bodies at 200 KB + honest `truncated` flag; the buffer survives a 600-request burst (`6/6`) |
| `schema-verify` | the **input-schema layer**: `{x,y}`/ref/css/role+name drag endpoints survive validation, malformed ones are rejected, plus a sweep of all 53 tools / 167 argument slots for silently-stripped arguments (`36/36`) |
| `call-bench` / `click-bench` | latency benchmarks (report, do not assert) |
| `google-research` | drives Kruz's own browser to gather multi-source evidence (Google, with DuckDuckGo/Bing fallbacks for consent walls) before choosing a fix |
| `mcp-server-verify` | the **real protocol**: spawns `node dist/index.js` exactly as the host does and speaks JSON-RPC over stdio — handshake, 53 tools, bad input, clean shutdown, and **stdout purity** (one stray `console.log` corrupts the stream and the host drops the connection). Also measures whether two sessions can share one profile dir (`13/13`) |
| `single-instance-verify` | ownership-record safety: a recycled pid naming an unrelated process is never signalled, takeover terminates only a *recorded* predecessor, an *unrecorded* live peer is left alone, start-time mismatch is caught, and a clean exit leaves no record (`13/13`) |
| `coldstart-verify` | **the startup bug**: launches **three** servers in the same instant (what a cold start really does), and asserts all three answer `initialize`, all three list 53 tools, and none prints `terminating live Kruz server` — the exact error `/mcp` reported. Fails 7/16 with the old newest-wins logic, verified (`16/16`) |
| `host-config-verify` | the **deployed** config: reads the real `~/.config/opencode/opencode.jsonc`, spawns the `Kruz` entry verbatim (command, cwd, env) and serves JSON-RPC; forces the takeover path with a seeded lockfile so `KRUZ_TAKEOVER=1` is verified rather than assumed (`10/10`) |

> **⚠ These harnesses own the single-instance slot.** `host-config-verify`,
> `mcp-server-verify` and `single-instance-verify` spawn *real* `node dist/index.js`
> servers. They no longer kill a peer, but they do write and release the ownership
> record, so running them can briefly change who reaps orphaned Chrome. `coldstart-verify`
> spawns three at once by design. Run them when you do not mind a reconnect, and
> restart OpenCode afterwards if the MCP list shows Kruz as errored.

> `overlay-states-verify` takes ~35 s: 20 s of it is the real `awaiting` auto-promotion window, which cannot be shortened without testing a different constant.

> **`router.route(name, args)` does not run zod.** A harness that drives the router directly exercises the controller and engine but skips input validation entirely — which is how `page.drag`'s `{x,y}` endpoints passed 54/54 checks while being unusable for every real client (the schema stripped them). Anything about *argument shape* must be tested against `server._registeredTools[name].inputSchema`, as `schema-verify` does; anything about *browser behaviour* is fine on the router.

---

## Changes

### 1.7.2 — Portability and correctness fixes (2026-10-12)

**Portability: no hardcoded paths anywhere**

- **Project root is discovered, not assumed.** Walks up from the running module to the nearest `package.json` instead of hardcoding "one level above `src/config.ts`". Works from `dist/`, a nested install, or any future layout.
- **Browser auto-detection is environment-derived.** Every Windows candidate is built from `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PROGRAMW6432` and `LOCALAPPDATA`. No drive letter is assumed. The `App Paths` registry key is consulted next, which covers a relocated custom install that no well-known-path list can reach. Chromium, Edge and Brave are accepted alongside Chrome.
- **Unwritable installs relocate rather than crash.** When the project root is read-only (global npm prefix, Program Files copy, container image), `browser-profile` and `downloads` fall back to a per-user location (`%LOCALAPPDATA%\kruz\…` on Windows, `~/Library/Application Support/kruz/…` on macOS, `$XDG_STATE_HOME/kruz/…` on Linux) instead of failing at `session.create`.
- **Path comparisons respect separators.** "Is this path inside ours?" is now answered with a boundary check (`a === root || a.startsWith(root + "\\")`) rather than a string `startsWith`. A plain prefix test matched `D:\Kruz-tools` when the root was `D:\Kruz`, which misidentified unrelated Node processes as Kruz servers.
- **Path names with spaces work everywhere.** Module URLs are converted with `fileURLToPath` (which decodes `%20`), never `URL.pathname` (which leaves it encoded). A checkout under `D:\project prototypes\Kruz` previously resolved to a path containing `%20` that did not exist.

**OpenCode registration is generated, never committed**

- `npm run build` now runs `scripts/write-opencode-config.mjs` to write a project-local `opencode.json` containing `mcp.servers.kruz` with `command[0]` set to `process.execPath` (the absolute node binary path) and `cwd` set to the install root. Both are discovered at build time.
- The generated file is gitignored — it contains another developer's absolute paths if committed. Re-running `npm run build` after moving or renaming the checkout rewrites it correctly.
- A V1/V2 dialect detector preserves your existing file shape. It will not write a hybrid config where some servers connect and others are silently ignored.
- `--global` / `KRUZ_OPENCODE_SCOPE=global` opt in to writing the user-wide config; the default is project-local and never touches your personal settings.
- The build refuses to write anything when `dist/index.js` does not exist or the existing config file cannot be parsed.

**Configuration is now validated, not cast**

- `SAFETY_POLICY`, `LOG_LEVEL` and other enum fields are now coerced to their valid set. A typo like `SAFETY_POLICY=Strict` fell back to `"off"` instead of being silently accepted as a value the safety layer could not match (which treated *every* action as safe).
- `BROWSER_TIMEOUT_MS=abc` falls back to `30000` instead of becoming `NaN`, which previously disabled every timeout in the process.

**Bugs fixed**

| Bug | Severity | Impact |
|---|---|---|
| `kruz://skill` resource path built from `URL.pathname` | high | Path contained `%20` on repos with spaces; resource read rejected. Agent received no skill contract. |
| Heartbeat re-armed forever via `idleReleaseTimer` (never assigned) | high | Overlay stayed blue permanently; page input locked while the model was idle. |
| Click feedback diffed against a click-completion snapshot | medium | `state.navigation` reported `"completed"` on every click, contradicting `result.navigation`. |
| `shapeError` dropped `cause` and `operation` from envelopes | medium | Call-site provenance lost on all structured errors. |
| `single-instance` path-prefix test without separator boundary | high | Matched sibling dirs like `D:\Kruz-tools`; could kill unrelated Node processes. |
| Chrome reaping matched profile dir by substring | high | `browser-profile-2` was killed when the owner was `browser-profile` — the exact layout the docs recommend. |
| `detectHumanNeeded` called Playwright `.locator()` on Puppeteer pages | medium | CAPTCHA / password / 2FA detection returned `{needed:false}` unconditionally. |
| `page.uncheck` clicked unconditionally (toggled instead of setting) | medium | Unchecking an already-off checkbox checked it. |
| `session.attach()` leaked the previous browser session | medium | Next `session.create` failed with `BROWSER_LAUNCH_FAILED` against a profile the old session still held. |
| `queryOneInFrame` / `queryAllInFrame` used handle formats `resolveHandle` could not parse | high | iCIMS iframe job links silently returned zero results. |
| `dblclick`, `dragPointer` never opened the model-dispatch window | medium | Actions cancelled by the in-page control lock while overlay was blue. |
| `viewportPoint` used `&&` instead of `||` for collapsed-element check | low | A 0×40px element returned a point on its left edge instead of being rejected. |
| `press` fell through to `keyboardPress` when element resolved to null | medium | Key combo typed into whatever happened to hold focus. |
| `countElements` leaked probe handles for the life of the document | medium | Remote-object accumulation on heavy pages. |
| `queryOnePiercing` started its shadow walk at `document` (nodeType 9) | medium | Shadow-piercing silently degraded to plain query on every call. |
| `document-start-injection` capability reported `false` despite being true | low | Capability gates were told the opposite of what the engine actually does. |
| `Notification.permission` leak returned `'default'` (invalid PermissionState) | low | Pages checking `status.state === 'prompt'` saw an invalid enum and took a bot-detection branch. |
| Closed sessions never removed from the manager map | medium | Unbounded retention of observer caches and ref registries over a long session. |
| Attach session built a 2-field `P1Config` literal cast | low | `server.info` reported `undefined` viewport and locale; observer cache defaulted to 1000 instead of the configured size. |

**Test harnesses**

- Added `npm run register` and `npm run register:global` for manual config regeneration.
- `npm test` now exits `0` when the `tests/` directory is absent (not part of the published package), so a missing suite and a failing suite are distinguishable in CI.
- `tests/unit/readiness-freshness.test.ts` restored (deleted from the working tree before this session). 7/7 passing.

---

- **Google-account sign-in is not supported.** Google classifies a Puppeteer-*launched* Chrome as automation and rejects sign-in with *"This browser or app may not be secure"*, **even when a human types the credentials by hand** during `session.pause`. The check is transport-level, not page-visible: `navigator.webdriver` is masked, `window.chrome.runtime` is present, plugin counts look normal, and it still rejects. Use `session.create {cdp_url}` to attach to a real daily-driver Chrome, or point `profile_dir` at a copy of a profile that already carries the Google session. See SKILL.md → *Known unsupported flow*.
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