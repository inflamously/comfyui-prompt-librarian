/* ==========================================================================
   Prompt Librarian — popover primitive, pickers, and the highlighting mirror
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only.

   One primitive — openPopover() — serves five consumers: category, tags,
   threshold, snippets and wildcards. Plus insertAtCaret(), the wildcard
   tokenizer, and attachMirror() (syntax highlighting behind the textarea).

   ==========================================================================
   KEYBOARD: THE ONE THING THAT MUST NOT BE GOT WRONG
   --------------------------------------------------------------------------
   modal.js installs a window-CAPTURE guard that calls stopImmediatePropagation()
   on every keydown/keyup/keypress originating inside `.pl-root`. The event
   therefore NEVER reaches our subtree, and

       el.addEventListener("keydown", fn)     // <-- DEAD CODE inside the modal

   will never fire. There is no such listener anywhere in this file, and adding
   one would silently break every picker's arrow-key navigation.

   Keys arrive by exactly two supported routes, both used by bindKeys() below:
     1. `ctx.onKey(el, "keydown", fn)` — modal.js re-delivers the ORIGINAL
        event along the path from e.target up to `.pl-root`, honouring
        capture/bubble order, stopPropagation() and preventDefault().
     2. the namespaced mirror CustomEvent `"pl:keydown"`, whose
        `detail.event` is the original. Used only when no ctx is available.

   Escape is handled on the popover element itself and calls stopPropagation()
   so modal.js's root-level Escape handler does not ALSO pop a layer — that
   would close the popover and then the modal.
   ========================================================================== */

import { NS, NO_AUTOFILL, clear, cls, debounce, firstLine, h, truncate, warnOnce } from "./dom.js";

/* --------------------------------------------------------------------------
   Constants
   -------------------------------------------------------------------------- */

const GAP = 6; // px between the anchor and the popover
const EDGE = 8; // px minimum distance to any viewport edge
const MIN_FLIP_ROOM = 96; // never flip into a slot smaller than this

const THRESHOLDS = [0.8, 0.85, 0.9, 0.95, 0.99];

const MIRROR_MAX_CHARS = 20000; // above this the mirror is disabled entirely
const MIRROR_DEBOUNCE_MS = 60;
const MIRROR_SLOP_PX = 4; // self-check tolerance; beyond it the mirror dies
const VALIDATE_DEBOUNCE_MS = 300;

const MAX_TAG_CHARS = 40; // librarian_store.MAX_TAG_CHARS
const SAMPLE_CHARS = 260; // wildcard preview truncation
const MAX_TOKENS = 4000; // tokenizer safety cap

// Glyphs built from code points so they survive a wrong/absent charset header.
const CHECK = String.fromCharCode(0x2713); // ✓
const MIDDOT = String.fromCharCode(0x00b7); // ·
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const PLUS = "+";

/**
 * The wildcard/snippet token grammar, as a source string rather than a literal
 * so every call builds a FRESH RegExp — a module-level /g regex carries
 * `lastIndex` between calls and would skip tokens on the second call.
 *
 *   {a|b}          brace choice
 *   __file__       wildcard file, `__sub/dir/name__` allowed
 *   [[snippet]]    stored snippet reference
 *
 * Deliberately aligned with librarian_wildcards.py, because a highlight that
 * disagrees with the resolver is worse than no highlight:
 *
 *   _FILE_RE    = re.compile(r"__([\w\-./\\]+?)__", re.UNICODE)
 *   _SNIPPET_RE = re.compile(r"\[\[([^\[\]]*)\]\]")
 *   _BRACE_RE   = re.compile(r"\{([^{}]*)\}")
 *
 * The file alternative is NON-GREEDY for the same reason the backend's is:
 * `__a____b__` is two wildcards, not one called "a____b". `\p{L}\p{N}_` is the
 * `u`-mode equivalent of Python's unicode `\w` (JS `\w` is ASCII-only), so a
 * `__照明__` wildcard highlights like every other one.
 *
 * The one divergence: both bracketed forms refuse to cross a newline, where the
 * backend's do not. A stray `{` would otherwise paint everything up to the next
 * `}` — possibly the rest of the prompt — as a choice. Under-highlighting a
 * multi-line construct is the safe direction to be wrong in.
 */
const WC_SOURCE =
  "\\{[^{}\\n]*\\}|__[\\p{L}\\p{N}_\\-.\\/\\\\]+?__|\\[\\[[^\\[\\]\\n]*\\]\\]";
const WC_FLAGS = "gu";

/**
 * Mirror token classes. `.pl-tok-wild` and `.pl-tok-snip` are the classes
 * librarian.css actually ships (scoped as `.pl-ta-mirror .pl-tok-*`); the
 * `.pl-wc-brace` / `.pl-wc-file` names from the plan do not exist in the
 * stylesheet, and inventing them would produce unstyled spans.
 */
const TOK_CLASS = {
  brace: "pl-tok-wild",
  file: "pl-tok-wild",
  snippet: "pl-tok-snip",
};

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */

function isFn(v) {
  return typeof v === "function";
}

function toast(ctx, message, kind) {
  if (ctx && isFn(ctx.toast)) {
    try {
      ctx.toast(message, { kind: kind || "info" });
      return;
    } catch (_) {
      /* fall through to the console */
    }
  }
  console.info(`${NS} ${message}`);
}

function viewport() {
  const docEl = typeof document !== "undefined" ? document.documentElement : null;
  const vw =
    (typeof window !== "undefined" && window.innerWidth) || (docEl && docEl.clientWidth) || 1280;
  const vh =
    (typeof window !== "undefined" && window.innerHeight) || (docEl && docEl.clientHeight) || 800;
  return { vw, vh };
}

/** Rendered size of an element, preferring the box the browser actually laid out. */
function measure(el) {
  let w = 0;
  let ht = 0;
  if (el && isFn(el.getBoundingClientRect)) {
    const r = el.getBoundingClientRect();
    if (r) {
      w = r.width || 0;
      ht = r.height || 0;
    }
  }
  if (!w) w = (el && el.offsetWidth) || 220;
  if (!ht) ht = (el && el.offsetHeight) || 160;
  return { w, h: ht };
}

