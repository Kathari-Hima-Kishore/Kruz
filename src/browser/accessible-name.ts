/**
 * The ONE accessible-name implementation.
 *
 * Accessible name is ELEMENT IDENTITY, not decoration. If the page observer and
 * the action-path matcher each compute it their own way, the same DOM node gets
 * two different logical identities depending on which subsystem looks at it —
 * and a ref minted by `page.observe` can then fail to re-resolve against the
 * very element it was minted from.
 *
 * That is not hypothetical. The two copies had drifted on five rules:
 *
 *   rule                 page.observe                 matcher
 *   -------------------  ---------------------------  --------------------------
 *   aria-labelledby      first id only                all ids, joined
 *   aria-label vs        aria-label won               aria-labelledby won
 *     aria-labelledby
 *   whitespace           .trim() only                 collapsed to single spaces
 *   text length cap      < 100 chars                  <= 200 chars
 *   <select> own text    EXCLUDED                     INCLUDED (option text)
 *
 * The last one is why a theme `<select>` was reported as unusable: the observer
 * named it "Theme\n Auto\n Light\n Dark" and the resolver named it "Theme", so
 * the fingerprint check rejected a genuinely identical node.
 *
 * Both producers embed THIS string rather than each carrying a copy, so they
 * cannot drift again. It is written as ES5-compatible function declarations
 * because it is injected verbatim into an in-page script — a serialised
 * TypeScript function breaks under transpilers that inject keepNames helpers.
 */

/**
 * Text of a label minus the text contributed by the labelled control itself.
 *
 * Without this, a wrapping `<label>Location<select>…</select></label>` reports
 * "LocationBangalore" and can never match a plain "Location" target.
 */
export const LABEL_TEXT_HELPER_SRC = String.raw`
function __kruzLabelOwnText(label) {
  var clone = label.cloneNode(true);
  var kill = clone.querySelectorAll("input, select, textarea, button, [contenteditable]");
  for (var i = 0; i < kill.length; i++) kill[i].remove();
  var t = (clone.textContent || "").replace(/\s+/g, " ").trim();
  if (t) return t;
  return (label.textContent || "").replace(/\s+/g, " ").trim();
}

function __kruzLabelText(el) {
  var id = el.getAttribute("id");
  if (id) {
    var esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
    var l = document.querySelector('label[for="' + esc + '"]');
    if (l) { var t = __kruzLabelOwnText(l); if (t) return t; }
  }
  var wrapping = el.closest ? el.closest("label") : null;
  if (wrapping) { var w = __kruzLabelOwnText(wrapping); if (w) return w; }
  return "";
}
`;

/**
 * The canonical name, ordered the way the accessibility tree orders it:
 * aria-labelledby → aria-label → label → title → placeholder → own text.
 *
 * A `<select>` is deliberately NOT named from its own text: its options are the
 * control's *value*, not its label, so "Auto / Light / Dark" is a description of
 * the choices rather than the name of the control.
 */
export const ACCESSIBLE_NAME_SRC = String.raw`
function __kruzAccessibleName(el) {
  var lb = el.getAttribute("aria-labelledby");
  if (lb) {
    var parts = lb.split(/\s+/).map(function (id) {
      var n = document.getElementById(id);
      return n ? (n.textContent || "") : "";
    }).filter(Boolean);
    var joined = parts.join(" ").replace(/\s+/g, " ").trim();
    if (joined) return { name: joined, source: "aria-labelledby" };
  }
  var al = el.getAttribute("aria-label");
  if (al && al.trim()) return { name: al.trim(), source: "aria-label" };
  var lt = __kruzLabelText(el);
  if (lt) return { name: lt, source: "label" };
  var title = el.getAttribute("title");
  if (title && title.trim()) return { name: title.trim(), source: "title" };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    var ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return { name: ph.trim(), source: "placeholder" };
  }
  var tag = el.tagName.toLowerCase();
  if (tag !== "select") {
    var own = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (own && own.length <= 200) return { name: own, source: "text" };
  }
  return { name: "", source: "none" };
}
`;

/** Both helpers, for embedding in one in-page program. */
export const ACCESSIBLE_NAME_BUNDLE_SRC = LABEL_TEXT_HELPER_SRC + ACCESSIBLE_NAME_SRC;
