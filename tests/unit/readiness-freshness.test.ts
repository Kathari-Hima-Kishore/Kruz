import { describe, it, expect } from "vitest";
import { isNewDocument } from "../../src/browser/controller.js";

/**
 * Guards the fix for the stale-readiness bug: `page.open` reported `_ready: true`
 * off the document it was navigating AWAY FROM, because the readiness poll races
 * `page.goto` and the outgoing page is normally a full, meaningful document.
 *
 * Observed live: `page.open("https://careers.cognizant.com/...")` returned
 * `_ready: true` with the URL of a blog post in 6ms.
 */
describe("isNewDocument", () => {
  it("treats no in-flight navigation as always fresh", () => {
    // Every non-open caller (post-click completion, overlay probes) passes no
    // preNav and must keep the previous behaviour.
    expect(isNewDocument(undefined, "https://example.com/", 111)).toBe(true);
    expect(isNewDocument(undefined, "about:blank", null)).toBe(true);
  });

  it("rejects the document we are leaving (the actual bug)", () => {
    const preNav = { url: "https://freshersdunia.in/post/", timeOrigin: 1791049412145 };
    // Committed, but still reading the outgoing page: identical timeOrigin.
    expect(isNewDocument(preNav, "https://freshersdunia.in/post/", 1791049412145)).toBe(false);
  });

  it("accepts a genuinely new document", () => {
    const preNav = { url: "https://freshersdunia.in/post/", timeOrigin: 1791049412145 };
    expect(isNewDocument(preNav, "https://careers.cognizant.com/genc/", 1791049430311)).toBe(true);
  });

  it("treats a same-URL reload as a new document", () => {
    // The URL fallback cannot see this, which is exactly why timeOrigin is
    // authoritative when both sides have it.
    const preNav = { url: "https://example.com/jobs", timeOrigin: 500 };
    expect(isNewDocument(preNav, "https://example.com/jobs", 900)).toBe(true);
  });

  it("accepts a legitimate cross-host redirect", () => {
    // A shortener / SSO bounce / country redirect really is a new document and
    // must not be reported as "never committed".
    const preNav = { url: "https://t.co/abc", timeOrigin: 10 };
    expect(isNewDocument(preNav, "https://careers.cognizant.com/genc/", 20)).toBe(true);
  });

  it("falls back to normalized URL comparison when timeOrigin is unavailable", () => {
    const preNav = { url: "https://example.com/jobs/", timeOrigin: null };
    expect(isNewDocument(preNav, "https://example.com/jobs/", null)).toBe(false);
    // normalizeUrl strips the trailing slash, so these are the SAME document.
    expect(isNewDocument(preNav, "https://example.com/jobs", null)).toBe(false);
    expect(isNewDocument(preNav, "https://example.com/jobs?page=2", null)).toBe(true);
  });

  it("does NOT trust the current timeOrigin alone when the pre-nav one is missing", () => {
    // The asymmetry is deliberate. `timeOrigin` is only a comparison when BOTH
    // sides have one; a lone current value cannot distinguish "new document" from
    // "same document, we just failed to capture a baseline". Treating it as fresh
    // would mark every snapshot fresh and reintroduce the original bug, so the
    // URL comparison is used instead — conservative, and errs toward waiting.
    expect(isNewDocument({ url: "https://a.test/", timeOrigin: null }, "https://a.test/", 77)).toBe(false);
    // ...and the URL is still allowed to prove a change when there is one.
    expect(isNewDocument({ url: "https://a.test/", timeOrigin: null }, "https://b.test/", 77)).toBe(true);
  });
});