/**
 * Bind a key handler the only two ways that work inside the modal.
 * NEVER addEventListener("keydown", …) — see the block comment at the top.
 * @returns {() => void} unbind
 */
function bindKeys(ctx, el, handler) {
  if (ctx && isFn(ctx.onKey)) {
    try {
      const off = ctx.onKey(el, "keydown", handler);
      if (isFn(off)) return off;
      return () => {};
    } catch (_) {
      /* fall through to the mirrored CustomEvent */
    }
  }
  if (!el || !isFn(el.addEventListener)) return () => {};
  const onMirror = (ev) => {
    const orig = (ev && ev.detail && ev.detail.event) || ev;
    handler(orig);
  };
  // "pl:keydown", NOT "keydown": modal.js dispatches this bubbling mirror after
  // the capture guard has already eaten the real event.
  el.addEventListener("pl:keydown", onMirror);
  return () => el.removeEventListener("pl:keydown", onMirror);
}

/**
 * Where a popover mounts.
 *
 * `.pl-layers` is a child of `.pl-root` and a SIBLING of `.pl-card`. That is
 * load-bearing, not cosmetic: `.pl-card` sets `contain: layout paint`, which
 * makes it a containing block for `position: fixed` descendants — a popover
 * positioned from getBoundingClientRect() would be offset by the card's
 * origin. Mounting inside `.pl-card` is therefore refused outright.
 */
function mountTarget(ctx) {
  let node = null;
  if (ctx && ctx.els && ctx.els.layers) node = ctx.els.layers;
  if (!node && ctx && ctx.root && isFn(ctx.root.querySelector)) {
    node = ctx.root.querySelector(".pl-layers");
  }
  if (!node && typeof document !== "undefined" && isFn(document.querySelector)) {
    node = document.querySelector(".pl-root .pl-layers");
  }
  if (node && isFn(node.closest) && node.closest(".pl-card")) {
    warnOnce("popover-in-card", ".pl-layers resolved inside .pl-card; popovers would be offset");
    node = null;
  }
  return node || (typeof document !== "undefined" ? document.body : null);
}

/* ==========================================================================
   openPopover — the primitive
   ========================================================================== */

/**
 * Open a `.pl-popover` anchored to an element.
 *
 * - `position: fixed`, placed from `anchor.getBoundingClientRect()`, flipped
 *   above the anchor when it would overflow the viewport bottom, and clamped
 *   into the viewport horizontally.
 * - Rendered into `.pl-layers` through `ctx.pushLayer` when a ctx is given, so
 *   key isolation, the Escape handling and the focus trap all apply for free.
 * - Closes on outside pointerdown, Escape (top layer only), and ancestor
 *   scroll or resize.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.anchor
 * @param {(el: HTMLElement, handle: object) => any} [opts.render]
 * @param {string} [opts.placement] "bottom-start" | "bottom-end" | "top-start" | "top-end"
 * @param {string} [opts.className] extra class(es) on the popover
 * @param {() => void} [opts.onClose]
 * @param {object} [opts.ctx] modal ctx — enables the layer stack and the key bus
 * @param {string} [opts.ariaLabel]
 * @returns {{el: HTMLElement, close: () => void, reposition: () => void, isOpen: () => boolean}}
 */
