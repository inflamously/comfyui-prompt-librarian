/* ==========================================================================
   Prompt Librarian — DOM + formatting helpers
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports EVERY .js file under WEB_DIRECTORY as an
   extension, so this file is loaded whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only. No
   fetches, no DOM writes, no listeners, no `app.registerExtension`.
   `web/pl_librarian.js` is the single file allowed to have side effects.

   No build step. Vanilla ES module, served raw.
   ========================================================================== */

export const NS = "[prompt-librarian]";

/* --------------------------------------------------------------------------
   h() — hyperscript
   -------------------------------------------------------------------------- */

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
 *   h("input", { className: "pl-name", type: "text", ...NO_AUTOFILL, … })
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

/* --------------------------------------------------------------------------
   Stylesheet injection
   -------------------------------------------------------------------------- */

export const CSS_LINK_ID = "pl-librarian-css";

/**
 * Idempotently inject <link id="pl-librarian-css"> for librarian.css.
 *
 * The href is derived from `import.meta.url` rather than hard-coded, because
 * the absolute URL of this package's web assets is not knowable from source:
 *
 *  - ComfyUI mounts WEB_DIRECTORY at `/extensions/<sanitised-package-name>/`.
 *    The sanitisation rules (case, separators, whether the `comfyui-` prefix
 *    survives, whether the directory or the pyproject name wins) differ
 *    between frontend versions. `/extensions/comfyui-prompt-library/` is a
 *    guess; `import.meta.url` is the answer the browser already resolved.
 *  - A reverse proxy may mount ComfyUI under a path prefix (`/comfy/`), which
 *    a root-relative href would miss.
 *  - ComfyUI appends a cache-busting `?v=<hash>` query to extension module
 *    URLs. `new URL("./librarian.css", import.meta.url)` resolves against the
 *    path only and drops that query, so the CSS URL stays stable while the
 *    module URL churns — which also means the browser caches the CSS.
 *
 * @returns {HTMLLinkElement|null} the link element, or null with no document
 */
export function ensureStyles() {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(CSS_LINK_ID);
  if (existing) return existing;

  let href;
  try {
    href = new URL("./librarian.css", import.meta.url).href;
  } catch (err) {
    console.error(`${NS} could not resolve librarian.css URL`, err);
    return null;
  }

  const link = document.createElement("link");
  link.id = CSS_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;
  // Log the RESOLVED url, not the relative one — if the mount point guess is
  // wrong this message is the entire diagnosis.
  link.addEventListener("error", () => {
    console.error(`${NS} failed to load stylesheet: ${href}`);
  });
  (document.head || document.documentElement).appendChild(link);
  return link;
}

/* --------------------------------------------------------------------------
   Timing
   -------------------------------------------------------------------------- */

/**
 * Debounce with `.cancel()` and `.flush()`.
 *
 * `leading: true` invokes on the first call of a burst and suppresses the
 * trailing call for that burst (used for "immediate when cleared" search).
 * `.flush()` runs a pending trailing call right now and returns its result;
 * `.cancel()` drops it. Both are no-ops when nothing is pending.
 *
 * @param {Function} fn
 * @param {number} ms
 * @param {{leading?: boolean}} [opts]
 * @returns {Function & {cancel: () => void, flush: () => any, pending: () => boolean}}
 */
export function debounce(fn, ms, opts = {}) {
  const leading = !!opts.leading;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  let result;

  function invoke() {
    const args = lastArgs;
    const ctx = lastThis;
    lastArgs = null;
    lastThis = null;
    result = fn.apply(ctx, args || []);
    return result;
  }

  function wrapped(...args) {
    lastArgs = args;
    lastThis = this;
    const callNow = leading && timer === null;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs !== null) invoke();
    }, ms);
    if (callNow) return invoke();
    return result;
  }

  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastThis = null;
  };

  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs !== null) return invoke();
    return result;
  };

  wrapped.pending = () => timer !== null;

  return wrapped;
}

/**
 * rAF-coalesced callback — many calls per frame collapse to one, arguments
 * from the last call win. Used for scroll handling in the virtual list.
 * @param {Function} fn
 * @returns {Function & {cancel: () => void}}
 */
export function rafThrottle(fn) {
  let handle = 0;
  let lastArgs = null;
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
  const caf =
    typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;

  function wrapped(...args) {
    lastArgs = args;
    if (handle) return;
    handle = raf(() => {
      handle = 0;
      const a = lastArgs;
      lastArgs = null;
      fn(...(a || []));
    });
  }
  wrapped.cancel = () => {
    if (handle) caf(handle);
    handle = 0;
    lastArgs = null;
  };
  return wrapped;
}

/* --------------------------------------------------------------------------
   LiteGraph widget helpers
   -------------------------------------------------------------------------- */

