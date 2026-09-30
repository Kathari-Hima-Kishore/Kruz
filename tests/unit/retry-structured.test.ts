import { describe, it, expect } from "vitest";
import { withRetry } from "../../src/errors.js";

const structuredFail = (code: string) => ({
  ok: false as const,
  error: { code, message: code, retryable: true, subsystem: "engine" as const },
});

describe("withRetry — structured failure recovery (P1-D)", () => {
  it("retries a structured {ok:false} retryable result through its escalations", async () => {
    let calls = 0;
    let escalated = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return calls < 2 ? structuredFail("ELEMENT_OBSCURED") : { ok: true, result: 42 };
      },
      {
        retryOn: ["ELEMENT_OBSCURED"],
        escalations: [{ name: "dismiss-overlay", run: async () => { escalated++; return true; } }],
      },
    );
    expect((result as any).ok).toBe(true);
    expect(calls).toBe(2);
    expect(escalated).toBe(1);
  });

  it("does NOT run the ladder for a terminal structured failure (TARGET_NOT_FOUND returns fast)", async () => {
    let calls = 0;
    let escalated = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return structuredFail("TARGET_NOT_FOUND");
      },
      {
        retryOn: ["ELEMENT_OBSCURED", "STALE_ELEMENT"],
        escalations: [{ name: "x", run: async () => { escalated++; return true; } }],
      },
    );
    expect((result as any).error.code).toBe("TARGET_NOT_FOUND");
    expect(calls).toBe(1);
    expect(escalated).toBe(0);
  });

  it("preserves the true error code of the final structured failure (never CLICK_FAILED)", async () => {
    const result = await withRetry(
      async () => structuredFail("ELEMENT_OBSCURED"),
      {
        retryOn: ["ELEMENT_OBSCURED"],
        escalations: [{ name: "x", run: async () => true }],
      },
    );
    expect((result as any).error.code).toBe("ELEMENT_OBSCURED");
  });

  it("bounds the whole ladder by budgetMs so recovery cannot become a stall", async () => {
    let calls = 0;
    let escalated = 0;
    const started = Date.now();
    const result = await withRetry(
      async () => {
        calls++;
        return structuredFail("ELEMENT_OBSCURED");
      },
      {
        retryOn: ["ELEMENT_OBSCURED"],
        budgetMs: 120,
        delayMs: 10,
        escalations: [
          { name: "slow", run: async () => { escalated++; await new Promise((r) => setTimeout(r, 160)); return true; } },
          { name: "second", run: async () => { escalated++; return true; } },
        ],
      },
    );
    const elapsed = Date.now() - started;
    expect((result as any).error.code).toBe("ELEMENT_OBSCURED");
    expect(calls).toBeLessThanOrEqual(2);   // initial attempt (+ at most one retry)
    expect(escalated).toBeLessThanOrEqual(1); // the second escalation is skipped once over budget
    expect(elapsed).toBeLessThan(600);
  });

  it("still supports thrown errors (no regression)", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error("ELEMENT_OBSCURED: covered");
        return { ok: true } as any;
      },
      { retryOn: ["ELEMENT_OBSCURED"], escalations: [{ name: "x", run: async () => true }] },
    );
    expect((result as any).ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});