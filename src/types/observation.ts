// ── Observation types ────────────────────────────────────────────────────────

/** A compact element reference in an observation */
export interface ObservedElement {
  ref: string; // e.g. "e17"
  role: string; // ARIA role
  name: string; // accessible name
  value?: string; // current value (for inputs, selects)
  enabled?: boolean;
  href?: string; // for links
  checked?: boolean; // for checkboxes/radios
  selected?: boolean; // for selected options
  readonly?: boolean;
  required?: boolean;
  type?: string; // input type
}

/** A compact text node in an observation */
export interface ObservedText {
  ref: string; // e.g. "t4"
  text: string;
}

/** Full compact observation of a page */
export interface Observation {
  page_id: string;
  url: string;
  title: string;
  revision: number;
  scope: string;
  elements: ObservedElement[];
  text: ObservedText[];
  changed: string[]; // refs that changed since last observation
  detail: "minimal" | "standard" | "full";
}

/** Delta observation (only changes) */
export interface ObservationDelta {
  page_id: string;
  url: string;
  revision: number;
  detail: "minimal" | "standard" | "full";
  changed: ChangedItem[];
}

export interface ChangedItem {
  ref: string;
  type: "element" | "text";
  current: ObservedElement | ObservedText;
  previous?: ObservedElement | ObservedText;
}

/** Observation cache key */
export interface ObservationCacheKey {
  page_id: string;
  url: string;
  revision: number;
  scope: string;
  detail: string;
}
