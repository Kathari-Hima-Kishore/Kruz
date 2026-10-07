import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getProjectRoot } from "./config.js";

/**
 * Single-instance guard (kruz-bugs.md #6).
 *
 * Purpose: keep the browser-profile lock sane across host restarts. Every host
 * restart spawns a fresh `node dist/index.js`; an orphaned previous server leaves a
 * Chrome alive that still holds the profile, which makes the new server's
 * session.create fail with BROWSER_LAUNCH_FAILED. A record file names the current
 * OWNER — the one process allowed to reap orphaned Chrome.
 *
 * Three rules, each bought with a real incident:
 *
 *  1. NEVER SIGNAL AN UNVERIFIED PID. The record holds a pid, and Windows recycles
 *     pids, so a record surviving a crash can later name an unrelated program.
 *     Verified identity (command line + OS start time) is required first, and an
 *     unreadable identity means do-not-kill. Proven: a plain `node -e` process
 *     recorded as the predecessor was SIGKILLed by this code.
 *
 *  2. NEVER KILL A LIVE SERVER BY DEFAULT. This one is the STARTUP BUG. OpenCode
 *     restores every workspace at once, so a cold start spawns one Kruz per project
 *     at the same instant. Under "newest wins" each spawn terminated the previous
 *     one, and the killed spawns exited with code 1 — reported by the host verbatim
 *     as `MCP server process exited with code 1: [kruz] single-instance:
 *     KRUZ_TAKEOVER=1 — terminating live Kruz server pid=...`. That is exactly the
 *     error a manual /mcp retry appeared to fix. A newcomer now leaves a live owner
 *     alone and serves MCP alongside it.
 *
 *  3. ONE BROWSER OWNER. Coexisting servers do not fight: the single-writer Chrome
 *     profile is still enforced at session.create, and orphaned Chrome is reaped
 *     only by a NEW owner (no record, or a record naming a dead/recycled pid, or
 *     after an explicit takeover). A returning owner re-asserts its record and is
 *     never a kill candidate — so a host retry can never kill the server it just
 *     started.
 *
 * KRUZ_TAKEOVER=1 restores the destructive newest-wins behaviour, for anyone who
 * prefers one process and accepts the cold-start error that necessarily comes with
 * it. KRUZ_SINGLE_INSTANCE=0 disables the guard entirely (pair it with a distinct
 * profile_dir for genuinely concurrent instances).
 */

const LOCK_NAME = ".kruz-server.lock";

function lockPath(): string {
  return resolve(getProjectRoot(), LOCK_NAME);
}

function err(msg: string): void {
  process.stderr.write(`[kruz] single-instance: ${msg}\n`);
}

/** True when the pid exists (EPERM counts as alive — it exists, we just can't signal it). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function waitForExit(pid: number, timeoutMs: number): void {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!isAlive(pid)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/** Best-effort list of [pid, commandLine]; failures return []. */
function listProcesses(): Array<{ pid: number; cmd: string }> {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const arr = JSON.parse(out);
      return (Array.isArray(arr) ? arr : [arr])
        .filter((p: any) => p?.ProcessId)
        .map((p: any) => ({ pid: Number(p.ProcessId), cmd: String(p.CommandLine ?? "") }));
    }
    const out = execFileSync("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf(" ");
      return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
    }).filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/**
 * Does this command line look like one of OUR server processes?
 *
 * A single regex was wrong here and shipped broken. It required a path separator
 * immediately after the executable, so `node dist/index.js` did NOT match — and
 * that is EXACTLY how the host launches Kruz (`"command": ["node","dist/index.js"]`
 * with `cwd` set to the install dir). The scan was therefore blind to every real
 * server, and it only ever "passed" against test decoys that used an absolute path
 * containing "kruz". Expressed as conditions instead of one pattern so each reason
 * is explicit and testable.
 *
 * Must be BOTH: a node process, AND running our entrypoint (absolute or relative)
 * or something named kruz. That combination is what keeps an unrelated
 * `node -e ...` process safe — see single-instance-verify case #1.
 */
