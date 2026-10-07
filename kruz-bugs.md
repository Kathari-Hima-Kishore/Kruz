# Kruz bug log

Defects found by driving a real task (tracing a Cognizant GenC apply link from a
freshersdunia.in blog post through to Cognizant's own systems), 2026-10-03.
Session: headed Chrome, viewport 1536x730.

All four were found in the same session and all four produced a *confident wrong
answer* or a *timeout for work that had already succeeded* — the two failure
modes that cost a model the most, because nothing in the response looks wrong.

---

## BUG-1 · `page.open` reported readiness for the page it was leaving

**Severity:** high — silently wrong
**Fixed:** `src/browser/controller.ts` (`isNewDocument`, `snapshotPage`,
`pollForContent`, `capturePreNav`), `tests/unit/readiness-freshness.test.ts`

### Symptom

```json
{ "url": "https://freshersdunia.in/cognizant-genc-off-campus-recruitment-2026/",
  "title": "Cognizant GenC Off Campus Recruitment 2026 ...",
  "_ready": true, "_waited_ms": 6, "body_length": 10111 }
```

...returned by `page.open("https://careers.cognizant.com/india-en/pathways-to-cognizant/genc-program/")`.

### Cause

`pollForContent` races `page.goto` by design (a lifecycle wait alone deadlocks on
portals that never fire `load`). The readiness poll therefore *routinely wins* and
snapshots the outgoing document — which is normally a full, meaningful page.

`snapshotPage(engine, targetUrl)` accepted a `targetUrl` and **never used it**.
Its own comment claimed otherwise:

> `snapshotPage` verifies the target host, so polling cannot be satisfied by the
> page we are leaving.

No host check existed. The outgoing blog post had 10 111 chars, so the very first
poll declared victory in 6ms and reported `_ready: true` for a navigation that
had not committed.

### Fix

Gate readiness on the document having actually **changed**, using
`performance.timeOrigin` — already Kruz's document identity everywhere else
(`router.stateOf`, `click-completion`, the ref registry's `docIdCache`), so no
new concept was introduced. A fresh Document always has a fresh `timeOrigin`,
including on a same-URL reload, which a URL comparison cannot see.

The URL remains a fallback for pages without `timeOrigin`, and is deliberately
permissive about host changes — a shortener, an SSO bounce or a country redirect
really is a new document and really can be ready.

Two ordering details that matter:

- The not-committed check runs **before** the thin-page shortcuts. The outgoing
  document is meaningful, so `thin === false` would otherwise return
  `loaded: false` on the first poll and report a slow page as never-ready.
- The mutation tracker is only consulted once `fresh` — it belongs to the
  outgoing document and its verdict says nothing about the page being waited for.

`PAGE_NOT_READY` now distinguishes "committed but empty" from "never committed",
and `_pre_nav_url` is returned when the poll ended on the old document.

### Residual limitation

If the pre-navigation `timeOrigin` capture fails, the URL fallback applies, and a
same-URL navigation is judged by content alone. Conservative (it errs toward
waiting), never a false `_ready: true`.

---

## BUG-2 · `page.switchTab` hung; unbounded CDP calls

**Severity:** high — false failure on success
**Fixed:** `src/browser/engines/puppeteer-engine.ts` (`setInterception`,
`switchTab`, `newTab`)

### Symptom

`page.switchTab` → `ACTION_TIMEOUT ... exceeded 25000ms`, twice, 2 for 2.
`page.listTabs` immediately afterwards showed the switch had **succeeded**
(`tab-1` active) both times.

### Cause

Two unbounded CDP awaits, both wrapped in `.catch(() => {})` — which handles a
rejection and does nothing about a **hang**:

```ts
if (this._networkEnabled) await p.setRequestInterception(true).catch(() => {});   // line 499
await p.bringToFront().catch(() => {});                                          // line 500
```

`setRequestInterception` does not settle until every already-in-flight
intercepted request has been handled. `bringToFront` was already bounded to 1500ms
in the engine's own `bringToFront()` (with a comment explaining exactly this
hazard) — but `switchTab` called `page.bringToFront()` directly and skipped it.

### Fix

New `setInterception(p, on, budgetMs = 2000)`: skips the call when the page is
already in the requested state, and bounds it otherwise. `switchTab` clears the
bookkeeping flag per-tab (a newly-activated tab has never had it applied) and its
focus ping is now bounded like everywhere else. `newTab`'s `bringToFront` too.

Also fixed a logic error there: `switchTab` keyed interception off
`_networkEnabled` and always passed `true`, so body capture being *on* was not
what decided interception — defeating the "only pay the per-request CDP
round-trip when bodies are wanted" rule in `enableNetworkCapture`. Now keyed off
`_captureBodies`.

---

## BUG-3 · `page.open` never navigated on heavy pages

**Severity:** high — total tool failure
**Fixed:** `src/browser/engines/puppeteer-engine.ts` (`setInterception`)

### Symptom

`page.open("https://careers.cognizant.com/india-en/talent-community/")` →
`ACTION_TIMEOUT ... exceeded 55000ms`, `outcome: "unknown"`, twice. The same site
loaded fine with `wait_for: "commit"`, which returned in 570ms.

### Cause

`controller.open()` awaits `this.listen(engine)` *before* issuing the navigation.
`listen` → `enableNetworkCapture` → `page.setRequestInterception(false)`.

So every `page.open` re-issued that toggle on a page firing dozens of requests —
and on a busy page it blocks until they drain, or never answers. Either way the
navigation was never even started, which is why the failure was total and why
`outcome: "unknown"` was honest but unhelpful. `wait_for: "commit"` "worked" only
because it skipped the readiness poll and got lucky on ordering.

This is the same underlying call as BUG-2, reached from a different site — which
is why one fix covers both.

### Fix

`setInterception`. On a normal run capture is off, so the redundant
"install false" is now a no-op and `listen()` costs nothing. A genuine state
change is bounded at 2s and degrades to "interception unavailable"
(`network.body` returns nothing, which the caller can see and retry) rather than
wedging the route.

The flag is set *before* the await so concurrent callers dedupe. That makes it
optimistic — on timeout we believe interception is on when it may not be. Chosen
deliberately: the alternative (retrying) is the hang.

---

## BUG-4 · Response `page_id` could name a tab the action never touched

**Severity:** medium — wrong-but-plausible metadata
**Fixed:** `src/mcp/router.ts` (`refreshPageId`, `tabOp`, both catch paths)

### Symptom

`page.switchTab` timed out (BUG-2) reporting `page_id: "tab-2"` while the engine
had already moved to `tab-1`.

### Cause

`diagnostics()` serves `page_id` from `pageIdCache` — a deliberate optimisation,
since it rides on every response. The cache was refreshed only on the **success**
path of `tabOp`:

```ts
const r = await fn();
await this.refreshPageId();   // never runs if fn() throws or hangs
return r;
```

`switchTab` assigns `_page` *before* its focus ping, so the engine had already
switched when the hang occurred — and the response naming the old tab was exactly
the response that most needed the new one. The route-timeout path never refreshed
at all.

### Fix

`tabOp` refreshes in a `finally`, so the cache tracks the engine even when the
call fails. Both catch paths in `route()` (timeout and shaped error) refresh
before stamping diagnostics.

`refreshPageId` is now bounded at 1.5s: it runs on failure paths, where the
browser may be exactly the thing that is stuck, and an unbounded `listTabs()`
would trade a reported timeout for a hung route.

---

## Verification

- `npm run typecheck` — clean
- `npm test` — 7/7 passing (`tests/unit/readiness-freshness.test.ts`, new)
- `npm run build` — clean

Note: `tests/` did not exist before this session, so `npm test` previously exited 1
with "No test files found" despite `package.json` wiring `test` to `vitest run`.
The suite is now real but small — BUG-2/3/4 are CDP-level and want integration
tests against a live browser, which this session did not have time to write.

Fixes are in the source and built to `dist/`, but **the running MCP server
(pin 16904) predates them** — a rebuild does not retroactively change a loaded
process. Restart the server to pick them up.