import { ComputerVisionClient } from "@azure/cognitiveservices-computervision";
import { ApiKeyCredentials } from "@azure/ms-rest-js";
import type { BrowserEngine } from "./engine.js";

let client: ComputerVisionClient | null = null;
export function initAzureCV(): boolean {
  client = null;
  const endpoint = process.env.AZURE_CV_ENDPOINT;
  const key = process.env.AZURE_CV_KEY;
  if (!endpoint || !key || endpoint.includes("YOUR_AZURE") || key.includes("YOUR_AZURE")) return false;
  try {
    if (new URL(endpoint).protocol !== "https:") return false;
    client = new ComputerVisionClient(new ApiKeyCredentials({ inHeader: { "Ocp-Apim-Subscription-Key": key } }), endpoint);
    return true;
  } catch { return false; }
}
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function parseOCRBox(value: unknown) {
  if (typeof value !== "string") throw new Error("Invalid OCR bounding box");
  const parts = value.split(",");
  const [x, y, width, height] = parts.map(Number);
  if (parts.length !== 4 || parts.some(p => !p.trim()) || ![x,y,width,height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) throw new Error("Invalid OCR bounding box");
  return { x: x + width / 2, y: y + height / 2, width, height };
}
export async function findTextWithOCR(image: Buffer, targetText: string, options: { language?: string; detectOrientation?: boolean; timeout?: number } = {}) {
  if (!normalize(targetText)) throw new Error("OCR target text must not be empty");
  if (!client && !initAzureCV()) throw new Error("Azure CV client not initialized. Set AZURE_CV_ENDPOINT and AZURE_CV_KEY.");
  const result = await client!.recognizePrintedTextInStream(options.detectOrientation ?? false, image, { language: options.language ?? "en", timeout: options.timeout ?? 5000 } as any);
  // Legacy boxes use a rotated image coordinate system. Do not click untransformed boxes.
  if ((result.orientation && !["Up", "NotDetected"].includes(result.orientation)) || Math.abs(result.textAngle ?? 0) > 0.001) throw new Error("Rotated OCR coordinates are not supported for clicking");
  const matches = [];
  for (const region of result.regions ?? []) for (const line of region.lines ?? []) {
    const text = (line.words ?? []).map(w => w.text ?? "").join(" ");
    if (normalize(text) === normalize(targetText)) matches.push({ ...parseOCRBox(line.boundingBox), text, confidence: null });
  }
  if (matches.length > 1) throw new Error("Ambiguous OCR target: multiple matching lines");
  return matches[0] ?? null;
}

/** Bridge to Kruz's actual BrowserEngine, bound to one engine for the whole action. */
export function createKruzCVBridge(engine: BrowserEngine) {
  const state = async () => {
    const pageId = (await engine.listTabs()).find(t => t.isActive)?.id;
    if (!pageId) throw new Error("No active tab for OCR");
    const r = await engine.evaluate<{ width: number; height: number; url: string; scrollX: number; scrollY: number }>("({width:innerWidth,height:innerHeight,url:location.href,scrollX,scrollY})");
    if (!r.ok || !r.result) throw new Error("Cannot read viewport state");
    if ((await engine.listTabs()).find(t => t.isActive)?.id !== pageId) throw new Error("Tab switched during OCR state capture");
    return { pageId, ...(r.result as { width: number; height: number; url: string; scrollX: number; scrollY: number }) };
  };
  return {
    async capture() {
      const before = await state();
      const image = await engine.screenshot({ fullPage: false });
      if (JSON.stringify(before) !== JSON.stringify(await state())) throw new Error("Page changed during screenshot");
      if (image.length < 24 || image.subarray(0,8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Expected PNG viewport screenshot");
      const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
      if (!width || !height || before.width <= 0 || before.height <= 0) throw new Error("Invalid screenshot dimensions");
      return { image, width, height, state: before };
    },
    async click(location: { x: number; y: number; text?: string }, capture: any) {
      if (JSON.stringify(capture.state) !== JSON.stringify(await state())) throw new Error("Page moved since OCR; capture again before clicking");
      const x = location.x * capture.state.width / capture.width;
      const y = location.y * capture.state.height / capture.height;
      if (![x,y].every(Number.isFinite) || x < 0 || y < 0 || x >= capture.state.width || y >= capture.state.height) throw new Error("OCR point is outside the viewport");
      const guard = await engine.evaluate(`(() => { const e = document.elementFromPoint(${x},${y}); if (!e) return false; const c = e.closest('button,a,[role="button"],input') || e; const label = ((c.innerText || c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('value') || '')).trim().replace(/\\s+/g,' ').toLowerCase(); const expected = ${JSON.stringify(location.text?.toLowerCase() ?? '')}; if (expected && !label.includes(expected) && e.tagName !== 'CANVAS') return false; return !/\\bapply\\b/i.test((c.innerText || '') + ' ' + (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('value') || '')); })()`);
      if (!guard.ok || guard.result !== true) throw new Error("OCR click blocked: no hit target or Apply control");
      await engine.mouseClick(x, y, { button: "left" });
      return { x, y };
    },
  };
}

/** Retries recognition only. Once click dispatch begins, its outcome may be unknown. */
export async function cvEnhancedClick(bridge: ReturnType<typeof createKruzCVBridge>, targetText: string, options: { timeout?: number; retryCount?: number; verify?: () => Promise<boolean> } = {}) {
  if (/\bapply\b/i.test(targetText)) throw new Error("OCR clicking Apply controls is disabled");
  const attempts = Math.max(0, Math.min(2, options.retryCount ?? 2));
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const capture = await bridge.capture();
    const location = await findTextWithOCR(capture.image, targetText, { timeout: options.timeout });
    if (!location) {
      if (attempt < attempts) { await new Promise(r => setTimeout(r, 250)); continue; }
      return { ok: false, clicked: false, reason: "OCR text not found" };
    }
    const point = await bridge.click(location, capture);
    if (options.verify) {
      try { return { ok: true, clicked: true, verified: await options.verify(), point }; }
      catch { return { ok: true, clicked: true, verified: false, point }; }
    }
    return { ok: true, clicked: true, verified: false, point };
  }
  return { ok: false, clicked: false };
}
