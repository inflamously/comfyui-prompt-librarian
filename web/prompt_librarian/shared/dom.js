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

/** Create DOM nodes without interpreting user text as HTML.
 * Supports property/event props, nested child arrays, and a ref callback.
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

/** Password managers may ignore autocomplete=off; use their explicit opt-outs.
 * data-1p-ignore must be an empty string because h() skips null/false.
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

/** @param {Node} el
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