export function openPopover({
  anchor,
  render,
  placement,
  className,
  onClose,
  ctx,
  ariaLabel,
} = {}) {
  if (typeof document === "undefined") return null;

  const el = h("div", {
    className: "pl-popover" + (className ? " " + className : ""),
    role: "group",
    "aria-label": ariaLabel || "options",
  });
  el.style.position = "fixed";
  el.style.top = "0px";
  el.style.left = "-9999px"; // measured off-screen, then placed

  let closed = false;
  let layerHandle = null;
  const offs = [];

  const handle = {
    el,
    close,
    reposition,
    isOpen: () => !closed,
  };

  function close() {
    if (closed) return;
    closed = true;
    for (const off of offs) {
      try {
        off();
      } catch (_) {
        /* teardown must never throw */
      }
    }
    offs.length = 0;
    // popLayer() also removes the element; calling it with an already-popped
    // handle is a documented no-op, so this is safe on every close path.
    if (layerHandle && ctx && isFn(ctx.popLayer)) {
      try {
        ctx.popLayer(layerHandle);
      } catch (_) {
        /* ignore */
      }
    }
    if (el.parentNode) {
      try {
        el.parentNode.removeChild(el);
      } catch (_) {
        /* ignore */
      }
    }
    if (isFn(onClose)) {
      try {
        onClose();
      } catch (err) {
        console.error(`${NS} popover onClose failed`, err);
      }
    }
  }

  function reposition() {
    if (closed) return;
    if (!place(el, anchor, placement)) {
      // No usable anchor. Park it in the top-left corner rather than leaving it
      // at the off-screen measuring position, where it would be invisible.
      el.style.top = `${EDGE}px`;
      el.style.left = `${EDGE}px`;
    }
  }

  // ---- mount --------------------------------------------------------------
  // Exactly one owner of the outside-click behaviour. With a ctx we hand the
  // element to modal.js's layer stack (closeOnOutside:true) and install NO
  // document listener of our own: two owners race, and modal.js would then see
  // an empty layer stack on pointerup and close the whole modal.
  if (ctx && isFn(ctx.pushLayer)) {
    try {
      layerHandle = ctx.pushLayer({ el, closeOnOutside: true, onClose: close });
    } catch (_) {
      layerHandle = null;
    }
  }
  if (!layerHandle) {
    const parent = mountTarget(ctx);
    if (!parent) return handle;
    parent.appendChild(el);
    const onDown = (e) => {
      const t = e && e.target;
      if (!t) return;
      if (el.contains(t)) return;
      if (anchor && isFn(anchor.contains) && anchor.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    offs.push(() => document.removeEventListener("pointerdown", onDown, true));
  }

  // ---- content ------------------------------------------------------------
  if (isFn(render)) {
    try {
      const out = render(el, handle);
      if (out && typeof Node !== "undefined" && out instanceof Node && !el.firstChild) {
        el.appendChild(out);
      }
    } catch (err) {
      console.error(`${NS} popover render failed`, err);
    }
  }

  // ---- keys ---------------------------------------------------------------
  // Escape is stopped here so modal.js's root handler does not pop a second
  // layer (with no layers left it calls attemptClose() and the MODAL closes).
  offs.push(
    bindKeys(ctx, el, (e) => {
      if (!e) return;
      if (e.key === "Escape" || e.key === "Esc") {
        if (isFn(e.preventDefault)) e.preventDefault();
        if (isFn(e.stopPropagation)) e.stopPropagation();
        close();
      }
    })
  );

  // ---- scroll / resize ----------------------------------------------------
  // A fixed popover does not follow a scrolling ancestor, so it is dismissed
  // rather than left hanging next to nothing. `capture: true` catches scroll on
  // any ancestor (scroll events do not bubble).
  if (typeof window !== "undefined") {
    const onScroll = (e) => {
      const t = e && e.target;
      if (t && isFn(el.contains) && t !== document && el.contains(t)) return; // our own list
      close();
    };
    const onResize = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    offs.push(() => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    });
  }

  reposition();
  return handle;
}

/**
 * Place `el` against `anchor`. Exported shape is internal, but the rules are:
 * prefer below, flip above on bottom overflow when there is room, clamp both
 * axes into the viewport, and cap the height when nothing fits.
 */
function place(el, anchor, placement) {
  if (!el || !anchor || !isFn(anchor.getBoundingClientRect)) return null;
  let rect;
  try {
    rect = anchor.getBoundingClientRect();
  } catch (_) {
    return null;
  }
  if (!rect) return null;

  const { vw, vh } = viewport();
  const wantTop = typeof placement === "string" && placement.indexOf("top") === 0;
  const alignEnd = typeof placement === "string" && /end$/.test(placement);

  let size = measure(el);

  // Nothing fits anywhere: cap the height and re-measure once, so the flip
  // decision below is made against the size we will actually render.
  const maxH = Math.max(MIN_FLIP_ROOM, vh - 2 * EDGE);
  if (size.h > maxH) {
    el.style.maxHeight = `${Math.round(maxH)}px`;
    size = measure(el);
  }

  const roomBelow = vh - EDGE - (rect.bottom + GAP);
  const roomAbove = rect.top - GAP - EDGE;

  let flipped = false;
  if (wantTop) {
    flipped = roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  } else {
    // Overflows the bottom AND there is more usable room above → flip.
    flipped =
      size.h > roomBelow && roomAbove > roomBelow && roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  }

  let top = flipped ? rect.top - GAP - size.h : rect.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, Math.max(EDGE, vh - EDGE - size.h)));

  let left = alignEnd ? rect.right - size.w : rect.left;
  left = Math.max(EDGE, Math.min(left, Math.max(EDGE, vw - EDGE - size.w)));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.style.bottom = "auto";
  el.style.right = "auto";
  el.dataset.flip = flipped ? "up" : "down";
  return { top, left, flipped };
}

/* ==========================================================================
   Shared menu body — filter input + keyboard-navigable option rows
   ========================================================================== */

/**
 * Build the filter + listbox body shared by every picker.
 *
 * `items` are `{label, meta, selected, disabled, className, run}`. `run` is
 * called on click or Enter; returning `false` keeps the popover open.
 *
 * @returns {{input: HTMLInputElement, list: HTMLElement, setItems: Function,
 *            query: () => string, onKey: (e: KeyboardEvent) => void}}
 */
function buildMenu(el, opts = {}) {
  const { placeholder, ariaLabel, onQuery, autoFocus = true } = opts;

  const input = h("input", {
    className: "pl-search-in",
    type: "text",
    placeholder: placeholder || "filter…",
    spellcheck: "false",
    ...NO_AUTOFILL,
    "aria-label": ariaLabel || placeholder || "filter",
    oninput: () => {
      if (isFn(onQuery)) onQuery(String(input.value || ""));
    },
  });
  // `.pl-search` carries the rail's own 14px margins; inside a popover they
  // would push the field off the padding box.
  const search = h("div", { className: "pl-search", style: { margin: "0 0 6px" } }, input);

  const list = h("div", { role: "listbox", "aria-label": ariaLabel || "options" });
  el.appendChild(search);
  el.appendChild(list);

  let rows = [];
  let active = -1;

  function paintActive() {
    for (let i = 0; i < rows.length; i++) cls(rows[i], "is-active", i === active);
    const row = rows[active];
    if (row && isFn(row.scrollIntoView)) {
      try {
        row.scrollIntoView({ block: "nearest" });
      } catch (_) {
        /* older engines: the option is simply not scrolled to */
      }
    }
  }

  function setActive(i) {
    if (!rows.length) {
      active = -1;
      return;
    }
    active = Math.max(0, Math.min(i, rows.length - 1));
    paintActive();
  }

  function setItems(items) {
    clear(list);
    rows = [];
    const list_ = Array.isArray(items) ? items : [];
    if (!list_.length) {
      list.appendChild(
        h(
          "div",
          { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } },
          opts.emptyLabel || "nothing to pick"
        )
      );
    }
    for (const item of list_) {
      if (!item) continue;
      if (item.disabled) {
        list.appendChild(
          h(
            "div",
            { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } },
            String(item.label == null ? "" : item.label)
          )
        );
        continue;
      }
      const btn = h(
        "button",
        {
          className: "pl-opt" + (item.className ? " " + item.className : ""),
          type: "button",
          role: "option",
          "aria-selected": item.selected ? "true" : "false",
          // The activating event is handed to `run` so a consumer can read
          // modifier keys (snippets: shift = insert the [[reference]]).
          onclick: (ev) => {
            if (isFn(item.run)) item.run(ev);
          },
        },
        item.mark != null
          ? h("span", { "aria-hidden": "true", style: { width: "1em", flex: "0 0 auto" } }, item.mark)
          : null,
        // textContent only — names, tags and bodies are user data.
        h("span", { style: { flex: "1 1 auto", minWidth: "0" } }, String(item.label == null ? "" : item.label)),
        item.meta != null
          ? h("span", { style: { flex: "0 0 auto", opacity: "0.6" } }, String(item.meta))
          : null
      );
      btn.__plItem = item;
      rows.push(btn);
      list.appendChild(btn);
    }
    active = rows.length ? 0 : -1;
    paintActive();
  }

  /** ↑/↓/Home/End/Enter. Wired by the caller through bindKeys(). */
  function onKey(e) {
    if (!e || !rows.length) return;
    const key = e.key;
    if (key === "ArrowDown") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(active + 1);
    } else if (key === "ArrowUp") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(active - 1);
    } else if (key === "Home") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(0);
    } else if (key === "End") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(rows.length - 1);
    } else if (key === "Enter") {
      const row = rows[active];
      if (!row) return;
      if (isFn(e.preventDefault)) e.preventDefault();
      // Call `run` with the KEY event rather than going through .click(), so
      // Enter and Shift+Enter are distinguishable (a synthetic click carries
      // no modifier state).
      if (row.__plItem && isFn(row.__plItem.run)) row.__plItem.run(e);
      else row.click();
    }
  }

  if (autoFocus) {
    // The layer push focuses the first focusable, which is this input; the
    // timeout covers the standalone (no-ctx) path.
    setTimeout(() => {
      try {
        input.focus();
      } catch (_) {
        /* ignore */
      }
    }, 0);
  }

  return {
    input,
    list,
    setItems,
    setActive,
    onKey,
    query: () => String(input.value || ""),
    rows: () => rows.slice(),
  };
}

