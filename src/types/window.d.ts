// ── Window augmentation for Kruz's in-page control layer ─────────────────────
// The control-lock filter and the model-dispatch marker are plain page globals
// written by the injected layer (visual-cursor.ts) and read by the engine.
// Declaring them here keeps the engine's page-side callbacks free of TypeScript
// casts — those callbacks are serialized into the browser as raw JavaScript, so
// a cast like `(window as any)` becomes a runtime SyntaxError there, not a
// compile error. That regression silently disabled the model-control lock.

declare global {
  interface Window {
    /** True while the model's synthesized DOM events are being dispatched. */
    __kruzAutomationBypass?: boolean;
    /** True while the model is dispatching its own trusted input (CDP). */
    __kruzExpectingInput?: boolean;
  }
}

export {};