function looksLikeKruzServerCmd(cmd: string): boolean {
  const raw = String(cmd ?? "").trim();
  // `[\s"\\/]` before `node`, not `(^|\s)`: a fully-qualified executable is
  // `D:\...\node.exe`, where `node` is preceded by a path separator. The narrower
  // form silently failed on that shape and would have left a real server unterminated.
  if (!/(^|[\s"\\/])node(\.exe)?([\s"]|$)/i.test(raw)) return false;   // must be node

  // Then: a `dist/index.js` or `src/index.ts` argument that resolves INSIDE our own
  // install directory.
  //
  // Deliberately NOT matched on the substring "kruz". A looser `/kruz/i` fallback
  // was tried and is dangerous in both directions: it failed to match the real
  // `node dist/index.js` (no "kruz" anywhere in that cmdline) while happily matching
  // every unrelated process whose path merely passes through the install dir — it
  // killed the test runner itself. Requiring the resolved path to be under our root
  // matches the real server exactly and nothing else. Spaces in the install path are
  // handled by reading quoted spans whole rather than splitting on whitespace.
  const root = resolve(getProjectRoot()).replace(/\//g, "\\").toLowerCase();
  const ENTRY = /(?:"([^"]*)"|'([^']*)'|([^\s"]+))/g;
  for (const m of raw.matchAll(ENTRY)) {
    const tok = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!/(?:^|[\\/])(?:dist|src)[\\/]index\.(?:js|ts)$/i.test(tok)) continue;
    const abs = /^[A-Za-z]:[\\/]/.test(tok) || tok.startsWith("\\\\")
      ? tok
      : resolve(getProjectRoot(), tok);
    if (abs.replace(/\//g, "\\").toLowerCase().startsWith(root)) return true;
  }
  return false;
}

/**
 * Read identity (command line + OS start time) for ONE pid.
 *
 * Deliberately queries a single pid instead of reusing `listProcesses()`, which
 * enumerates every process on the machine: this runs on the startup critical path,
 * before the MCP handshake is answered.
 */
