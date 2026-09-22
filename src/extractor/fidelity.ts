import { createHash } from "node:crypto";
import type { BrowserEngine, KruzElement } from "../browser/engine.js";
import type { Target, Fallback } from "../types/schema.js";
import { resolveElement } from "../browser/selectors.js";
import type {
  ExtractionResult,
  ExtractionSource,
  ExtractedCell,
  ExtractedColumn,
  ExtractedRow,
  TextExtractionData,
  LinkItem,
  FormField,
  ValueVisibility,
} from "../types/extraction.js";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function getSource(engine: BrowserEngine, pageId: string, tabId: string): Promise<ExtractionSource> {
  return {
    url: await engine.url(),
    page_id: pageId,
    tab_id: tabId,
    captured_at: new Date().toISOString(),
  };
}

function buildEnvelope<T>(
  resultType: string,
  source: ExtractionSource,
  data: T,
  warnings: string[]
): ExtractionResult<T> {
  const payload = JSON.stringify(data);
  return {
    ok: true,
    result_type: resultType as any,
    source,
    data,
    integrity: {
      algorithm: "sha256",
      raw_payload_hash: sha256(payload),
    },
    warnings,
  };
}

/**
 * Exact-fidelity extraction engine.
 * Every extracted value preserves the exact source text and includes provenance metadata.
 */
export class FidelityExtractor {
  /**
   * Extract exact text content from an element or scope.
   */
  async extractText(
    engine: BrowserEngine,
    target?: Target,
    fallback?: Fallback,
    scope?: string,
    pageId = "p1",
    tabId = "tab1"
  ): Promise<ExtractionResult<TextExtractionData>> {
    const source = await getSource(engine, pageId, tabId);
    const warnings: string[] = [];

    try {
      let el: KruzElement | null = null;
      if (target) {
        el = await resolveElement(engine, target, fallback, scope);
      } else {
        el = await engine.queryOne({ css: scope || "body" });
      }

      if (!el) {
        warnings.push("No elements matched the target selector.");
        const data: TextExtractionData = {
          raw: "",
          label: target?.name || target?.text,
          visibility: "hidden",
        };
        return buildEnvelope("text", source, data, warnings);
      }

      let raw = "";
      try { raw = await engine.innerText(el); } catch { raw = (await engine.textContent(el)) ?? ""; }
      const isVisible = await engine.isVisible(el).catch(() => true);
      const visibility: ValueVisibility = isVisible ? "visible" : "hidden";

      if (raw.trim().length < 80 && target) {
        const targetJson = JSON.stringify(target);
        const expandedText = await engine.evaluate(`(() => {
          const t = ${targetJson};
          const findEl = () => {
            if (t.css) return document.querySelector(t.css);
            if (t.role && t.name) {
              const els = document.querySelectorAll('[role="' + t.role + '"]');
              for (const el of els) {
                if (el.textContent?.trim().includes(t.name)) return el;
              }
            }
            if (t.text) {
              const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walk.nextNode()) {
                if (walk.currentNode.textContent?.includes(t.text)) return walk.currentNode.parentElement;
              }
            }
            return null;
          };
          const el = findEl();
          if (!el) return null;
          let current = el;
          for (let i = 0; i < 4 && current; i++) {
            current = current.parentElement;
            if (!current || current === document.body) break;
            const text = (current).innerText?.trim() ?? "";
            if (text.length > 200 && text.length > ((el).innerText?.trim().length ?? 0) * 3) {
              return text;
            }
          }
          return null;
        })()`).catch(() => ({ ok: false as const }));

        const expanded = expandedText.ok ? (expandedText.result as string | null) : null;
        if (expanded && expanded.length > raw.trim().length * 2) {
          raw = expanded;
          warnings.push("Expanded extraction to parent container to capture surrounding content.");
        }
      }

      const data: TextExtractionData = {
        raw,
        label: target?.name || target?.text,
        visibility,
      };

      return buildEnvelope("text", source, data, warnings);
    } catch (err) {
      warnings.push(`Extraction error: ${err}`);
      return {
        ok: false,
        result_type: "text",
        source,
        warnings,
      };
    }
  }

