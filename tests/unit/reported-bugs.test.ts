import { afterEach, describe, expect, it, vi } from "vitest";
import { detectATS } from "../../src/browser/ats-detector.js";
import { discoverGreenhouseHandle, KNOWN_TOOLS } from "../../src/mcp/tool-names.js";
import { ToolRouter } from "../../src/mcp/router.js";
import { KRUZ_VERSION } from "../../src/version.js";
import { verifyPosting, samePostingIdentity } from "../../src/browser/ats-tools.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("reported MCP regressions", () => {
  it("prefers Phenom frontend assets over embedded Workday links", () => {
    const result = detectATS("https://careers.cisco.com/global/en/india/etr-jobs",
      `<a href="https://cisco.myworkdayjobs.com/apply">Apply</a><script src="https://cdn.phenompeople.com/site.js"></script>`);
    expect(result.type).toBe("phenom");
    expect(result.confidence).toBe("medium");
  });
  it("does not use generic data-automation attributes or URL query strings as vendor evidence", () => {
    expect(detectATS("https://example.com/?redirect=jobs.ashbyhq.com", '<div data-automation-id="header"></div>').type).toBe("unknown");
    expect(detectATS("https://careers.oracle.com/en/sites/jobsearch/jobs").type).toBe("oracle-hcm");
  });
  it("returns only actually probed company candidates, never marketing links", async () => {
    const fetcher = vi.fn(async (url: string) => url === "https://job-boards.greenhouse.io/"
      ? new Response('<a href="/platform">Platform</a><a href="/pricing">Pricing</a><a href="/voice-ai-interviewing">AI</a>')
      : new Response('', { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await discoverGreenhouseHandle("Atlassian");
    expect(result.ok).toBe(false);
    expect(result.tried).toEqual(["atlassian"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects HTML 200 responses as board evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<html>Marketing</html>')));
    expect((await discoverGreenhouseHandle("Atlassian")).ok).toBe(false);
  });
  it("reports the authoritative registry count and package version", async () => {
    const response = await new ToolRouter().route("server.info", {});
    const result = JSON.parse((response.content[0] as any).text);
    expect(result.tools_count).toBe(KNOWN_TOOLS.size);
    expect(result.server.version).toBe(KRUZ_VERSION);
  });
  it("rejects headless requests before launching", async () => {
    const response = await new ToolRouter().route("session.create", { headless: true });
    expect(JSON.parse((response.content[0] as any).text).error.code).toBe("HEADED_REQUIRED");
  });
  it("clears route timers and never calls a timeout success", async () => {
    vi.useFakeTimers();
    const router = new ToolRouter();
    await router.route("server.info", {});
    expect(vi.getTimerCount()).toBe(0);
    vi.spyOn(router as any, "handle").mockReturnValue(new Promise(() => {}));
    const response = router.route("page.handleOverlays", {});
    await vi.advanceTimersByTimeAsync(25000);
    const result = await response;
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ ok: false, outcome: "unknown", retry_safe: false });
  });
  it("does not turn extraction failure into an exclusion or fabricated body", async () => {
    const engine = { navigate: vi.fn(async () => {}), waitFor: vi.fn(async () => false), evaluate: vi.fn(async () => ({ ok: false })) };
    const result = await verifyPosting(engine as any, "https://example.com/job/1");
    expect(result).toMatchObject({ verdict: "hold", body_text: "", status: "broken", posting_url: "https://example.com/job/1" });
  });
  it("checks job IDs and query identity, allowing only harmless URL normalization", () => {
    expect(samePostingIdentity("https://example.com/job/1", "https://example.com/job/2")).toBe(false);
    expect(samePostingIdentity("https://example.com/job?id=1", "https://example.com/job?id=2")).toBe(false);
    expect(samePostingIdentity("https://example.com/job/1", "https://example.com/job/1/#details")).toBe(true);
  });
});
