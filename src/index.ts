#!/usr/bin/env node

/**
 * Kruz — High-speed, low-token, accurate headed browser automation tool.
 *
 * This MCP server exposes browser automation tools to AI agents.
 * Run with: node dist/index.js
 * Or in dev: npx tsx src/index.ts
 */

import { createServer } from "./mcp/server.js";
import { claimSingleInstance, releaseSingleInstance } from "./single-instance.js";

// Track server start time for uptime reporting
(globalThis as any).__KRUZ_START__ = Date.now();

async function main() {
  // Single-instance guard (kruz-bugs.md #6): claim the ownership record so this
  // process — the browser owner — can reap orphaned Chrome from a crashed
  // predecessor before serving. A LIVE peer is never terminated: OpenCode restores
  // every workspace at once, and killing peers here was the cold-start error the
  // host reported as "MCP server process exited with code 1". Opt out:
  // KRUZ_SINGLE_INSTANCE=0.
  await claimSingleInstance();

  const { server } = await createServer();

  // Keep process alive
  process.on("SIGINT", async () => {
    releaseSingleInstance();
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    releaseSingleInstance();
    await server.close();
    process.exit(0);
  });

  // K31: If the browser (or a CDP call) throws hard in an event handler that isn't
  // wrapped, an unhandled rejection would otherwise terminate the whole MCP server and
  // drop the session. Log to stderr (stdout is reserved for MCP) and keep serving — a
  // wedged/crashed browser is recoverable via session.create, a dead server is not.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[kruz] unhandledRejection: ${String(reason)}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[kruz] uncaughtException: ${err?.stack ?? String(err)}\n`);
  });

  // Log to stderr (stdout is reserved for MCP protocol)
  process.stderr.write("Kruz MCP server started (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