/** Case-insensitive substring filter used by every picker. */
function matches(label, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return String(label == null ? "" : label).toLowerCase().indexOf(q) >= 0;
}

/** Normalize `[{name,count}]` / `["name"]` taxonomy shapes to `[{name,count}]`. */
function taxonomyRows(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === "object") {
      const name = item.name != null ? String(item.name) : "";
      if (!name) continue;
      out.push({ name, count: Number(item.count) || 0 });
    } else {
      const name = String(item);
      if (name) out.push({ name, count: 0 });
    }
  }
  return out;
}

/* ==========================================================================
   Consumer 1 — category picker
   ========================================================================== */

/**
 * @param {object} ctx modal ctx
 * @param {{anchor: HTMLElement, value?: string, onPick: (name: string) => void}} opts
 */
export function openCategoryPicker(ctx, { anchor, value, onPick } = {}) {
  const state = ctx && isFn(ctx.getState) ? ctx.getState() : {};
  const cats = taxonomyRows(state && state.categories);
  const current = value == null ? "" : String(value);
  let menu = null;
  let creating = false;

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Category",
    className: "pl-pick-cat",
    render: (el, handle) => {
      menu = buildMenu(el, {
        placeholder: "filter categories…",
        ariaLabel: "Category",
        emptyLabel: "no categories yet",
        onQuery: () => {
          rebuild();
          handle.reposition();
        },
      });

      function pick(name) {
        handle.close();
        if (isFn(onPick)) onPick(name);
      }

      async function create(name) {
        const clean = String(name || "").trim();
        if (!clean || creating) return;
        creating = true;
        try {
          if (ctx && ctx.API && isFn(ctx.API.category)) {
            await ctx.API.category({ op: "add", name: clean });
          }
        } catch (err) {
          // The category still gets applied locally — a failed taxonomy write
          // must not lose the user's choice; the save call creates it anyway.
          toast(ctx, `could not create category: ${err && err.message ? err.message : err}`, "error");
        } finally {
          creating = false;
        }
        pick(clean);
      }

      function rebuild() {
        const q = menu.query();
        const items = cats
          .filter((c) => matches(c.name, q))
          .map((c) => ({
            label: c.name,
            meta: c.count ? String(c.count) : null,
            selected: c.name === current,
            mark: c.name === current ? CHECK : "",
            run: () => pick(c.name),
          }));
        const typed = q.trim();
        const exists = cats.some((c) => c.name === typed);
        if (typed && !exists) {
          items.push({
            label: `${PLUS} new category "${typed}"`,
            className: "pl-opt-new",
            run: () => create(typed),
          });
        } else if (!typed) {
          items.push({
            label: `${PLUS} new category`,
            className: "pl-opt-new",
            run: () => {
              try {
                menu.input.focus();
              } catch (_) {
                /* ignore */
              }
              toast(ctx, "type a name, then press Enter");
            },
          });
        }
        if (current) {
          items.push({
            label: "(no category)",
            selected: !current,
            run: () => pick(""),
          });
        }
        menu.setItems(items);
      }

      rebuild();
      return null;
    },
  });

  if (pop && menu) bindKeys(ctx, pop.el, (e) => menu.onKey(e));
  return pop;
}

/* ==========================================================================
   Consumer 2 — tag picker (multi-select + free text)
   ========================================================================== */

/**
 * Mirror of `librarian_store.clean_tag`:
 *
 *     text = _WS_RE.sub("-", _as_str(tag).strip()).casefold()
 *     return text[:MAX_TAG_CHARS]
 *
 * i.e. strip → every internal whitespace RUN becomes a single "-" → casefold →
 * cap at 40 chars, in that order. The order matters: casefolding after the
 * whitespace substitution is what makes "Camera  Move" and "camera move" land
 * on the same "camera-move".
 *
 * JS has no `casefold()`; `toLowerCase()` is the closest equivalent and agrees
 * with it on everything except a handful of full-case-folding pairs (German ß
 * folds to "ss", Cherokee, ﬁ ligatures). Those degrade to "the server stores a
 * slightly different string than the picker predicted" — the backend
 * re-normalizes every tag it receives, so a stored tag is never malformed;
 * at worst a ß-tag shows as unchecked until the record reloads.
 *
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  const text = String(tag == null ? "" : tag)
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return text.slice(0, MAX_TAG_CHARS);
}

/**
 * @param {object} ctx
 * @param {{anchor: HTMLElement, selected?: string[], value?: string[],
 *          onPick: (tag: string) => void, onRemove?: (tag: string) => void}} opts
 */
