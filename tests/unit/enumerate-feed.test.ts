import { describe, it, expect } from "vitest";
import { enumerate } from "../../src/browser/ats-tools.js";

describe("ats.enumerate feed fetching (contextFetch contract)", () => {

  it("parses jobs from a Greenhouse-style feed returned by contextFetch", async () => {
    const fakeFeed = {
      jobs: [
        { id: "1", title: "Software Engineer", location: { name: "Bangalore" }, departments: [{ name: "Eng" }], absolute_url: "https://boards.greenhouse.io/stripe/jobs/1" },
        { id: "2", title: "Support Engineer", location: { name: "Remote" }, absolute_url: "https://boards.greenhouse.io/stripe/jobs/2" },
      ],
    };
    let seenUrl = "";
    const engine = {
      contextFetch: async (url: string) => { seenUrl = url; return { ok: true, status: 200, headers: {}, text: JSON.stringify(fakeFeed) }; },
    } as any;
    const r = await enumerate(engine, "greenhouse", "https://job-boards.greenhouse.io/stripe", "stripe");
    expect(r.method).toBe("api");
    expect(r.total).toBe(2);
    expect(r.jobs[0].title).toBe("Software Engineer");
    expect(r.jobs[0].location).toBe("Bangalore");
    expect(r.jobs[0].department).toBe("Eng");
    expect(seenUrl).toContain("boards-api.greenhouse.io");
  });

  it("reports a non-ok feed honestly as method=network with the endpoint noted", async () => {
    const engine = { contextFetch: async () => ({ ok: false, status: 0, headers: {}, text: "net err" }) } as any;
    const r = await enumerate(engine, "greenhouse", "https://job-boards.greenhouse.io/stripe", "stripe");
    expect(r.method).toBe("network");
    expect(r.total).toBe(0);
    expect(r.note).toContain("Direct feed fetch failed");
  });
});