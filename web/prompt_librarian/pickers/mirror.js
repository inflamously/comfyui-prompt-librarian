/* is-mirrored makes the textarea transparent. If wrapped heights disagree
 * by more than 4 px, remove the mirror and class so native text stays readable.
 */

import { clear, cls, h } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { debounce } from "../shared/timing.js";
import { ZWSP, isFn } from "./common.js";
import { TOK_CLASS, tokenizeWildcards } from "./tokenize.js";

const MIRROR_MAX_CHARS = 20000; // above this the mirror is disabled entirely
const MIRROR_DEBOUNCE_MS = 60;
const MIRROR_SLOP_PX = 4; // self-check tolerance; beyond it the mirror dies
const VALIDATE_DEBOUNCE_MS = 300;

// Copy computed metrics so theme overrides cannot change line wrapping on one
// side only.
const COPY_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "wordWrap",
  "tabSize",
  "direction",
];

/**
 * @param {HTMLElement} wrap   `.pl-ta-wrap`
 * @param {HTMLTextAreaElement} ta `.pl-ta`
 * @param {{validate?: (names: string[]) => (string[]|Promise<string[]>),
 *          ctx?: object, debounceMs?: number}} [opts]
 *        `validate` receives the wildcard FILE names used in the text and
 *        returns the subset that is MISSING. When omitted and `opts.ctx` is
 *        given, one is built from `ctx.API.wildcards()` → `{names, dir,
 *        signature}` and the comparison is done client-side (there is no
 *        validate endpoint).
 * @returns {{detach: () => void, refresh: () => void, active: () => boolean}}
 */
