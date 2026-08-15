/* ==========================================================================
   Prompt Librarian — h() and the DOM primitives
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports EVERY .js under WEB_DIRECTORY as an
   extension, so this file is loaded whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only. No
   fetches, no DOM writes, no listeners, no `app.registerExtension`.
   `web/prompt_librarian/index.js` is the single file allowed side effects.

   No build step. Vanilla ES module, served raw.
   ========================================================================== */

// Props routed to a property assignment rather than setAttribute, because the
// attribute form either does not exist or does not do what you want.
const DIRECT_PROPS = new Set([
  "value",
  "checked",
  "disabled",
  "selected",
  "textContent",
  "scrollTop",
  "scrollLeft",
  "tabIndex",
]);

/**
 * Create an element.
 *
 *   h("div", { className: "pl-row", dataset: { id }, onclick: fn }, "text", child)
 *
 * - `className`      → el.className
 * - `dataset`        → Object.assign(el.dataset, …)
 * - `style`          → object of camelCase properties, or a string
 * - `hidden`         → el.hidden = !!value   (falsy removes it entirely)
 * - `on*` functions  → addEventListener(name.slice(2), fn)
 *                      (`{ onclick: [fn, {capture:true}] }` passes options)
 * - `ref`            → called with the element, for wiring without a lookup
 * - null / undefined / false values are skipped
 * - everything else  → setAttribute(name, String(value))
 *
 * Children: strings/numbers become text nodes, Nodes are appended, arrays are
 * flattened, null/undefined/false are skipped.
 *
 * innerHTML is NEVER assigned, here or anywhere downstream. Prompt bodies,
 * names and tags are user data that round-trips through JSON; textContent is
 * both the XSS defence and (for the recycled virtual-list rows) the faster
 * path.
 *
 * @param {string} tag
 * @param {object|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (key === "hidden") {
        // Handled before the falsy skip below so `hidden: ""` / `hidden: 0`
        // mean "visible" rather than accidentally hiding the element.
        el.hidden = !!val;
        continue;
      }
      if (val == null || val === false) continue;
      if (key === "className" || key === "class") {
        el.className = String(val);
      } else if (key === "dataset") {
        for (const dk of Object.keys(val)) {
          if (val[dk] != null) el.dataset[dk] = String(val[dk]);
        }
      } else if (key === "style") {
        if (typeof val === "string") el.setAttribute("style", val);
        else for (const sk of Object.keys(val)) el.style[sk] = val[sk];
      } else if (key === "ref") {
        if (typeof val === "function") val(el);
      } else if (key.length > 2 && key.startsWith("on") && (typeof val === "function" || Array.isArray(val))) {
        const type = key.slice(2);
        if (Array.isArray(val)) el.addEventListener(type, val[0], val[1]);
        else el.addEventListener(type, val);
      } else if (DIRECT_PROPS.has(key)) {
        el[key] = val;
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  append(el, children);
  return el;
}

/**
 * Props that opt a text field out of password-manager autofill. Spread into
 * any h("input", …) that takes a free-text value:
 *
 *   h("input", { className: "pl-input", type: "text", ...NO_AUTOFILL, … })
 *
 * `autocomplete: "off"` alone does not work — every major manager ignores it
 * on principle, so each one gets its own opt-out attribute. Dashlane is the
 * one that matters here: a lone text input next to a textarea reads as a
 * credential field to it, and it overlays its icon on top of the field.
 *
 * `data-1p-ignore` is "" rather than null/false because h() skips those.
 */
export const NO_AUTOFILL = {
  autocomplete: "off",
  "data-form-type": "other", // Dashlane
  "data-lpignore": "true", // LastPass
  "data-1p-ignore": "", // 1Password 8
  "data-bwignore": "true", // Bitwarden
  "data-protonpass-ignore": "true", // Proton Pass
};

/**
 * Append children to a node. Strings become text nodes; arrays flatten.
 * @param {Node} el
 * @param {any} kids
 * @returns {Node} el
 */
export function append(el, kids) {
  if (kids == null || kids === false) return el;
  if (Array.isArray(kids)) {
    for (const k of kids) append(el, k);
    return el;
  }
  if (kids instanceof Node) el.appendChild(kids);
  else el.appendChild(document.createTextNode(String(kids)));
  return el;
}

/**
 * Remove every child of a node. `textContent = ""` is the fastest correct way
 * (it does not parse, unlike innerHTML = "").
 * @param {Node} el
 * @returns {Node} el
 */
export function clear(el) {
  if (el) el.textContent = "";
  return el;
}

/**
 * Toggle a class without the `force` argument's browser-version caveats.
 * @param {Element} el
 * @param {string} cls
 * @param {boolean} on
 */
export function cls(el, cls_, on) {
  if (!el) return;
  if (on) el.classList.add(cls_);
  else el.classList.remove(cls_);
}
