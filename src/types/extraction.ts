// ── Extraction types ─────────────────────────────────────────────────────────

/** Source provenance for extracted data */
export interface ExtractionSource {
  url: string;
  page_id: string;
  tab_id: string;
  captured_at: string; // ISO 8601
}

/** Visibility state of an extracted value */
export type ValueVisibility = "visible" | "hidden" | "selected" | "disabled" | "inferred";

/** A single extracted cell or value with provenance */
export interface ExtractedCell {
  column?: string; // column key for tables
  raw: string; // exact source text, byte-for-byte
  ref?: string; // element reference
  type?: "string" | "number" | "date" | "boolean" | "null";
  label?: string; // surrounding label or header
  visibility?: ValueVisibility;
  hash?: string; // SHA-256 of raw value
}

/** A table row */
export interface ExtractedRow {
  row_index: number;
  cells: ExtractedCell[];
}

/** A table column */
export interface ExtractedColumn {
  key: string; // c1, c2, etc.
  raw: string; // header text
}

/** Integrity metadata */
export interface IntegrityMeta {
  algorithm: "sha256";
  raw_payload_hash: string;
}

/** Full extraction result envelope */
export interface ExtractionResult<T = unknown> {
  ok: boolean;
  result_type: "text" | "table" | "links" | "form" | "target";
  source: ExtractionSource;
  data?: T;
  columns?: ExtractedColumn[];
  rows?: ExtractedRow[];
  integrity?: IntegrityMeta;
  warnings: string[];
}

/** Simple text extraction result */
export interface TextExtractionData {
  raw: string;
  ref?: string;
  label?: string;
  visibility?: ValueVisibility;
}

/** Link extraction item */
export interface LinkItem {
  ref: string;
  raw_text: string;
  href: string;
  visible: boolean;
  enabled: boolean;
}

/** Form field extraction item */
export interface FormField {
  ref: string;
  name: string;
  type: string;
  value: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  checked?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
}