/**
 * Update a combo widget's option list. Handles both LiteGraph (options IS the
 * array) and the newer ComfyUI Vue frontend (options.values, needs
 * reassignment not splice for reactivity).
 *
 * Copied in behaviour from web/prompt_library.js on purpose — it is NOT
 * imported from there. The two node packs must stay independently deletable:
 * a user removing the old node's file must not break the Librarian, and vice
 * versa. The only difference is that the empty-list sentinel is a parameter
 * here instead of a module constant.
 *
 * @param {object} widget
 * @param {string[]} values
 * @param {string} [emptyLabel="<empty>"]
 */
export function setComboValues(widget, values, emptyLabel = "<empty>") {
  if (!widget) return;
  const list = values && values.length ? values : [emptyLabel];
  if (Array.isArray(widget.options)) {
    // LiteGraph legacy: options is the values array directly
    widget.options.splice(0, Infinity, ...list);
  } else {
    if (!widget.options) widget.options = {};
    // Direct assignment (not splice) to trigger Vue reactivity if present
    widget.options.values = list.slice();
  }
  if (!list.includes(widget.value)) widget.value = list[0];
}

/* --------------------------------------------------------------------------
   Text — all of it grapheme/code-point safe
   -------------------------------------------------------------------------- */

// Intl.Segmenter gives real user-perceived character counts (a flag emoji is
// one grapheme built from two code points; "é" may be two). It is not in every
// engine ComfyUI might run in, so every use is behind a probe with an
// Array.from fallback (code points — still never splits a surrogate pair).
const SEGMENTER = (() => {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return new Intl.Segmenter(undefined, { granularity: "grapheme" });
    }
  } catch (_) {
    /* fall through */
  }
  return null;
})();

/**
 * Split a string into grapheme clusters when possible, code points otherwise.
 * NEVER `str.split("")` — that splits surrogate pairs and mangles emoji.
 * @param {string} str
 * @returns {string[]}
 */
export function graphemes(str) {
  const s = str == null ? "" : String(str);
  if (!s) return [];
  if (SEGMENTER) {
    const out = [];
    for (const seg of SEGMENTER.segment(s)) out.push(seg.segment);
    return out;
  }
  return Array.from(s);
}

/**
 * Character count in user-perceived characters (graphemes) when Intl.Segmenter
 * exists, code points otherwise. Deliberately NOT `str.length`, which counts
 * UTF-16 code units and reports "🎬" as 2.
 * @param {string} str
 * @returns {number}
 */