  /**
   * Extract a table with headers, rows, and cell-level provenance.
   */
  async extractTable(
    engine: BrowserEngine,
    target?: Target,
    fallback?: Fallback,
    scope?: string,
    pageId = "p1",
    tabId = "tab1"
  ): Promise<ExtractionResult> {
    const source = await getSource(engine, pageId, tabId);
    const warnings: string[] = [];

    try {
      let el: KruzElement | null = null;
      if (target) {
        el = await resolveElement(engine, target, fallback, scope);
      } else {
        const tableScope = scope ? `${scope} table` : "table";
        el = await engine.queryOne({ css: tableScope });
      }

      if (!el) {
        warnings.push("No table element found.");
        return buildEnvelope("table", source, { columns: [], rows: [] } as any, warnings);
      }

      // Batch-extract all table data in a single evaluateOn call
      const tableData = await engine.evaluateOn(el, `(() => {
        const tbl = this;
        const headerCells = tbl.querySelectorAll('thead th, thead td, tr:first-child th');
        const columns = Array.from(headerCells).map((c, i) => ({
          key: 'c' + (i + 1),
          raw: c.textContent?.trim() || ''
        }));
        let rows = [];
        const bodyRows = tbl.querySelectorAll('tbody tr, tr:not(:first-child)');
        for (let r = 0; r < bodyRows.length; r++) {
          const cells = bodyRows[r].querySelectorAll('td');
          const cellData = [];
          for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            const raw = cell.textContent?.trim() || '';
            const style = window.getComputedStyle(cell);
            cellData.push({
              column: columns[c]?.key || 'c' + (c + 1),
              raw,
              label: columns[c]?.raw,
              visible: style.display !== 'none' && style.visibility !== 'hidden',
            });
          }
          rows.push({ row_index: r, cells: cellData });
        }
        return { columns, rows };
      })()`).catch(() => ({ ok: false as const }) as any);

      if (!tableData.ok || !tableData.result) {
        warnings.push("Table extraction eval failed.");
        return buildEnvelope("table", source, { columns: [], rows: [] } as any, warnings);
      }

      const { columns, rows: rawRows } = tableData.result as { columns: ExtractedColumn[]; rows: any[] };

      // Enrich rows with guessValueType
      const rows: ExtractedRow[] = rawRows.map((r: any) => ({
        ...r,
        cells: r.cells.map((c: any) => ({
          ...c,
          visibility: (c.visible ? "visible" : "hidden") as ValueVisibility,
          type: this.guessValueType(c.raw),
        })),
      }));

      const expectedCells = columns.length;
      for (const row of rows) {
        if (row.cells.length !== expectedCells) {
          warnings.push(
            `Row ${row.row_index} has ${row.cells.length} cells, expected ${expectedCells}. Possible merged cells.`
          );
        }
      }

      if (columns.length === 0) {
        warnings.push("No table headers found.");
      }

      const result: ExtractionResult = {
        ok: true,
        result_type: "table",
        source,
        columns,
        rows,
        integrity: {
          algorithm: "sha256",
          raw_payload_hash: sha256(JSON.stringify({ columns, rows })),
        },
        warnings,
      };

      return result;
    } catch (err) {
      warnings.push(`Table extraction error: ${err}`);
      return {
        ok: false,
        result_type: "table",
        source,
        warnings,
      };
    }
  }

