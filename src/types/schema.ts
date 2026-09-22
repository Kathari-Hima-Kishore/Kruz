import { z } from "zod";

// ── Core primitives (used by controller, selectors, and observer) ──────────

/** Element targeting — semantic selectors for finding elements */
export const TargetSchema = z.object({
  ref: z.string().optional().describe("Stable element reference (e.g. e17)"),
  css: z.string().optional().describe("CSS selector (e.g. '#my-id', 'input[type=range]')"),
  role: z.string().optional().describe("ARIA role (button, link, textbox, etc.)"),
  name: z.string().optional().describe("Accessible name of the element"),
  text: z.string().optional().describe("Exact visible text content"),
  label: z.string().optional().describe("Associated form label text"),
  placeholder: z.string().optional().describe("Placeholder attribute"),
  testid: z.string().optional().describe("data-testid attribute value"),
  nameAttr: z.string().optional().describe("HTML name attribute"),
  id: z.string().optional().describe("HTML id attribute"),
});
export type Target = z.infer<typeof TargetSchema>;

/** Fallback selectors — used when primary semantic selectors fail */
export const FallbackSchema = z.object({
  text: z.string().optional().describe("Exact visible text to match"),
  css: z.string().optional().describe("CSS selector fallback"),
  xpath: z.string().optional().describe("XPath fallback"),
});
export type Fallback = z.infer<typeof FallbackSchema>;

/** Observation detail level */
export const DetailLevelSchema = z.enum(["minimal", "standard", "full"]);
export type DetailLevel = z.infer<typeof DetailLevelSchema>;
