import { describe, it, expect } from "vitest";
import { snapshotJS, markTargetsJS, clearMarksJS, listTargetsJS } from "../../src/browser/computer-use.js";

describe("computer-use serialized helpers (toString() round-trip safety)", () => {
  // snapshotJS/markTargetsJS are evaluated inside the page via `<fn>.toString()`.
  // They must be self-contained: referencing a sibling module function like
  // `listTargetsJS` would throw ReferenceError inside the page (only the one
  // serialized function body is injected). This is the regression guard for the
  // live-found `page.computerUseSnapshot` ReferenceError bug.

  it("serialized source of snapshotJS must not reference listTargetsJS", () => {
    const src = snapshotJS.toString();
    expect(src).not.toMatch(/listTargetsJS/);
    expect(src).toContain("document.querySelectorAll");
  });

  it("serialized source of markTargetsJS must not reference listTargetsJS", () => {
    const src = markTargetsJS.toString();
    expect(src).not.toMatch(/listTargetsJS/);
  });

  // Every serialized helper must run with only a browser-like window/document on
  // globalThis and nothing else imported from the module scope. We simulate the
  // page by stubbing globalThis.window/document (the live engine does the same
  // by evaluating inside the page). This catches accidental cross-calls and
  // missing guards.
  it("all serialized helper sources are independently runnable against a minimal window/document stub", () => {
    const prev: any = { window: (globalThis as any).window, document: (globalThis as any).document };
    try {
      const elements: any[] = [];
      (globalThis as any).window = {
        innerWidth: 1280,
        innerHeight: 720,
        scrollX: 0,
        scrollY: 0,
        location: { href: "https://example.com/jobs" },
        getComputedStyle: () => ({ display: "", visibility: "" }),
        scrollTo: () => {},
        addEventListener: () => {},
      };
      (globalThis as any).document = {
        querySelectorAll: (sel: string) => {
          if (sel.includes(".cu-badge")) return []; // markTargetsJS/clearMarksJS cleanup pass
          // One tiny interactive element so listTargetsJS/snapshotJS produce a target.
          return [{
            tagName: "BUTTON",
            getBoundingClientRect: () => ({ left: 10, top: 10, width: 20, height: 20, right: 30, bottom: 30 }),
            innerText: "Go",
            value: "",
            placeholder: "",
            getAttribute: (name: string) => (name === "aria-label" ? null : null),
            name: "",
            id: "go",
          }];
        },
        createElement: () => {
          const el: any = { style: {}, className: "", textContent: "", children: [] };
          return el;
        },
        body: { appendChild: (c: any) => elements.push(c) },
      };
      for (const fn of [listTargetsJS, snapshotJS, markTargetsJS, clearMarksJS]) {
        // Function bodies are serialized and evaluated in the page as strings; a
        // helper that relies on a sibling module function or a missing global
        // surface throws at invocation time. Call the serialized body directly.
        const invoked = Function(`return (${fn.toString()})()`)();
        expect(typeof invoked).toBe("string");
      }
    } finally {
      (globalThis as any).window = prev.window;
      (globalThis as any).document = prev.document;
    }
  });
});