function processIdentity(pid: number): { cmd: string; startedAt: string } | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command",
          // CreationDate is formatted to a STRING deliberately. `ConvertTo-Json`
          // renders a DateTime as `/Date(1791292107016)/`, which no amount of
          // WMI-shaped parsing can read — measured here, and it silently disabled
          // the start-time check below until this was fixed.
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ ProcessId=$p.ProcessId; CommandLine=$p.CommandLine; CreationDate=$p.CreationDate.ToString('yyyyMMddHHmmss.ffffffzzz') } | ConvertTo-Json -Compress }`],
        { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const arr = JSON.parse(out);
      const rec = Array.isArray(arr) ? arr[0] : arr;
      if (!rec || !rec.ProcessId) return null;
      return { cmd: String(rec.CommandLine ?? ""), startedAt: String(rec.CreationDate ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a WMI/CIM `CreationDate` (`20261006130046.123456+060`) to epoch ms.
 * Returns null when the format is unrecognised, so the caller can skip that check
 * rather than guess. The offset is local-minus-UTC, so it is SUBTRACTED.
 */
function parseWmiDate(s: string): number | null {
  // PowerShell's ConvertTo-Json renders a DateTime as `/Date(1791292107016)/`.
  // That value is already epoch-ms UTC, so return it directly.
  const dotNet = /^\/Date\((-?\d+)/.exec(s);
  if (dotNet) return +dotNet[1];
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // The offset is local-minus-UTC, so it is SUBTRACTED. It appears both as
  // `+0530` and as `+05:30` depending on how it was produced — accept either.
  const tz = /([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (tz) {
    const sign = tz[1] === "-" ? -1 : 1;
    ms -= sign * ((+tz[2]) * 60 + +tz[3]) * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

/**
 * May we signal this pid?
 *
 * The lockfile records ONLY a pid, and Windows recycles pids aggressively, so a
 * lockfile left behind by any crash — and it survives crashes, since only a clean
 * exit removes it — can days later name a completely unrelated program.
 * `claimSingleInstance` used to answer "is it alive?" and then SIGTERM/SIGKILL
 * whatever it found. Proven: a plain `node -e` process recorded as the
 * predecessor was killed on the next startup. That is how Kruz ends up killing an
 * editor, a terminal, or another tool, intermittently, depending on pid reuse.
 *
 * Two independent checks, because either alone has a hole:
 *  1. the command line must actually look like a Kruz server — catches pid reuse;
 *  2. when the OS start time is readable, it must match the `startedAt` already in
 *     the lockfile — catches reuse onto *another node process*.
 *
 * Fails SAFE: if identity cannot be read, we do not kill. Refusing to reap a stale
 * lock is harmless (it is overwritten on the next line); killing a stranger is not.
 */
function maySignalPredecessor(pid: number, recordedStartedAt?: string): { ok: boolean; why: string } {
  const id = processIdentity(pid);
  if (!id) {
    return { ok: false, why: "could not read process identity — refusing to signal an unverified pid" };
  }
  if (!looksLikeKruzServerCmd(id.cmd)) {
    return { ok: false, why: `pid=${pid} is not a kruz server (pid was recycled): ${id.cmd.slice(0, 90)}` };
  }
  if (recordedStartedAt && id.startedAt) {
    const osStart = parseWmiDate(id.startedAt);
    const claimedStart = Date.parse(recordedStartedAt);
    // Generous tolerance: `startedAt` is stamped when the lock is claimed, which
    // is a moment or two after the OS started the process.
    if (osStart !== null && Number.isFinite(claimedStart) && Math.abs(osStart - claimedStart) > 60_000) {
      return { ok: false, why: `pid=${pid} is a kruz server but started ${new Date(osStart).toISOString()}, not ${recordedStartedAt} — recycled` };
    }
  }
  return { ok: true, why: "" };
}

function killPid(pid: number): boolean {
  if (pid === process.pid) return false;
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, sig);
      waitForExit(pid, 2500);
      if (!isAlive(pid)) return true;
    } catch { /* ESRCH (already gone) or EPERM — fall through */ }
    if (!isAlive(pid)) return true;
  }
  return !isAlive(pid);
}

/**
 * Resolve the browser profile dir the same way loadConfig() does, without
 * pulling the whole config (the guard runs before anything else).
 */
function resolveProfileDir(): string | null {
  try {
    let fileProfile: string | undefined;
    const configPath = resolve(getProjectRoot(), "config.json");
    if (existsSync(configPath)) {
      try {
        fileProfile = JSON.parse(readFileSync(configPath, "utf-8"))?.profileDir;
      } catch { /* ignore */ }
    }
    const raw = process.env.BROWSER_PROFILE_DIR || fileProfile || "./browser-profile";
    return resolve(getProjectRoot(), raw);
  } catch {
    return null;
  }
}

/**
 * Kill chrome.exe processes launched under our profile dir. Called only when
 * (a) the recorded predecessor is confirmed dead AND (b) no other live Kruz
 * server process exists — so any holder found here is an orphan by
 * construction (see MODEL_GUIDE.md "BROWSER_LAUNCH_FAILED": never kill a
 * holder that may back a concurrent live session).
 */
function reapOrphanedChrome(procs: Array<{ pid: number; cmd: string }>): number {
  const profileDir = resolveProfileDir();
  if (!profileDir) return 0;
  const norm = profileDir.replace(/\//g, "\\").toLowerCase();
  let reaped = 0;
  for (const p of procs) {
    const cmd = p.cmd.replace(/\//g, "\\").toLowerCase();
    if (!cmd.includes("chrome") || !cmd.includes(norm)) continue;
    if (killPid(p.pid)) reaped++;
    else err(`could not reap orphaned chrome pid=${p.pid}; profile lock may persist`);
  }
  return reaped;
}

export function releaseSingleInstance(): void {
  try {
    const raw = existsSync(lockPath()) ? readFileSync(lockPath(), "utf-8") : "";
    if (raw && JSON.parse(raw)?.pid === process.pid) unlinkSync(lockPath());
  } catch { /* best effort */ }
}

/**
 * PIDs of live processes that look like a Kruz server (not this process), ASCENDING.
 *
 * Ascending order makes the oldest live server the deterministic owner when several
 * cold-start spawns race on an unwritten record: every racer sees the same list and
 * computes the same winner, instead of each believing itself to be the newest.
 */
function findKruzServers(procs: Array<{ pid: number; cmd: string }>): number[] {
  const out: number[] = [];
  for (const p of procs) {
    if (p.pid === process.pid) continue;
    // Same predicate as maySignalPredecessor, deliberately: one definition, so
    // "is this a Kruz server?" can never mean two different things.
    if (looksLikeKruzServerCmd(p.cmd)) out.push(p.pid);
  }
  return out.sort((a, b) => a - b);
}

/** Read the owner record (`{pid, startedAt}`), or null when absent/unreadable. */
function readRecord(path: string): { pid: number; startedAt?: string } | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && Number.isFinite(Number(parsed.pid))) {
      return { pid: Number(parsed.pid), startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined };
    }
  } catch { /* unreadable — treated as absent */ }
  return null;
}

/**
 * Take over the single-instance record.
 *
 * Called from `main()` on the startup critical path, so the machine-wide process
 * scan must happen exactly once (it is ~1s with PowerShell CIM). The scan is also
 * how the STARTUP BUG was fixed: a newcomer must not kill a live server, because on
 * a simultaneous cold start every spawn would be killing another spawn and the
 * survivors' killers report as `exited with code 1` in /mcp.
 */
export async function claimSingleInstance(): Promise<void> {
  if (process.env.KRUZ_SINGLE_INSTANCE === "0") {
    err("disabled via KRUZ_SINGLE_INSTANCE=0");
    return;
  }
  const takeoverAllowed = process.env.KRUZ_TAKEOVER === "1";
  const path = lockPath();
  const prev = readRecord(path);

  // A record naming a DEAD pid is garbage, and removing it is always safe — no live
  // process owns it, and leaving it behind is exactly the pid-recycling hazard the
  // verification below exists to survive. Clear it up front so no branch has to
  // carry a meaningless record forward (including the coexist branch, which does not
  // write a record of its own).
  if (prev && !isAlive(prev.pid)) {
    try { unlinkSync(path); } catch { /* best effort */ }
    err(`cleared stale record (pid=${prev.pid} is dead)`);
  }

  const iAmRecorded = prev?.pid === process.pid;

  // ONE scan, reused by every decision below.
  const procs = listProcesses();
  const siblings = findKruzServers(procs);

  if (iAmRecorded) {
    // Re-assert the record and reap, never signal. This is why a manual /mcp retry
    // succeeds: the returning server owns the record, so nothing kills it.
    reapAndWrite(path, procs, "re-asserting owner record");
    return;
  }

  // Decide WHO is the live owner. The record names one process, but a lockfile is
  // written only AFTER every check and after the scan — measured as seconds with
  // PowerShell CIM on a cold CPU — so three simultaneous cold spawns can all read an
  // empty record. The oldest live server is therefore the tie-breaker; the oldest is
  // arbitrary but stable, and every server computes the same answer independently.
  const ownerFromRecord = !!(prev && isAlive(prev.pid) && maySignalPredecessor(prev.pid, prev.startedAt).ok);
  if (prev && isAlive(prev.pid) && !ownerFromRecord) {
    // The classic pid-recycling case: the record outlived its process and now names
    // an unrelated program. Say so — silently ignoring the record looked like a
    // no-op to whoever was reading the logs.
    err(`record names live pid=${prev.pid}, which is not a verified Kruz server (pid recycled); ignoring it`);
  }
  let owner = -1;
  if (ownerFromRecord) owner = prev!.pid;
  else if (siblings.length > 0) owner = siblings[0];

  if (owner !== -1 && owner !== process.pid) {
    // Takeover terminates ONLY a RECORDED predecessor. An owner merely INFERRED from
    // the process scan is never a kill target: on a simultaneous cold start no record
    // exists yet, so every spawn would name another spawn and kill it — which is the
    // startup bug the host reported verbatim as
    // `MCP server process exited with code 1: ... terminating live Kruz server pid=...`.
    if (takeoverAllowed && ownerFromRecord) {
      // Destructive newest-wins: terminate only the identified owner.
      if (killPid(owner)) {
        err(`KRUZ_TAKEOVER=1 — terminating live Kruz server pid=${owner}`);
        reapAndWrite(path, procs, "took over from predecessor");
        return;
      }
      // Would not die (EPERM / still starting). Fall through and serve beside it:
      // the shared profile lock still permits only one browser session.
      err(`could not terminate pid=${owner}; serving alongside it (the profile lock still serialises the browser)`);
    } else {
      err(`a live Kruz server owns the profile (pid=${owner}); serving MCP alongside it.`);
      err(`The browser is serialised by the Chrome profile lock; set KRUZ_TAKEOVER=1 for one process only.`);
    }
    // Coexist: do NOT write our pid. Overwriting would hide the owner from the next
    // spawn. The owner reaps; we simply serve.
    return;
  }

  // We are the owner: no live server, or the record named a dead / recycled pid.
  reapAndWrite(path, procs, owner === process.pid ? "owner" : "no live owner");
}

/**
 * Reap orphaned Chrome (only when it cannot belong to a live peer) then record
 * ourselves. The scan is passed in so the machine-wide enumeration happens once
 * per startup.
 */
function reapAndWrite(path: string, procs: Array<{ pid: number; cmd: string }>, why: string): void {
  // Reap ONLY when no other Kruz server is alive. A live peer may well be the one
  // holding the profile, and killing its Chrome would break a working session — the
  // cardinal rule since the original BROWSER_LAUNCH_FAILED investigation. If a peer
  // is alive, any holder is either that peer's (leave it) or an orphan it will reap
  // itself as owner.
  if (findKruzServers(procs).length === 0) {
    const reaped = reapOrphanedChrome(procs);
    if (reaped > 0) err(`reaped ${reaped} orphaned chrome process(es) under our profile dir`);
  }
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    err(`owning the instance slot (${why})`);
  } catch (e) {
    err(`could not write instance record: ${String(e)}`);
  }
  process.on("exit", releaseSingleInstance);
}