export function openTagPicker(ctx, { anchor, selected, value, onPick, onRemove } = {}) {
  const state = ctx && isFn(ctx.getState) ? ctx.getState() : {};
  const all = taxonomyRows(state && state.tags);
  // inspector.js passes `value`; the frozen contract says `selected`. Both.
  const initial = Array.isArray(selected) ? selected : Array.isArray(value) ? value : [];
  const chosen = new Set(initial.map(normalizeTag).filter(Boolean));
  let menu = null;

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Tags",
    className: "pl-pick-tags",
    render: (el, handle) => {
      menu = buildMenu(el, {
        placeholder: "filter or add a tag…",
        ariaLabel: "Tags",
        emptyLabel: "no tags yet",
        onQuery: () => {
          rebuild();
          handle.reposition();
        },
      });

      // Multi-select: the popover STAYS OPEN so several tags can be toggled in
      // one visit. Escape / outside click is the way out.
      function toggle(tag) {
        const t = normalizeTag(tag);
        if (!t) return;
        if (chosen.has(t)) {
          // Without an onRemove the caller has no way to drop the tag, so
          // un-checking it here would show a state the record does not have.
          // inspector.js removes tags from its own chips instead.
          if (!isFn(onRemove)) return;
          chosen.delete(t);
          onRemove(t);
        } else {
          if (chosen.size >= 32) {
            toast(ctx, "32 tags is the limit", "error");
            return;
          }
          chosen.add(t);
          if (isFn(onPick)) onPick(t);
        }
        rebuild();
        handle.reposition();
      }

      function rebuild() {
        const q = menu.query();
        // Filter on the raw text OR its normalized form, so typing
        // "Camera Move" finds the stored "camera-move" instead of offering to
        // create a tag that already exists.
        const qn = normalizeTag(q);
        const items = all
          .filter((t) => matches(t.name, q) || (qn && matches(t.name, qn)))
          .map((t) => {
            const key = normalizeTag(t.name);
            return {
              label: t.name,
              meta: t.count ? String(t.count) : null,
              selected: chosen.has(key),
              mark: chosen.has(key) ? CHECK : " ",
              run: () => toggle(t.name),
            };
          });
        const typed = normalizeTag(menu.query());
        const known = all.some((t) => normalizeTag(t.name) === typed);
        if (typed && !known) {
          items.unshift({
            label: `${PLUS} "${typed}"`,
            className: "pl-opt-new",
            mark: chosen.has(typed) ? CHECK : " ",
            run: () => toggle(typed),
          });
        }
        menu.setItems(items);
      }

      rebuild();
      return null;
    },
  });

  if (pop && menu) bindKeys(ctx, pop.el, (e) => menu.onKey(e));
  return pop;
}

/* ==========================================================================
   Consumer 3 — threshold picker
   ========================================================================== */

/**
 * 80/85/90/95/99 %. Calls `onPick(value)` immediately (the panel must react
 * without waiting for the network) and persists through `POST /settings`.
 *
 * @param {object} ctx
 * @param {{anchor: HTMLElement, value?: number, onPick: (v: number) => void}} opts
 */
export function openThresholdPicker(ctx, { anchor, value, onPick } = {}) {
  let cur = Number(value);
  if (!Number.isFinite(cur) || cur <= 0) cur = 0.9;
  if (cur > 1) cur = cur / 100; // tolerate a percent-shaped value

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Duplicate threshold",
    className: "pl-pick-thresh",
    render: (el, handle) => {
      const list = h("div", { role: "listbox", "aria-label": "Duplicate threshold" });
      el.appendChild(list);
      const rows = [];
      let active = Math.max(0, THRESHOLDS.indexOf(cur));

      const paint = () => {
        for (let i = 0; i < rows.length; i++) cls(rows[i], "is-active", i === active);
      };

      const pick = (t) => {
        handle.close();
        if (isFn(onPick)) onPick(t);
        // Fire and forget: a settings write failure must not undo the choice
        // the user just made in the panel.
        if (ctx && ctx.API && isFn(ctx.API.settings)) {
          Promise.resolve()
            .then(() => ctx.API.settings({ dupe_threshold: t }))
            .catch(() => toast(ctx, "threshold not saved (using it for this session)", "warn"));
        }
      };

      for (const t of THRESHOLDS) {
        const isCur = Math.abs(t - cur) < 1e-9;
        const btn = h(
          "button",
          {
            className: "pl-opt",
            type: "button",
            role: "option",
            "aria-selected": isCur ? "true" : "false",
            onclick: () => pick(t),
          },
          h("span", { "aria-hidden": "true", style: { width: "1em", flex: "0 0 auto" } }, isCur ? CHECK : " "),
          h("span", { style: { flex: "1 1 auto" } }, `${Math.round(t * 100)}%`)
        );
        rows.push(btn);
        list.appendChild(btn);
      }
      paint();

      bindKeys(ctx, el, (e) => {
        if (!e || !rows.length) return;
        if (e.key === "ArrowDown") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.min(rows.length - 1, active + 1);
          paint();
        } else if (e.key === "ArrowUp") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.max(0, active - 1);
          paint();
        } else if (e.key === "Enter") {
          if (isFn(e.preventDefault)) e.preventDefault();
          if (rows[active]) rows[active].click();
        }
      });
      return null;
    },
  });
  return pop;
}

/* ==========================================================================
   Consumer 4 — snippets
   ========================================================================== */

/**
 * `GET /snippets` → `{snippets: {name: {body, updated}}}`.
 *
 * Enter or click inserts the snippet BODY at the caret. Shift+Enter /
 * shift-click inserts the `[[name]]` reference instead, which the backend
 * resolver expands at run time (and which the mirror highlights).
 *
 * Escape closes only this popover — the modal stays open.
 *
 * @param {object} ctx
 * @param {{anchor: HTMLElement, textarea: HTMLTextAreaElement,
 *          onInsert?: (text: string) => void}} opts
 */