  /**
   * Extract all links from a scope.
   */
  async extractLinks(
    engine: BrowserEngine,
    scope?: string,
    filter?: string,
    pageId = "p1",
    tabId = "tab1"
  ): Promise<ExtractionResult<LinkItem[]>> {
    const source = await getSource(engine, pageId, tabId);
    const warnings: string[] = [];

    try {
      const expandedScope = this.expandScope(scope);

      if (expandedScope) {
        const scopeCount = await engine.countElements({ css: expandedScope });
        if (scopeCount === 0) {
          warnings.push(`Scope '${scope}' matched no elements on the page. Returning empty result. Tip: try without scope, or use page_observe to find elements.`);
          return buildEnvelope("links", source, [], warnings);
        }
      }

      const links: LinkItem[] = [];
      try {
        const scopeSelector = (expandedScope || "body").replace(/'/g, "\\'");
        const allLinks = await engine.evaluate(`(() => {
          const root = document.querySelector('${scopeSelector}') || document.body;
          if (!root) return [];
          const anchors = root.querySelectorAll("a[href]");
          return Array.from(anchors).slice(0, 200).map(a => {
            let text = "";
            const lb = a.getAttribute("aria-labelledby");
            if (lb) { const le = document.getElementById(lb); if (le) text = le.textContent?.trim() || ""; }
            if (!text) { const desc = a.getAttribute("aria-describedby"); if (desc) { const de = document.getElementById(desc); if (de) text = de.textContent?.trim() || ""; } }
            if (!text) text = a.textContent?.trim() || "";
            if (!text) text = (a).innerText?.trim() || "";
            if (!text) text = a.getAttribute("aria-label") || "";
            if (!text) text = a.getAttribute("title") || "";
            if (!text) { const img = a.querySelector("img"); if (img) text = img.getAttribute("alt") || ""; }
            if (!text) text = a.getAttribute("data-label") || a.getAttribute("data-title") || "";
            if (!text) {
              const onclick = a.getAttribute("onclick") || "";
              const match = onclick.match(/(?:openJob|navigate|goTo)\\s*\\(\\s*['"]?([\\w]+)/i);
              if (match) text = "[job:" + match[1] + "]";
            }
            return {
              text: text.substring(0, 500),
              href: a.getAttribute("href") || "",
              visible: (a).offsetParent !== null,
              enabled: !((a).getAttribute("aria-disabled") === "true" || (a).hasAttribute("disabled")),
            };
          });
        })()`).catch(() => ({ ok: false as const }));

        if (allLinks.ok && Array.isArray(allLinks.result)) {
          for (const link of allLinks.result) {
            if (filter) {
              const pattern = new RegExp(filter, "i");
              if (!pattern.test(link.text) && !pattern.test(link.href)) continue;
            }
            const ref = `link_${links.length + 1}`;
            links.push({ ref, raw_text: link.text, href: link.href, visible: link.visible, enabled: link.enabled });
          }
        }
      } catch (err) {
        warnings.push(`Link extraction error: ${err}`);
      }

      return buildEnvelope("links", source, links, warnings);
    } catch (err) {
      warnings.push(`Link extraction error: ${err}`);
      return {
        ok: false,
        result_type: "links",
        source,
        warnings,
      };
    }
  }

  /**
   * Extract form fields with their current state.
   */
  async extractForm(
    engine: BrowserEngine,
    target?: Target,
    fallback?: Fallback,
    scope?: string,
    pageId = "p1",
    tabId = "tab1",
    refMap?: Map<string, any>
  ): Promise<ExtractionResult<FormField[]>> {
    const source = await getSource(engine, pageId, tabId);
    const warnings: string[] = [];

    try {
      let formEl: KruzElement | null = null;
      if (target) {
        formEl = await resolveElement(engine, target, fallback, scope);
      } else if (scope) {
        const scopeEl = await engine.queryOne({ css: scope });
        if (scopeEl) {
          const tag = await engine.tagName(scopeEl).catch(() => "");
          if (tag === "form") {
            formEl = scopeEl;
          } else {
            formEl = await engine.queryOneInScope(scopeEl, { css: "form" });
          }
        }
      } else {
        formEl = await engine.queryOne({ css: "form" });
      }

      const fields: FormField[] = [];

      // Use a single evaluateOn to enumerate form fields from the form element (or page)
      const fieldsResult = await engine.evaluate(`(() => {
        const form = ${formEl ? `document.querySelector('form')` : "null"};
        const root = form || document;
        const fieldEls = root.querySelectorAll('input, select, textarea');
        const out = [];
        for (const f of fieldEls) {
          const el = f;
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute('name') || '';
          const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text');
          const placeholder = el.getAttribute('placeholder') || undefined;
          const required = el.hasAttribute('required');
          const disabled = el.disabled;
          const readonly = el.hasAttribute('readonly');
          let value = '';
          if (tag === 'select') { value = el.value || ''; }
          else { value = (el).value || ''; }
          let id = el.id || '';
          let label = '';
          if (id) {
            const labelEl = document.querySelector('label[for="' + id + '"]');
            if (labelEl) label = labelEl.textContent?.trim() || '';
          }
          if (!label) {
            const parent = el.closest('label');
            if (parent) label = parent.textContent?.trim() || '';
          }
          let checked = undefined;
          if (type === 'checkbox' || type === 'radio') checked = el.checked;
          let options = undefined;
          if (tag === 'select') {
            options = Array.from(el.options).map(opt => ({
              value: opt.value,
              label: opt.textContent?.trim() || '',
              selected: opt.selected,
            }));
          }
          out.push({ name, type, placeholder, required, disabled, readonly, value, label, checked, options, tag });
        }
        return out;
      })()`).catch(() => ({ ok: false as const }));

      if (fieldsResult.ok && Array.isArray(fieldsResult.result)) {
        for (let i = 0; i < fieldsResult.result.length; i++) {
          const f = fieldsResult.result[i];
          const ref = `form_${i + 1}`;

          // Register form refs in the observer's refMap
          if (refMap) {
            // Resolve the field to a KruzElement for the refMap
            const fieldEl = await engine.queryOne({ css: `input[name="${f.name}"], select[name="${f.name}"], textarea[name="${f.name}"]` }).catch(() => null);
            if (fieldEl) {
              refMap.set(ref, { locator: fieldEl, semantic: null, formRef: true });
            }
          }

          fields.push({
            ref,
            name: f.name,
            type: f.type,
            value: f.value,
            label: f.label || undefined,
            placeholder: f.placeholder,
            required: f.required,
            disabled: f.disabled,
            readonly: f.readonly,
            checked: f.checked,
            options: f.options,
          });
        }
      }

      // K6: If no fields found inside <form>, try scanning the entire page.
      if (fields.length === 0 && formEl) {
        const globalCount = await engine.countElements({ css: "input, select, textarea" });
        if (globalCount > 0) {
          warnings.push("No fields inside <form> element. Falling back to global page scan.");
          // Re-run the same evaluate but without form scoping
          const globalResult = await engine.evaluate(`(() => {
            const fieldEls = document.querySelectorAll('input, select, textarea');
            const out = [];
            for (const f of fieldEls) {
              const el = f;
              const tag = el.tagName.toLowerCase();
              const name = el.getAttribute('name') || '';
              const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text');
              const placeholder = el.getAttribute('placeholder') || undefined;
              const required = el.hasAttribute('required');
              const disabled = el.disabled;
              const readonly = el.hasAttribute('readonly');
              let value = '';
              if (tag === 'select') { value = el.value || ''; }
              else { value = (el).value || ''; }
              let id = el.id || '';
              let label = '';
              if (id) {
                const labelEl = document.querySelector('label[for="' + id + '"]');
                if (labelEl) label = labelEl.textContent?.trim() || '';
              }
              if (!label) {
                const parent = el.closest('label');
                if (parent) label = parent.textContent?.trim() || '';
              }
              let checked = undefined;
              if (type === 'checkbox' || type === 'radio') checked = el.checked;
              let options = undefined;
              if (tag === 'select') {
                options = Array.from(el.options).map(opt => ({
                  value: opt.value,
                  label: opt.textContent?.trim() || '',
                  selected: opt.selected,
                }));
              }
              out.push({ name, type, placeholder, required, disabled, readonly, value, label, checked, options, tag });
            }
            return out;
          })()`).catch(() => ({ ok: false as const }));

          if (globalResult.ok && Array.isArray(globalResult.result)) {
            for (let i = 0; i < globalResult.result.length; i++) {
              const f = globalResult.result[i];
              const ref = `form_${fields.length + 1}`;
              if (refMap) {
                const fieldEl = await engine.queryOne({ css: `input[name="${f.name}"], select[name="${f.name}"], textarea[name="${f.name}"]` }).catch(() => null);
                if (fieldEl) {
                  refMap.set(ref, { locator: fieldEl, semantic: null, formRef: true });
                }
              }
              fields.push({
                ref,
                name: f.name,
                type: f.type,
                value: f.value,
                label: f.label || undefined,
                placeholder: f.placeholder,
                required: f.required,
                disabled: f.disabled,
                readonly: f.readonly,
                checked: f.checked,
                options: f.options,
              });
            }
          }
        }
      }

      return buildEnvelope("form", source, fields, warnings);
    } catch (err) {
      warnings.push(`Form extraction error: ${err}`);
      return {
        ok: false,
        result_type: "form",
        source,
        warnings,
      };
    }
  }

  /**
   * Extract a single target value with full provenance.
   */
  async extractTarget(
    engine: BrowserEngine,
    target: Target,
    fallback?: Fallback,
    scope?: string,
    verify = false,
    pageId = "p1",
    tabId = "tab1"
  ): Promise<ExtractionResult<TextExtractionData>> {
    const source = await getSource(engine, pageId, tabId);
    const warnings: string[] = [];

    try {
      const el = await resolveElement(engine, target, fallback, scope);

      if (!el) {
        warnings.push("No elements matched the target selector.");
        const data: TextExtractionData = {
          raw: "",
          label: target?.name || target?.text,
          visibility: "hidden",
        };
        return buildEnvelope("target", source, data, warnings);
      }

      let raw = "";
      try { raw = await engine.innerText(el); } catch { raw = (await engine.textContent(el)) ?? ""; }
      const isVisible = await engine.isVisible(el).catch(() => true);
      const visibility: ValueVisibility = isVisible ? "visible" : "hidden";

      if (raw.trim().length < 80 && target) {
        const targetJson = JSON.stringify(target);
        const expandedText = await engine.evaluate(`(() => {
          const t = ${targetJson};
          const findEl = () => {
            if (t.css) return document.querySelector(t.css);
            if (t.role && t.name) {
              const els = document.querySelectorAll('[role="' + t.role + '"]');
              for (const el of els) {
                if (el.textContent?.trim().includes(t.name)) return el;
              }
            }
            if (t.text) {
              const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (walk.nextNode()) {
                if (walk.currentNode.textContent?.includes(t.text)) return walk.currentNode.parentElement;
              }
            }
            return null;
          };
          const el = findEl();
          if (!el) return null;
          let current = el;
          for (let i = 0; i < 4 && current; i++) {
            current = current.parentElement;
            if (!current || current === document.body) break;
            const text = (current).innerText?.trim() ?? "";
            if (text.length > 200 && text.length > ((el).innerText?.trim().length ?? 0) * 3) {
              return text;
            }
          }
          return null;
        })()`).catch(() => ({ ok: false as const }));

        const expanded = expandedText.ok ? (expandedText.result as string | null) : null;
        if (expanded && expanded.length > raw.trim().length * 2) {
          raw = expanded;
          warnings.push("Expanded extraction to parent container to capture surrounding content.");
        }
      }

      const data: TextExtractionData = {
        raw,
        label: target.name || target.text,
        visibility,
      };

      if (verify) {
        let verifyRaw = "";
        try { verifyRaw = await engine.innerText(el); } catch { verifyRaw = (await engine.textContent(el)) ?? ""; }
        if (verifyRaw !== raw) {
          warnings.push(
            `Verification mismatch: original="${raw}" vs verify="${verifyRaw}". Page may have changed between extraction and verification.`
          );
        }
      }

      return buildEnvelope("target", source, data, warnings);
    } catch (err) {
      warnings.push(`Target extraction error: ${err}`);
      return {
        ok: false,
        result_type: "target",
        source,
        warnings,
      };
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * K13: Expand semantic scope names to include ARIA role fallbacks.
   * e.g. "main" → "main, [role='main'], #main, .main"
   * This matches the same expansion used by page_observe.
   */
  private expandScope(scope?: string): string | undefined {
    if (!scope) return undefined;
    const map: Record<string, string> = {
      main: "main, [role='main'], #main, .main",
      nav: "nav, [role='navigation'], #nav, .nav",
      header: "header, [role='banner'], #header, .header",
      footer: "footer, [role='contentinfo'], #footer, .footer",
      dialog: "dialog, [role='dialog'], .modal, .dialog",
      form: "form, [role='form']",
      table: "table, [role='table'], [role='grid']",
    };
    return map[scope] || scope;
  }

  private guessValueType(raw: string): "string" | "number" | "date" | "boolean" | "null" {
    if (raw === "" || raw === null || raw === undefined) return "null";
    if (raw === "true" || raw === "false") return "boolean";
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return "date";
    if (/^[\d,.\-+$/€£¥%]+$/.test(raw.replace(/\s/g, ""))) return "number";
    return "string";
  }
}