export function attachMirror(wrap, ta, opts = {}) {
  const noop = { detach() {}, refresh() {}, active: () => false };
  if (!wrap || !ta || typeof document === "undefined") return noop;

  let mirror = isFn(wrap.querySelector) ? wrap.querySelector(".pl-ta-mirror") : null;
  const createdMirror = !mirror;
  if (!mirror) {
    mirror = h("div", { className: "pl-ta-mirror", "aria-hidden": "true" });
    if (ta.parentNode === wrap) wrap.insertBefore(mirror, ta);
    else wrap.appendChild(mirror);
  }

  let dead = false;
  let activeNow = false;
  let checked = false;
  const missing = new Set(); // normalized wildcard names known to be absent
  let lastNamesKey = "";


  function syncStyles() {
    if (typeof getComputedStyle !== "function") return;
    let cs;
    try {
      cs = getComputedStyle(ta);
    } catch (_) {
      return;
    }
    if (!cs) return;
    for (const prop of COPY_STYLES) {
      const v = cs[prop];
      if (v != null && v !== "") {
        try {
          mirror.style[prop] = v;
        } catch (_) {
          /* unknown property in this engine */
        }
      }
    }
    // `clientWidth` excludes the textarea's scrollbar; without this the mirror
    // is wider than the text it is mirroring and every wrapped line drifts.
    const w = ta.clientWidth;
    if (w) mirror.style.width = `${w}px`;
  }


  function render() {
    if (dead) return;
    const text = String(ta.value == null ? "" : ta.value);

    // Skip large bodies to bound per-keystroke tokenization and DOM work.
    if (text.length > MIRROR_MAX_CHARS) {
      if (activeNow || mirror.firstChild) {
        clear(mirror);
        cls(wrap, "is-mirrored", false);
        activeNow = false;
      }
      return;
    }

    clear(mirror);
    const tokens = tokenizeWildcards(text);
    let at = 0;
    for (const tok of tokens) {
      if (tok.start > at) mirror.appendChild(document.createTextNode(text.slice(at, tok.start)));
      const cssClass = TOK_CLASS[tok.kind] || TOK_CLASS.brace;
      const span = h("span", { className: cssClass }, text.slice(tok.start, tok.end));
      if (tok.kind === "file" && missing.has(tok.name)) markMissing(span);
      mirror.appendChild(span);
      at = tok.end;
    }
    if (at < text.length) mirror.appendChild(document.createTextNode(text.slice(at)));
    // A textarea renders a trailing newline as an empty final line; a div does
    // not. The zero-width space restores the line box so the heights agree.
    if (!text || text.charAt(text.length - 1) === "\n") {
      mirror.appendChild(document.createTextNode(ZWSP));
    }

    syncScroll();
    scheduleValidate(tokens);
    if (!checked) scheduleSelfCheck();
    else if (!activeNow && !dead) {
      cls(wrap, "is-mirrored", true);
      activeNow = true;
    }
  }

  /** Keep inline missing-token styles as a fallback when stylesheet rules are unavailable.
   */
  function markMissing(span) {
    span.classList.add("is-missing");
    span.style.color = "var(--pl-warn)";
    span.style.textDecoration = "underline wavy";
  }


  function syncScroll() {
    if (dead) return;
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  }


  const raf =
    typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);

  function scheduleSelfCheck() {
    raf(() => {
      if (dead || checked) return;
      checked = true;
      const a = Number(mirror.scrollHeight) || 0;
      const b = Number(ta.scrollHeight) || 0;
      if (a && b && Math.abs(a - b) > MIRROR_SLOP_PX) {
        warnOnce(
          "mirror-selfcheck",
          `syntax highlighting disabled: the mirror (${a}px) and the textarea (${b}px) ` +
            "lay text out differently, so highlights would be misplaced."
        );
        detach();
        return;
      }
      cls(wrap, "is-mirrored", true);
      activeNow = true;
    });
  }


  function defaultValidate(names) {
    const ctx = opts.ctx;
    if (!(ctx && ctx.API && isFn(ctx.API.wildcards))) return [];
    return Promise.resolve(ctx.API.wildcards()).then((data) => {
      const known = new Set(
        (data && Array.isArray(data.names) ? data.names : []).map((n) => String(n))
      );
      // The store lists names without the `.txt` suffix; accept either shape.
      return names.filter((n) => !known.has(n) && !known.has(n + ".txt") && !known.has(n.replace(/\.txt$/, "")));
    });
  }

  const runValidate = debounce((names) => {
    if (dead || !names.length) return;
    const key = names.join("|");
    if (key === lastNamesKey) return;
    lastNamesKey = key;
    const fn = isFn(opts.validate) ? opts.validate : defaultValidate;
    let out;
    try {
      out = fn(names.slice());
    } catch (err) {
      return;
    }
    Promise.resolve(out)
      .then((bad) => {
        if (dead) return;
        const set = new Set((Array.isArray(bad) ? bad : []).map((n) => String(n)));
        let changed = set.size !== missing.size;
        if (!changed) for (const n of set) if (!missing.has(n)) changed = true;
        if (!changed) return;
        missing.clear();
        for (const n of set) missing.add(n);
        render();
      })
      .catch(() => {
        /* validation is advisory; an unreachable backend just means no marks */
      });
  }, VALIDATE_DEBOUNCE_MS);

  function scheduleValidate(tokens) {
    const names = [];
    const seen = new Set();
    for (const t of tokens) {
      if (t.kind !== "file" || seen.has(t.name)) continue;
      seen.add(t.name);
      names.push(t.name);
    }
    if (names.length) runValidate(names);
  }


  const reRender = debounce(render, typeof opts.debounceMs === "number" ? opts.debounceMs : MIRROR_DEBOUNCE_MS);
  const onInput = () => reRender();
  const onScroll = () => syncScroll();

  ta.addEventListener("input", onInput);
  ta.addEventListener("scroll", onScroll);

  let ro = null;
  if (typeof ResizeObserver === "function") {
    try {
      ro = new ResizeObserver(() => {
        if (dead) return;
        syncStyles();
        syncScroll();
      });
      ro.observe(ta);
    } catch (_) {
      ro = null;
    }
  }

  function detach() {
    if (dead) return;
    dead = true;
    activeNow = false;
    try {
      reRender.cancel();
      runValidate.cancel();
    } catch (_) {
    }
    ta.removeEventListener("input", onInput);
    ta.removeEventListener("scroll", onScroll);
    if (ro) {
      try {
        ro.disconnect();
      } catch (_) {
      }
      ro = null;
    }
    // Remove transparency before clearing the mirror so text stays readable.
    cls(wrap, "is-mirrored", false);
    clear(mirror);
    for (const prop of COPY_STYLES) {
      try {
        mirror.style[prop] = "";
      } catch (_) {
      }
    }
    try {
      mirror.style.width = "";
    } catch (_) {
    }
    if (createdMirror && mirror.parentNode) {
      try {
        mirror.parentNode.removeChild(mirror);
      } catch (_) {
      }
    }
  }

  syncStyles();
  render();

  return {
    detach,
    refresh() {
      if (dead) return;
      try {
        reRender.cancel();
      } catch (_) {
      }
      syncStyles();
      render();
    },
    active: () => activeNow && !dead,
  };
}