export function openSnippets(ctx, { anchor, textarea, onInsert } = {}) {
  let menu = null;
  let entries = [];
  let loaded = false;

  const insert = (text) => {
    // inspector.js hands us an onInsert that also syncs its edit buffer and
    // dirty flag; prefer it. Standalone we drive the textarea directly.
    if (isFn(onInsert)) onInsert(text);
    else insertAtCaret(textarea, text);
  };

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Insert snippet",
    className: "pl-pick-snip",
    render: (el, handle) => {
      menu = buildMenu(el, {
        placeholder: "filter snippets…",
        ariaLabel: "Insert snippet",
        emptyLabel: "loading…",
        onQuery: () => {
          rebuild();
          handle.reposition();
        },
      });
      el.appendChild(
        h(
          "div",
          {
            className: "pl-lbl",
            style: { padding: "6px 9px 2px" },
          },
          `enter inserts the text ${MIDDOT} shift+enter inserts [[name]]`
        )
      );

      function rebuild() {
        const q = menu.query();
        const items = entries
          .filter((e) => matches(e.name, q) || matches(e.body, q))
          .map((e) => ({
            label: e.name,
            meta: firstLine(e.body, 28),
            // The activating event decides: shift inserts the `[[name]]`
            // reference (resolved at run time), otherwise the literal body.
            run: (ev) => {
              handle.close();
              insert(ev && ev.shiftKey ? `[[${e.name}]]` : e.body);
            },
          }));
        menu.setItems(items);
        if (loaded && !entries.length) {
          menu.setItems([{ label: "no snippets saved yet", disabled: true }]);
        }
      }

      menu.setItems([{ label: "loading…", disabled: true }]);

      const load = ctx && ctx.API && isFn(ctx.API.snippets) ? ctx.API.snippets() : Promise.resolve(null);
      Promise.resolve(load)
        .then((data) => {
          loaded = true;
          const bag = (data && data.snippets) || {};
          entries = Object.keys(bag)
            .sort()
            .map((name) => {
              const v = bag[name];
              const body = v && typeof v === "object" ? String(v.body == null ? "" : v.body) : String(v == null ? "" : v);
              return { name: String(name), body };
            });
          if (!handle.isOpen()) return;
          rebuild();
          handle.reposition();
        })
        .catch((err) => {
          loaded = true;
          if (!handle.isOpen()) return;
          menu.setItems([{ label: "could not load snippets", disabled: true }]);
          console.error(`${NS} snippets failed`, err);
        });

      bindKeys(ctx, el, (e) => menu.onKey(e));
      return null;
    },
  });

  return pop;
}

/* ==========================================================================
   Consumer 5 — wildcards
   ========================================================================== */

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * `POST /resolve {text, seed, n:5}` → `{text, samples[], picks, missing, warnings}`.
 *
 * Five sampled resolutions, each with `re-roll` (a fresh seed for that row) and
 * `use this` (replaces the body through `onReplace`, pushed onto a LOCAL undo
 * stack so Ctrl+Z is not the only way back). `resolve into body` bakes the
 * first sample in permanently. `missing` wildcard names surface as a warning.
 *
 * @param {object} ctx
 * @param {{anchor: HTMLElement, textarea?: HTMLTextAreaElement, body?: string,
 *          onReplace?: (text: string) => void, seed?: number}} opts
 */
