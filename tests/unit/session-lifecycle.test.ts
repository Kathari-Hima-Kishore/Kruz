import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/browser/launcher.js", () => ({ launchBrowser: vi.fn(), closeBrowser: vi.fn(async () => {}) }));
import { launchBrowser, closeBrowser } from "../../src/browser/launcher.js";
import { SessionManager } from "../../src/session/manager.js";
import { ToolRouter } from "../../src/mcp/router.js";
import { PuppeteerEngine } from "../../src/browser/engines/puppeteer-engine.js";
import { loadConfig } from "../../src/config.js";

beforeEach(() => { vi.clearAllMocks(); });
const launched = () => ({ engine: { connected: true, url: vi.fn(async () => "https://careers.oracle.com/"), listTabs: vi.fn(async () => []) } as any, config: loadConfig() });
describe("September 13 lifecycle regressions", () => {
  it("coalesces concurrent creates and reuses a live session without navigation", async () => {
    let finish!: (value: any) => void;
    vi.mocked(launchBrowser).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const manager = new SessionManager();
    const a = manager.create(), b = manager.create({ startupUrl: "https://careers.cisco.com/" });
    expect(manager.isCreating).toBe(true);
    finish(launched());
    const [first, second] = await Promise.all([a, b]);
    expect(first).toBe(second);
    expect(await manager.create()).toBe(first);
    expect(launchBrowser).toHaveBeenCalledTimes(1);
    expect(manager.activeCount).toBe(1);
  });
  it("allows retry after launch failure", async () => {
    vi.mocked(launchBrowser).mockRejectedValueOnce(new Error("launch failed")).mockResolvedValueOnce(launched());
    const manager = new SessionManager();
    await expect(manager.create()).rejects.toThrow("launch failed");
    expect(manager.isCreating).toBe(false);
    expect((await manager.create()).status).toBe("active");
  });
  it("close waits for a pending launch so it cannot leave an orphan session", async () => {
    let finish!: (value: any) => void;
    vi.mocked(launchBrowser).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const manager = new SessionManager();
    const creating = manager.create();
    const closing = manager.close();
    finish(launched());
    await creating;
    expect(await closing).toBe(true);
    expect(manager.getActive()).toBeNull();
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
  it("identifies distinct MCP instances and annotates session errors", async () => {
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const first = new ToolRouter(), second = new ToolRouter();
    const a = parse(await first.route("session.status", {}));
    const b = parse(await second.route("session.status", {}));
    expect(a).toMatchObject({ ok: false, session_id: null, browser_connected: false, process_id: process.pid });
    expect(a.server_instance_id).not.toBe(b.server_instance_id);
    expect(parse(await first.route("server.info", {})).server_instance_id).toBe(a.server_instance_id);
  });
  it("reports reuse and preserves existing launch configuration", async () => {
    vi.mocked(launchBrowser).mockResolvedValue(launched());
    const router = new ToolRouter();
    await router.route("session.create", {});
    const r = JSON.parse((await router.route("session.create", { startup_url: "https://careers.cisco.com/", viewport_width: 500 })).content[0].text as string);
    expect(r).toMatchObject({ ok: true, reused: true, browser_connected: true, url: "https://careers.oracle.com/" });
    expect(launchBrowser).toHaveBeenCalledTimes(1);
  });
  for (const method of ["createIsolatedPage", "newTab"] as const) {
    it(`closes the new tab when ${method} viewport setup fails`, async () => {
      const engine = new PuppeteerEngine(true);
      const page = { setViewport: vi.fn(async () => { throw new Error("viewport failure"); }), close: vi.fn(async () => {}) };
      Object.assign(engine, { _connected: true, _page: { viewport: () => ({ width: 1000, height: 700 }), isClosed: () => false }, _browser: { connected: true, newPage: async () => page } });
      await expect(engine[method]()).rejects.toThrow("viewport failure");
      expect(page.close).toHaveBeenCalledTimes(1);
    });
  }
  it("does not misclassify closing a tab as a disconnected browser", () => {
    const engine = new PuppeteerEngine(true);
    Object.assign(engine, { _connected: true, _page: { isClosed: () => true }, _browser: { connected: true } });
    expect(engine.connected).toBe(true);
  });
});