export function charCount(str) {
  const s = str == null ? "" : String(str);
  if (!s) return 0;
  if (SEGMENTER) {
    let n = 0;
    for (const _ of SEGMENTER.segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

/**
 * Truncate to `n` characters, appending "…" when it actually cut something.
 * Slices grapheme/code-point units, never UTF-16 units, so an emoji at the cut
 * boundary is kept or dropped whole and never rendered as a lone surrogate.
 * @param {string} str
 * @param {number} n
 * @param {string} [ellipsis="…"]
 * @returns {string}
 */
export function truncate(str, n, ellipsis = "…") {
  const s = str == null ? "" : String(str);
  if (!(n > 0)) return "";
  const units = graphemes(s);
  if (units.length <= n) return s;
  return units.slice(0, n).join("") + ellipsis;
}

/**
 * Collapse a body to a single line: newlines and runs of whitespace become one
 * space, then optionally truncate. Used for node-face and row previews.
 * @param {string} str
 * @param {number} [n] optional character cap
 * @returns {string}
 */
export function firstLine(str, n) {
  const s = (str == null ? "" : String(str)).replace(/\s+/g, " ").trim();
  if (!n) return s;
  return truncate(s, n);
}

/**
 * Rough token count for the UI's `~61 tokens` readout.
 *
 * THIS IS AN ESTIMATE, NOT A TOKENIZER. No tokenizer is guaranteed available
 * in ComfyUI's browser environment, and the answer depends on which model the
 * text is destined for (CLIP, T5, a video model's own vocab) — a single true
 * number does not exist. The UI must therefore always render this with a `~`
 * prefix; showing it bare would be dishonest precision.
 *
 * Heuristic: whitespace words cost 1 token each plus 1 extra per 6 characters
 * beyond the 6th (long/compound words split), punctuation runs cost 1 each,
 * and CJK characters cost ~1 token apiece since they do not use spaces. That
 * lands within roughly ±15% of BPE counts on prompt-shaped English text,
 * which is all the readout needs.
 *
 * @param {string} str
 * @returns {number}
 */
export function estimateTokens(str) {
  const s = str == null ? "" : String(str);
  if (!s.trim()) return 0;

  // CJK / Hangul / Kana are counted per character. Written as \u escapes so
  // the heuristic survives being served with a wrong charset header.
  const CJK = new RegExp("[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]", "gu");
  const cjk = (s.match(CJK) || []).length;
  const rest = s.replace(CJK, " ");

  let n = 0;
  for (const word of rest.split(/\s+/)) {
    if (!word) continue;
    const letters = word.replace(/[^\p{L}\p{N}]/gu, "");
    const punct = word.length - letters.length;
    if (letters) n += 1 + Math.floor(Math.max(0, letters.length - 6) / 6);
    n += Math.min(punct, 3); // "..." style runs collapse
  }
  return n + cjk;
}

// Built from code points rather than pasted glyphs so they survive this file
// being served with a wrong or absent charset header.
export const STAR_FULL = String.fromCharCode(0x2605); // BLACK STAR
export const STAR_EMPTY = String.fromCharCode(0x2606); // WHITE STAR

/**
 * Rating → "★★★★☆" (U+2605 filled, U+2606 hollow). Text, never an icon font.
 * @param {number} rating 0..5, clamped, rounded
 * @param {number} [max=5]
 * @returns {string}
 */
export function stars(rating, max = 5) {
  const r = Math.max(0, Math.min(max, Math.round(Number(rating) || 0)));
  return STAR_FULL.repeat(r) + STAR_EMPTY.repeat(max - r);
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Relative time in the spec's meta-line style: "just now", "5m", "3h", "2d",
 * then an absolute "Mar 4" past a week, plus the year past ~11 months.
 * Returns "" for missing/unparseable input — a meta line with a blank slot is
 * always better than "Invalid Date".
 * @param {string} iso ISO-8601 (the store writes "…Z")
 * @param {Date|number} [now]
 * @returns {string}
 */
export function relTime(iso, now) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  const d = new Date(t);
  let secs = Math.floor((nowMs - t) / 1000);

  if (secs < 0) secs = 0; // clock skew between server and browser
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d`;

  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (secs > 330 * 86400) return `${label}, ${d.getFullYear()}`;
  return label;
}

// U+2009 THIN SPACE, spelled out because an invisible literal in source is a
// trap for the next reader (and for grep). A regular space would also let the
// number wrap across two lines mid-value; a thin space will not.
export const THIN_SPACE = String.fromCharCode(0x2009);

/**
 * Integer with thin-space grouping, as in the spec header ("1 284 prompts").
 * @param {number} n
 * @param {string} [sep=THIN_SPACE]
 * @returns {string}
 */
export function fmtInt(n, sep = THIN_SPACE) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  const neg = v < 0;
  const digits = String(Math.floor(Math.abs(v)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return neg ? "-" + out : out;
}

/**
 * Build a URLSearchParams-safe query string from a plain object.
 * Skips null/undefined/"" values, joins arrays with "," (the API's list form),
 * and renders booleans as "true"/"false". Returns "" (not "?") when empty, so
 * callers can write `path + escapeQuery(o)`.
 * @param {object} obj
 * @returns {string}
 */
export function escapeQuery(obj) {
  if (!obj) return "";
  const p = new URLSearchParams();
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      p.append(key, v.join(","));
    } else if (typeof v === "boolean") {
      p.append(key, v ? "true" : "false");
    } else {
      p.append(key, String(v));
    }
  }
  const s = p.toString();
  return s ? "?" + s : "";
}

/* --------------------------------------------------------------------------
   Cross-module singleton
   -------------------------------------------------------------------------- */

const GLOBAL_KEY = "__PROMPT_LIBRARIAN__";

/**
 * Get-or-create a process-wide singleton, stored on `window`.
 *
 * MODULE SCOPE IS NOT A SAFE SINGLETON HERE. ComfyUI cache-busts extension
 * module URLs with a `?v=…` query, and the module registry is keyed on the
 * FULL url — so `pl/modal.js?v=1` and `pl/modal.js?v=2` (or the extension
 * scanner's copy versus an `import()` of ours) are two separate module
 * instances with two separate sets of module-level `let`s. A `let modalRoot`
 * would then produce two modals, two keydown guards and two toast stacks.
 * Anything that must be unique on the page — the modal root, the meta cache,
 * the request lanes, the host injection — goes through here instead.
 *
 * @template T
 * @param {string} key
 * @param {() => T} factory called at most once per key
 * @returns {T}
 */
export function singleton(key, factory) {
  const g = typeof window !== "undefined" ? window : globalThis;
  let bag = g[GLOBAL_KEY];
  if (!bag || typeof bag !== "object") {
    bag = Object.create(null);
    g[GLOBAL_KEY] = bag;
  }
  if (!(key in bag)) bag[key] = factory();
  return bag[key];
}

/**
 * Read the singleton bag without creating an entry. Useful for teardown paths
 * that must not resurrect what they are tearing down.
 * @returns {object}
 */
export function singletonBag() {
  const g = typeof window !== "undefined" ? window : globalThis;
  if (!g[GLOBAL_KEY] || typeof g[GLOBAL_KEY] !== "object") g[GLOBAL_KEY] = Object.create(null);
  return g[GLOBAL_KEY];
}

/**
 * Log a message at most once per key, for the "your frontend lacks X" class of
 * warning that would otherwise fire on every node or every keystroke.
 * @param {string} key
 * @param {...any} args
 */
export function warnOnce(key, ...args) {
  const seen = singleton("warnOnce", () => new Set());
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(NS, ...args);
}