export function openWildcards(ctx, { anchor, textarea, body, onReplace, seed } = {}) {
  const source =
    body != null ? String(body) : textarea && textarea.value != null ? String(textarea.value) : "";
  let baseSeed = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : randomSeed();
  const undo = []; // local undo stack of previous bodies

  const applyBody = (text) => {
    undo.push(currentBody());
    if (isFn(onReplace)) onReplace(text);
    else if (textarea) {
      textarea.value = text;
      dispatchInput(textarea);
    }
  };

  const currentBody = () =>
    textarea && textarea.value != null ? String(textarea.value) : source;

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Wildcards",
    className: "pl-pick-wild",
    placement: "bottom-start",
    render: (el, handle) => {
      const head = h(
        "div",
        { className: "pl-lbl", style: { padding: "2px 9px 6px" } },
        "// WILDCARD PREVIEW"
      );
      const warnBox = h("div", { hidden: true });
      const rowsBox = h("div", { role: "list" });
      const undoBtn = h(
        "button",
        {
          className: "pl-btn pl-btn-sm",
          type: "button",
          hidden: true,
          onclick: () => {
            const prev = undo.pop();
            if (prev == null) return;
            if (isFn(onReplace)) onReplace(prev);
            else if (textarea) {
              textarea.value = prev;
              dispatchInput(textarea);
            }
            undoBtn.hidden = !undo.length;
            toast(ctx, "reverted");
          },
        },
        "undo"
      );
      const bakeBtn = h(
        "button",
        {
          className: "pl-btn pl-btn-sm pl-btn-primary",
          type: "button",
          onclick: () => {
            const first = samples[0];
            if (first == null) return;
            applyBody(first);
            undoBtn.hidden = false;
            handle.close();
            toast(ctx, "resolved into the body — wildcard syntax replaced (undo in the popover)");
          },
        },
        "resolve into body"
      );
      const rerollAll = h(
        "button",
        {
          className: "pl-btn pl-btn-sm",
          type: "button",
          onclick: () => {
            baseSeed = randomSeed();
            load();
          },
        },
        "re-roll all"
      );
      const acts = h(
        "div",
        { className: "pl-dupe-acts", style: { display: "flex", gap: "6px", padding: "6px 3px 0" } },
        rerollAll,
        bakeBtn,
        undoBtn
      );

      el.appendChild(head);
      el.appendChild(warnBox);
      el.appendChild(rowsBox);
      el.appendChild(acts);
      el.style.minWidth = "320px";

      let samples = [];
      let active = 0;
      const rowEls = [];

      function paintActive() {
        for (let i = 0; i < rowEls.length; i++) cls(rowEls[i], "is-active", i === active);
      }

      function renderWarnings(missing, warnings) {
        clear(warnBox);
        const miss = Array.isArray(missing) ? missing.filter(Boolean) : [];
        const warn = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
        if (!miss.length && !warn.length) {
          warnBox.hidden = true;
          return;
        }
        warnBox.hidden = false;
        if (miss.length) {
          warnBox.appendChild(
            h(
              "div",
              {
                className: "pl-opt",
                style: { color: "var(--pl-warn)", cursor: "default", whiteSpace: "normal" },
              },
              `missing wildcard ${miss.length === 1 ? "file" : "files"}: ${miss.join(", ")}`
            )
          );
        }
        for (const w of warn) {
          warnBox.appendChild(
            h(
              "div",
              {
                className: "pl-opt",
                style: { color: "var(--pl-warn)", cursor: "default", whiteSpace: "normal" },
              },
              String(w)
            )
          );
        }
      }

      function renderRows() {
        clear(rowsBox);
        rowEls.length = 0;
        if (!samples.length) {
          rowsBox.appendChild(
            h("div", { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } }, "no resolutions")
          );
          return;
        }
        samples.forEach((text, i) => {
          const textEl = h(
            "div",
            { style: { flex: "1 1 auto", minWidth: "0", whiteSpace: "normal" } },
            truncate(String(text == null ? "" : text), SAMPLE_CHARS)
          );
          const row = h(
            "div",
            {
              className: "pl-opt",
              role: "listitem",
              style: { alignItems: "flex-start", cursor: "default", gap: "8px" },
              onpointerdown: () => {
                active = i;
                paintActive();
              },
            },
            h("span", { style: { flex: "0 0 auto", opacity: "0.6" } }, String(i + 1)),
            textEl,
            h(
              "span",
              { style: { flex: "0 0 auto", display: "flex", gap: "8px" } },
              h(
                "button",
                {
                  className: "pl-link",
                  type: "button",
                  onclick: () => reroll(i, textEl),
                },
                "re-roll"
              ),
              h(
                "button",
                {
                  className: "pl-link",
                  type: "button",
                  onclick: () => {
                    applyBody(samples[i]);
                    undoBtn.hidden = false;
                    handle.close();
                  },
                },
                "use this"
              )
            )
          );
          rowEls.push(row);
          rowsBox.appendChild(row);
        });
        paintActive();
      }

      function reroll(i, textEl) {
        if (!(ctx && ctx.API && isFn(ctx.API.resolve))) return;
        const rollSeed = randomSeed();
        Promise.resolve(ctx.API.resolve({ text: source, seed: rollSeed, n: 1 }))
          .then((data) => {
            if (!handle.isOpen() || !data) return;
            const next = Array.isArray(data.samples) && data.samples.length ? data.samples[0] : data.text;
            samples[i] = String(next == null ? "" : next);
            textEl.textContent = truncate(samples[i], SAMPLE_CHARS);
            handle.reposition();
          })
          .catch((err) => console.error(`${NS} re-roll failed`, err));
      }

      function load() {
        clear(rowsBox);
        rowsBox.appendChild(
          h("div", { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } }, "resolving…")
        );
        if (!(ctx && ctx.API && isFn(ctx.API.resolve))) {
          samples = [];
          renderRows();
          return;
        }
        Promise.resolve(ctx.API.resolve({ text: source, seed: baseSeed, n: 5 }))
          .then((data) => {
            if (!handle.isOpen()) return;
            const list = data && Array.isArray(data.samples) ? data.samples : data ? [data.text] : [];
            samples = list.map((s) => String(s == null ? "" : s));
            renderWarnings(data && data.missing, data && data.warnings);
            renderRows();
            handle.reposition();
          })
          .catch((err) => {
            if (!handle.isOpen()) return;
            samples = [];
            clear(rowsBox);
            rowsBox.appendChild(
              h("div", { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } }, "resolve failed")
            );
            console.error(`${NS} resolve failed`, err);
          });
      }

      bindKeys(ctx, el, (e) => {
        if (!e || !rowEls.length) return;
        if (e.key === "ArrowDown") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.min(rowEls.length - 1, active + 1);
          paintActive();
        } else if (e.key === "ArrowUp") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.max(0, active - 1);
          paintActive();
        } else if (e.key === "Enter") {
          if (isFn(e.preventDefault)) e.preventDefault();
          if (samples[active] == null) return;
          applyBody(samples[active]);
          undoBtn.hidden = false;
          handle.close();
        }
      });

      load();
      return null;
    },
  });

  return pop;
}

/* ==========================================================================
   insertAtCaret
   ========================================================================== */

