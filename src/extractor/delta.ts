import type {
  Observation,
  ObservationDelta,
  ChangedItem,
  ObservedElement,
  ObservedText,
} from "../types/observation.js";

/**
 * Detect changes between two observations and produce a compact delta.
 */
export function detectDelta(
  previous: Observation | null,
  current: Observation
): ObservationDelta {
  const changed: ChangedItem[] = [];

  if (!previous) {
    // First observation — everything is "changed"
    for (const el of current.elements) {
      changed.push({ ref: el.ref, type: "element", current: el });
    }
    for (const t of current.text) {
      changed.push({ ref: t.ref, type: "text", current: t });
    }
  } else {
    // Build maps from previous observation
    const prevElements = new Map<string, ObservedElement>();
    for (const el of previous.elements) {
      prevElements.set(el.ref, el);
    }
    const prevText = new Map<string, ObservedText>();
    for (const t of previous.text) {
      prevText.set(t.ref, t);
    }

    // Check current elements against previous
    for (const el of current.elements) {
      const prev = prevElements.get(el.ref);
      if (!prev || !elementsEqual(prev, el)) {
        changed.push({ ref: el.ref, type: "element", current: el, previous: prev });
      }
    }

    // Check current text against previous
    for (const t of current.text) {
      const prev = prevText.get(t.ref);
      if (!prev || prev.text !== t.text) {
        changed.push({ ref: t.ref, type: "text", current: t, previous: prev });
      }
    }

    // Check for removed elements
    for (const [ref] of prevElements) {
      if (!current.elements.find((e) => e.ref === ref)) {
        changed.push({
          ref,
          type: "element",
          current: { ref, role: "removed", name: "" },
          previous: prevElements.get(ref),
        });
      }
    }

    for (const [ref] of prevText) {
      if (!current.text.find((t) => t.ref === ref)) {
        changed.push({
          ref,
          type: "text",
          current: { ref, text: "" },
          previous: prevText.get(ref),
        });
      }
    }
  }

  return {
    page_id: current.page_id,
    url: current.url,
    revision: current.revision,
    detail: current.detail,
    changed,
  };
}

function elementsEqual(a: ObservedElement, b: ObservedElement): boolean {
  return (
    a.ref === b.ref &&
    a.role === b.role &&
    a.name === b.name &&
    a.value === b.value &&
    a.enabled === b.enabled &&
    a.href === b.href &&
    a.checked === b.checked &&
    a.selected === b.selected
  );
}

/**
 * Check if two observations are identical.
 */
export function observationsEqual(a: Observation, b: Observation): boolean {
  if (a.revision !== b.revision) return false;
  if (a.elements.length !== b.elements.length) return false;
  if (a.text.length !== b.text.length) return false;

  for (let i = 0; i < a.elements.length; i++) {
    if (!elementsEqual(a.elements[i], b.elements[i])) return false;
  }
  for (let i = 0; i < a.text.length; i++) {
    if (a.text[i].text !== b.text[i].text) return false;
  }

  return true;
}