function dispatchInput(ta) {
  // Load-bearing: without it the inspector's dirty flag never flips and the
  // 400 ms dupe debounce never fires. setRangeText does NOT fire `input` by
  // itself, so exactly one event is dispatched on either path.
  try {
    if (typeof Event === "function") {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  } catch (_) {
    /* fall through */
  }
  try {
    if (typeof document !== "undefined" && isFn(document.createEvent)) {
      const ev = document.createEvent("Event");
      ev.initEvent("input", true, false);
      ta.dispatchEvent(ev);
    }
  } catch (_) {
    /* the caller's own oninput path still runs on real typing */
  }
}

/**
 * Insert `text` at the caret, replacing any selection, and leave the caret
 * after the insertion.
 *
 * @param {HTMLTextAreaElement|HTMLInputElement} ta
 * @param {string} text
 * @returns {boolean} whether anything was inserted
 */
export function insertAtCaret(ta, text) {
  if (!ta) return false;
  const value = String(text == null ? "" : text);
  const len = String(ta.value == null ? "" : ta.value).length;
  const s = typeof ta.selectionStart === "number" ? ta.selectionStart : len;
  const e = typeof ta.selectionEnd === "number" ? ta.selectionEnd : s;

  if (isFn(ta.setRangeText)) {
    ta.setRangeText(value, s, e, "end");
  } else {
    const cur = String(ta.value == null ? "" : ta.value);
    ta.value = cur.slice(0, s) + value + cur.slice(e);
    ta.selectionStart = ta.selectionEnd = s + value.length;
  }
  dispatchInput(ta);
  try {
    ta.focus();
  } catch (_) {
    /* focus is a nicety */
  }
  return true;
}

/* ==========================================================================
   tokenizeWildcards
   ========================================================================== */

/**
 * Find every wildcard/snippet token in `text`.
 *
 * Returns non-overlapping ranges in source order:
 *   `{start, end, kind: "brace"|"file"|"snippet", name}`
 * `name` is the token's inner text (the choices for a brace, the file path for
 * `__file__`, the snippet name for `[[snip]]`).
 *
 * Nesting resolves to the INNERMOST brace, because `[^{}\n]` cannot cross a
 * brace: `{a|{b|c}}` yields only `{b|c}`. That is the honest answer for
 * highlighting — the outer brace's extent is ambiguous until the resolver runs.
 *
 * @param {string} text
 * @returns {Array<{start:number,end:number,kind:string,name:string}>}
 */
export function tokenizeWildcards(text) {
  const src = String(text == null ? "" : text);
  const out = [];
  if (!src) return out;
  // Fresh regex per call: a shared /g regex keeps `lastIndex` between calls.
  const re = new RegExp(WC_SOURCE, WC_FLAGS);
  let m;
  let guard = 0;
  while ((m = re.exec(src)) !== null) {
    if (++guard > MAX_TOKENS) break;
    const raw = m[0];
    if (!raw) {
      re.lastIndex++; // impossible with this grammar, but never loop forever
      continue;
    }
    const start = m.index;
    const end = start + raw.length;
    let kind;
    let name;
    if (raw.charAt(0) === "{") {
      kind = "brace";
      name = raw.slice(1, -1);
    } else if (raw.charAt(0) === "[") {
      kind = "snippet";
      name = raw.slice(2, -2).trim();
    } else {
      kind = "file";
      name = raw.slice(2, -2);
    }
    out.push({ start, end, kind, name });
  }
  return out;
}

/* ==========================================================================
   attachMirror — syntax highlighting behind a transparent textarea
   ==========================================================================
   FRAGILE BY CONSTRUCTION, SO IT SELF-CHECKS.

   A `.pl-ta-mirror` div sits behind the textarea. librarian.css only makes
   `.pl-ta` transparent under `.pl-ta-wrap.is-mirrored`, so adding that class is
   what ACTIVATES highlighting and removing it is a complete, safe rollback: the
   textarea goes back to painting its own (perfectly correct) text.

   If the mirror's wrapped height disagrees with the textarea's by more than
   4 px after one frame, the two are laying text out differently — every
   highlight below that point is in the wrong place — so the mirror is torn
   down and the fact is logged once. Highlighting is a nicety; the textarea's
   correctness is not negotiable.
   ========================================================================== */

// Every metric that can change where a line breaks. The stylesheet already
// declares these identically on `.pl-ta` and `.pl-ta-mirror`; copying the
// COMPUTED values makes the mirror survive a theme or user stylesheet that
// only touches one of them.
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
    // Behind the textarea in DOM order; z-index in the stylesheet does the rest.
    if (ta.parentNode === wrap) wrap.insertBefore(mirror, ta);
    else wrap.appendChild(mirror);
  }

  let dead = false;
  let activeNow = false;
  let checked = false;
  const missing = new Set(); // normalized wildcard names known to be absent
  let lastNamesKey = "";

  /* -- style sync --------------------------------------------------------- */

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

  /* -- render ------------------------------------------------------------- */

  function render() {
    if (dead) return;
    const text = String(ta.value == null ? "" : ta.value);

    // Hard ceiling: tokenizing + re-rendering a novel on every keystroke is
    // exactly the kind of thing that makes a text field feel broken.
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

  /**
   * `.is-missing` is not in librarian.css — there is no rule for it — so the
   * visual comes from an inline style built out of the sheet's own custom
   * properties. The class is still set, so a future stylesheet rule takes over
   * without touching this file.
   */
  function markMissing(span) {
    span.classList.add("is-missing");
    span.style.color = "var(--pl-warn)";
    span.style.textDecoration = "underline wavy";
  }

  /* -- scroll sync -------------------------------------------------------- */

  function syncScroll() {
    if (dead) return;
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  }

  /* -- self-check --------------------------------------------------------- */

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

  /* -- validation --------------------------------------------------------- */

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
        render(); // repaint with `.is-missing` where it belongs
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

  /* -- wiring ------------------------------------------------------------- */

  const reRender = debounce(render, typeof opts.debounceMs === "number" ? opts.debounceMs : MIRROR_DEBOUNCE_MS);
  const onInput = () => reRender();
  const onScroll = () => syncScroll();

  // `input` and `scroll` only. There is deliberately NO keydown listener here:
  // the window-capture guard in modal.js would eat it (see the top of the file).
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
      /* ignore */
    }
    ta.removeEventListener("input", onInput);
    ta.removeEventListener("scroll", onScroll);
    if (ro) {
      try {
        ro.disconnect();
      } catch (_) {
        /* ignore */
      }
      ro = null;
    }
    // Rollback, in the order that keeps the textarea readable at every instant:
    // drop the class first (text becomes opaque), then empty the mirror.
    cls(wrap, "is-mirrored", false);
    clear(mirror);
    for (const prop of COPY_STYLES) {
      try {
        mirror.style[prop] = "";
      } catch (_) {
        /* ignore */
      }
    }
    try {
      mirror.style.width = "";
    } catch (_) {
      /* ignore */
    }
    if (createdMirror && mirror.parentNode) {
      try {
        mirror.parentNode.removeChild(mirror);
      } catch (_) {
        /* ignore */
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
        /* ignore */
      }
      syncStyles();
      render();
    },
    active: () => activeNow && !dead,
  };
}
