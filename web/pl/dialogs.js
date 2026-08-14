/* ==========================================================================
   Prompt Librarian — compare / merge / version-history dialogs
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports EVERY .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Exports and `const` data only — no listeners, no fetches, no DOM writes at
   module scope.

   Owns:
     - renderDiff()      the split/unified diff primitive (used by all three)
     - openCompare()     the compare/merge dialog (dupes, diff-vs-saved, versions)
     - openMergeEditor() the "merge -> new" editable union
     - openVersions()    the two-pane version history

   ----------------------------------------------------------------------
   KEYBOARD: read the KEY ISOLATION block at the top of modal.js first.
   modal.js installs a window-CAPTURE guard that calls
   stopImmediatePropagation() on every keydown/keyup/keypress originating
   inside `.pl-root`. A plain `el.addEventListener("keydown", …)` in here
   would therefore NEVER fire. Every key handler in this file goes through
   `bindKey()` below, which uses `ctx.onKey(el, type, fn)` (modal.js's key
   bus) and falls back to the namespaced `pl:keydown` mirror. Do not
   "simplify" it back to a plain listener.
   ----------------------------------------------------------------------

   Never innerHTML: prompt bodies, names and version text are user data that
   round-trips through JSON. h() + textContent only.
   ========================================================================== */

import { NS, NO_AUTOFILL, clear, cls, debounce, fmtInt, h, relTime, truncate } from "./dom.js";

/* --------------------------------------------------------------------------
   Constants
   -------------------------------------------------------------------------- */

/**
 * Long-body mitigation: a pair of 100 000-char bodies is ~15 000 word tokens
 * per side, and rendering every one of them as its own aligned chunk pair is
 * tens of thousands of layout boxes for a diff nobody can read anyway. The cap
 * is visible (see the `showing first N of M tokens` notice), never silent.
 */
export const MAX_TOKENS_PER_SIDE = 5000;

/** Beyond this many snapshots the version list is virtualised (list.js). */
const VIRTUALISE_AT = 60;

/* Glyphs by code point so they survive a wrong or absent charset header. */
const ARROW = String.fromCharCode(0x2192); // →
const MIDDOT = String.fromCharCode(0x00b7); // ·
const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);
const SWAP = String.fromCharCode(0x2194); // ↔

/** The confirm wording for Restore is specified verbatim. Do not reword. */
export const RESTORE_CONFIRM = "Restores this version as a new version. History is not erased.";

/* --------------------------------------------------------------------------
   Tiny utilities
   -------------------------------------------------------------------------- */

const raf =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);

function str(v) {
  return v == null ? "" : String(v);
}

function quote(s) {
  return LDQUO + str(s) + RDQUO;
}

/** Word tokens, the same `\S+` split the backend's differ uses. */
function tokensOf(text) {
  const s = str(text).trim();
  if (!s) return [];
  return s.split(/\s+/);
}

/** `{prompt: rec}` / `{record: rec}` / `rec` -> rec. */
function unwrapRecord(res) {
  if (!res || typeof res !== "object") return null;
  if (res.prompt && typeof res.prompt === "object") return res.prompt;
  if (res.record && typeof res.record === "object") return res.record;
  if (res.id) return res;
  return null;
}

function errMsg(err) {
  if (!err) return "unknown error";
  if (err.code === "not_json") return "the librarian backend is not responding";
  return str(err.message || err) || "request failed";
}

function isAborted(ctx, value) {
  return ctx && ctx.ABORTED !== undefined && value === ctx.ABORTED;
}

function toast(ctx, msg, kind) {
  try {
    if (ctx && typeof ctx.toast === "function") ctx.toast(str(msg), kind ? { kind } : undefined);
    else console.info(NS, str(msg));
  } catch (_) {
    /* a toast failing must never break a flow */
  }
}

/** Never window.confirm(). Falls back to "no" when the modal has no confirm. */
function confirmWith(ctx, opts) {
  if (ctx && typeof ctx.confirmDialog === "function") {
    try {
      return Promise.resolve(ctx.confirmDialog(opts));
    } catch (err) {
      return Promise.resolve(false);
    }
  }
  return Promise.resolve(false);
}

/**
 * Bind a key handler that survives modal.js's window-capture guard.
 *
 * `ctx.onKey(el, type, fn)` is the supported bus. The `pl:<type>` CustomEvent
 * mirror is the documented fallback (modal.js dispatches it on the same target
 * with `detail.event` pointing at the original), used when ctx has no onKey —
 * a plain "keydown" listener would be silently dead.
 *
 * @returns {() => void} unbind
 */
function bindKey(ctx, el, type, fn) {
  if (ctx && typeof ctx.onKey === "function") {
    try {
      const off = ctx.onKey(el, type, fn);
      if (typeof off === "function") return off;
      return () => {};
    } catch (_) {
      /* fall through to the mirror */
    }
  }
  const mirror = (e) => {
    const orig = (e && e.detail && e.detail.event) || e;
    fn(orig);
  };
  const mtype = "pl:" + type;
  el.addEventListener(mtype, mirror);
  return () => el.removeEventListener(mtype, mirror);
}

/** Feature-detected clipboard write with the hidden-textarea fallback. */
function copyText(text) {
  const s = str(text);
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      return Promise.resolve(nav.clipboard.writeText(s)).then(
        () => true,
        () => execCopy(s)
      );
    } catch (_) {
      return Promise.resolve(execCopy(s));
    }
  }
  return Promise.resolve(execCopy(s));
}

function execCopy(s) {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  let ta = null;
  try {
    ta = h("textarea", {
      value: s,
      "aria-hidden": "true",
      style: { position: "fixed", top: "-1000px", left: "-1000px", opacity: "0" },
    });
    (document.body || document.documentElement).appendChild(ta);
    if (typeof ta.select === "function") ta.select();
    return !!document.execCommand("copy");
  } catch (_) {
    return false;
  } finally {
    try {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Push `el` as a modal layer. Falls back to appending into the root when the
 * modal shell is not built (tests, or dialogs.js loaded standalone), so a
 * dialog is never a silent no-op.
 */
function openLayer(ctx, el, opts = {}) {
  let handle = null;
  let closed = false;
  const onClose = typeof opts.onClose === "function" ? opts.onClose : null;
  const fire = () => {
    if (closed) return;
    closed = true;
    if (onClose) {
      try {
        onClose();
      } catch (err) {
        console.error(`${NS} dialog onClose failed`, err);
      }
    }
  };
  try {
    if (ctx && typeof ctx.pushLayer === "function") {
      handle = ctx.pushLayer({
        el,
        closeOnOutside: opts.closeOnOutside !== false,
        onClose: fire,
      });
    }
  } catch (_) {
    handle = null;
  }
  if (!handle) {
    const parent =
      (ctx && ctx.root) || (typeof document !== "undefined" ? document.body : null);
    if (parent && typeof parent.appendChild === "function") parent.appendChild(el);
    handle = { el, local: true };
    focusFirst(el);
  }
  return {
    el,
    isClosed: () => closed,
    close() {
      if (closed) return;
      if (handle.local) {
        if (el.parentNode) el.parentNode.removeChild(el);
        fire();
        return;
      }
      try {
        ctx.popLayer(handle);
      } catch (_) {
        /* ignore */
      }
      fire(); // no-op when popLayer already ran the handler
    },
  };
}

function focusFirst(scope) {
  if (!scope || typeof scope.querySelector !== "function") return;
  const el = scope.querySelector(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (el && typeof el.focus === "function") {
    try {
      el.focus();
    } catch (_) {
      /* ignore */
    }
  }
}

/** `.pl-btn` with the pack's modifier vocabulary. */
function btn(label, opts = {}) {
  const kind = opts.kind || "";
  const extra =
    kind === "primary"
      ? " pl-btn-primary"
      : kind === "accent"
      ? " pl-btn-accent"
      : kind === "danger"
      ? " pl-btn-danger"
      : kind === "ghost"
      ? " pl-btn-ghost"
      : "";
  const el = h(
    "button",
    {
      className: "pl-btn" + (opts.small === false ? "" : " pl-btn-sm") + extra,
      type: "button",
      title: opts.title || null,
      disabled: !!opts.disabled,
      dataset: opts.key ? { act: opts.key } : null,
      onclick: opts.onClick || null,
    },
    label
  );
  if (opts.disabled) el.setAttribute("aria-disabled", "true");
  return el;
}

/** Three shimmering bars, reusing the list's skeleton rules. */
function skeleton(lines = 3) {
  const box = h("div", { className: "pl-row-skel", "aria-hidden": "true" });
  for (let i = 0; i < lines; i++) {
    box.appendChild(h("div", { className: "pl-row-body", style: { marginBottom: "8px" } }, " "));
  }
  return box;
}

/** An error row with a retry button — never a bare throw into the console. */
function errorRow(message, onRetry) {
  const box = h("div", { className: "pl-list-empty", role: "alert" }, str(message));
  if (typeof onRetry === "function") {
    box.appendChild(h("div", { style: { height: "8px" } }));
    box.appendChild(btn("retry", { onClick: onRetry, key: "retry" }));
  }
  return box;
}

/* ==========================================================================
   renderDiff — the core primitive
   ========================================================================== */

/**
 * Render backend opcodes into `container`.
 *
 * `opcodes` is `POST /compare`'s `diff`: a list of
 * `{op, a_start, a_end, b_start, b_end, a_tokens, b_tokens}` over WORD tokens,
 * `equal` runs included.
 *
 * Split mode emits ONE chunk element into EACH column for every opcode, even
 * when that side is empty (an empty placeholder), each tagged `data-op="<i>"`:
 *
 *   op        left            right
 *   equal     plain           plain
 *   delete    .pl-del         empty placeholder
 *   insert    empty           .pl-ins
 *   replace   .pl-del         .pl-ins
 *
 * The placeholders are what make alignment possible at all: chunk `i` is the
 * i-th child of both columns, so equalising their heights lines the two sides
 * up without a single measurement of the other column's layout.
 *
 * Unified mode renders one column with inline ins/del spans (narrow screens).
 *
 * @param {HTMLElement} container
 * @param {{opcodes?: Array, a?: string, b?: string, mode?: "split"|"unified"}} opts
 * @returns {{mode: string, chunks: Array, left: HTMLElement|null,
 *            right: HTMLElement|null, capped: boolean, dispose: () => void}}
 */
export function renderDiff(container, opts = {}) {
  const mode = opts.mode === "unified" ? "unified" : "split";
  const opcodes = Array.isArray(opts.opcodes) ? opts.opcodes : [];
  const aText = str(opts.a);
  const bText = str(opts.b);

  if (!container) {
    return { mode, chunks: [], left: null, right: null, capped: false, dispose() {} };
  }
  clear(container);

  /* ---- totals, for the cap notice ------------------------------------- */
  let totalA = 0;
  let totalB = 0;
  for (const op of opcodes) {
    totalA += (op && op.a_tokens && op.a_tokens.length) || 0;
    totalB += (op && op.b_tokens && op.b_tokens.length) || 0;
  }
  totalA = Math.max(totalA, tokensOf(aText).length);
  totalB = Math.max(totalB, tokensOf(bText).length);

  /* ---- nothing to render ---------------------------------------------- */
  if (!opcodes.length) {
    const wrap = h("div", { className: "pl-diff" });
    if (mode === "unified") {
      wrap.style.gridTemplateColumns = "minmax(0, 1fr)";
      wrap.appendChild(h("div", { className: "pl-diff-col" }, aText || bText || ""));
    } else {
      wrap.appendChild(h("div", { className: "pl-diff-col" }, aText));
      wrap.appendChild(h("div", { className: "pl-diff-col" }, bText));
    }
    container.appendChild(wrap);
    return {
      mode,
      chunks: [],
      left: wrap.firstChild || null,
      right: mode === "split" ? wrap.lastChild : null,
      capped: false,
      dispose() {},
    };
  }

  /* ---- token budget ---------------------------------------------------- */
  let usedA = 0;
  let usedB = 0;
  let capped = false;

  /** Slice a token run to what is left of its side's budget. */
  function take(tokens, side) {
    const list = Array.isArray(tokens) ? tokens : [];
    const used = side === "a" ? usedA : usedB;
    const room = MAX_TOKENS_PER_SIDE - used;
    if (room <= 0) {
      if (list.length) capped = true;
      return [];
    }
    if (list.length > room) {
      capped = true;
      const cut = list.slice(0, room);
      if (side === "a") usedA += cut.length;
      else usedB += cut.length;
      return cut;
    }
    if (side === "a") usedA += list.length;
    else usedB += list.length;
    return list;
  }

  const notice = h("div", {
    className: "pl-list-empty",
    dataset: { plNotice: "cap" },
    hidden: true,
    style: { padding: "6px 0", textAlign: "left" },
  });

  const wrap = h("div", { className: "pl-diff" });
  const chunks = [];
  let left = null;
  let right = null;
  let teardown = [];

  if (mode === "unified") {
    wrap.style.gridTemplateColumns = "minmax(0, 1fr)";
    const col = h("div", { className: "pl-diff-col" });
    left = col;
    for (let i = 0; i < opcodes.length; i++) {
      const op = opcodes[i] || {};
      const kind = str(op.op) || "equal";
      const part = h("span", { dataset: { op: String(i) } });
      const aTok = kind === "insert" ? [] : take(op.a_tokens, "a");
      const bTok = kind === "delete" ? [] : take(op.b_tokens, "b");
      if (kind === "equal") {
        part.appendChild(document.createTextNode(aTok.join(" ")));
      } else {
        if (aTok.length) part.appendChild(h("span", { className: "pl-del" }, aTok.join(" ")));
        if (aTok.length && bTok.length) part.appendChild(document.createTextNode(" "));
        if (bTok.length) part.appendChild(h("span", { className: "pl-ins" }, bTok.join(" ")));
      }
      col.appendChild(part);
      if (i < opcodes.length - 1) col.appendChild(document.createTextNode(" "));
      chunks.push([part, null]);
    }
    wrap.appendChild(col);
  } else {
    left = h("div", { className: "pl-diff-col", dataset: { side: "a" } });
    right = h("div", { className: "pl-diff-col", dataset: { side: "b" } });
    for (let i = 0; i < opcodes.length; i++) {
      const op = opcodes[i] || {};
      const kind = str(op.op) || "equal";
      const aTok = kind === "insert" ? [] : take(op.a_tokens, "a");
      const bTok = kind === "delete" ? [] : take(op.b_tokens, "b");

      const lCls = kind === "delete" || kind === "replace" ? "pl-del" : "";
      const rCls = kind === "insert" || kind === "replace" ? "pl-ins" : "";
      const lEl = chunkEl(i, kind === "insert" ? "" : aTok.join(" "), lCls, kind === "insert");
      const rEl = chunkEl(i, kind === "delete" ? "" : bTok.join(" "), rCls, kind === "delete");

      left.appendChild(lEl);
      right.appendChild(rEl);
      chunks.push([lEl, rEl]);
    }
    wrap.appendChild(left);
    wrap.appendChild(right);
  }

  if (capped) {
    const shownA = Math.min(usedA, MAX_TOKENS_PER_SIDE);
    const shownB = Math.min(usedB, MAX_TOKENS_PER_SIDE);
    const shown = Math.max(shownA, shownB);
    const total = Math.max(totalA, totalB);
    notice.textContent = `showing first ${fmtInt(shown)} of ${fmtInt(total)} tokens`;
    notice.hidden = false;
    container.appendChild(notice);
  }
  container.appendChild(wrap);

  /* ---- alignment: ONE rAF pass, ALL READS THEN ALL WRITES --------------
     Interleaving a read with a write forces a synchronous layout per chunk
     ("layout thrashing") — with a few hundred opcodes that is seconds. The
     two loops below must stay two loops. -------------------------------- */
  if (mode === "split" && chunks.length) {
    raf(() => {
      try {
        const heights = chunks.map((pair) => {
          const lh = (pair[0] && pair[0].offsetHeight) || 0;
          const rh = (pair[1] && pair[1].offsetHeight) || 0;
          return Math.max(lh, rh);
        });
        for (let i = 0; i < chunks.length; i++) {
          const px = heights[i] + "px";
          if (chunks[i][0]) chunks[i][0].style.minHeight = px;
          if (chunks[i][1]) chunks[i][1].style.minHeight = px;
        }
      } catch (err) {
        console.error(`${NS} diff alignment failed`, err);
      }
    });
  }

  /* ---- scroll sync, with a re-entrancy flag ---------------------------- */
  if (mode === "split" && left && right && typeof left.addEventListener === "function") {
    let syncing = false;
    const mkSync = (from, to) => () => {
      if (syncing) return;
      syncing = true;
      if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
      raf(() => {
        syncing = false;
        // Reconcile the event that was dropped while the flag was up.
        if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
      });
    };
    const onLeft = mkSync(left, right);
    const onRight = mkSync(right, left);
    left.addEventListener("scroll", onLeft, { passive: true });
    right.addEventListener("scroll", onRight, { passive: true });
    teardown.push(() => {
      left.removeEventListener("scroll", onLeft);
      right.removeEventListener("scroll", onRight);
    });
  }

  return {
    mode,
    chunks,
    left,
    right,
    capped,
    notice,
    dispose() {
      for (const fn of teardown.splice(0)) {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      }
    },
  };
}

/**
 * One chunk element. `empty` marks the placeholder that keeps the two columns
 * index-aligned; it carries no text but still occupies its slot.
 */
function chunkEl(index, text, extraClass, empty) {
  const el = h("div", {
    className: "pl-diff-chunk" + (extraClass ? " " + extraClass : "") + (empty ? " is-empty" : ""),
    dataset: { op: String(index) },
  });
  if (text) el.textContent = text;
  return el;
}

/** Rebuild one side's text from the opcodes (used when only an id was given). */
function reconstruct(opcodes, side) {
  const key = side === "b" ? "b_tokens" : "a_tokens";
  const skip = side === "b" ? "delete" : "insert";
  const out = [];
  for (const op of opcodes || []) {
    if (!op || op.op === skip) continue;
    const toks = op[key];
    if (toks && toks.length) out.push(toks.join(" "));
  }
  return out.join(" ");
}

/* ==========================================================================
   openCompare
   ========================================================================== */

/**
 * The compare/merge dialog. One dialog serves three callers — the dupe panel,
 * `diff vs saved`, and the version history — which is why the action set is a
 * parameter rather than a hard-coded row.
 *
 * @param {object} ctx modal.js context
 * @param {{a_id?: string|null, a_text?: string, b_id?: string|null,
 *          b_text?: string, titleA?: string, titleB?: string,
 *          actions?: Array|Function, mode?: "split"|"unified",
 *          onClose?: Function}} opts
 * @returns {{el: HTMLElement, close: () => void, setMode: (m: string) => void,
 *            reload: () => void}}
 */
export function openCompare(ctx, opts = {}) {
  const o = opts || {};
  const a_id = o.a_id == null || o.a_id === "" ? null : String(o.a_id);
  const b_id = o.b_id == null || o.b_id === "" ? null : String(o.b_id);
  const titleA = str(o.titleA) || (a_id ? "left" : "left");
  const titleB = str(o.titleB) || (b_id ? "right" : "right");

  let aText = str(o.a_text);
  let bText = str(o.b_text);
  let opcodes = null;
  let summary = "";
  let pct = null;
  let loading = true; // the first paint is a skeleton, never an error row
  let busy = false;
  let disposed = false;
  let diffHandle = null;

  /** Timers registered here are cancelled by the layer's onClose. */
  const debounces = [];

  /* ---- chrome ---------------------------------------------------------- */

  const titleEl = h("div", { className: "pl-dialog-title" }, `${titleA}  ${SWAP}  ${titleB}`);
  const matchEl = h("span", { className: "pl-row-match" }, "");
  const summaryEl = h("span", { className: "pl-dupe-why" }, "");
  const metaEl = h(
    "div",
    {
      style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", minWidth: "0" },
    },
    matchEl,
    summaryEl
  );

  const modeTabs = h("div", { className: "pl-tabs", role: "tablist", "aria-label": "Diff mode", style: { padding: "0" } });
  const splitTab = h(
    "button",
    {
      className: "pl-link",
      type: "button",
      role: "tab",
      "aria-selected": "true",
      title: "two columns, chunk-aligned",
      onclick: () => setMode("split"),
    },
    "split"
  );
  const unifiedTab = h(
    "button",
    {
      className: "pl-link",
      type: "button",
      role: "tab",
      "aria-selected": "false",
      title: "one column with inline changes",
      onclick: () => setMode("unified"),
    },
    "unified"
  );
  modeTabs.appendChild(splitTab);
  modeTabs.appendChild(unifiedTab);

  const headRow = h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: "12px", minWidth: "0" } },
    metaEl,
    h("div", { className: "pl-spacer", style: { flex: "1 1 auto" } }),
    modeTabs
  );

  const labels = h(
    "div",
    { className: "pl-diff" },
    h("div", { className: "pl-lbl" }, titleA),
    h("div", { className: "pl-lbl" }, titleB)
  );

  const diffBox = h("div", { style: { minHeight: "0", minWidth: "0" } });
  const body = h("div", { className: "pl-dialog-body" }, headRow, labels, diffBox);
  const acts = h("div", { className: "pl-dialog-acts" });

  const el = h(
    "div",
    {
      className: "pl-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `compare ${titleA} with ${titleB}`,
    },
    titleEl,
    body,
    acts
  );

  /* ---- mode ------------------------------------------------------------ */

  let mode = o.mode === "split" || o.mode === "unified" ? o.mode : defaultMode(ctx);

  function defaultMode(c) {
    try {
      const root = c && c.root;
      if (root && root.dataset && root.dataset.w === "narrow") return "unified";
      const st = c && typeof c.getState === "function" ? c.getState() : null;
      if (st && (st.narrow === true || st.width === "narrow")) return "unified";
    } catch (_) {
      /* ignore */
    }
    return "split";
  }

  function setMode(next) {
    mode = next === "unified" ? "unified" : "split";
    splitTab.setAttribute("aria-selected", mode === "split" ? "true" : "false");
    unifiedTab.setAttribute("aria-selected", mode === "unified" ? "true" : "false");
    // NOT `labels.hidden`: .pl-diff sets `display: grid`, which beats the UA
    // `[hidden] { display: none }` rule, and librarian.css has no
    // `.pl-diff[hidden]` override. An inline display wins outright.
    labels.style.display = mode === "unified" ? "none" : "";
    paintDiff();
  }

  /* ---- painting -------------------------------------------------------- */

  function paintDiff() {
    if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
    diffHandle = null;
    if (loading) {
      clear(diffBox);
      const sk = h("div", { className: "pl-diff" }, skeleton(3), skeleton(3));
      diffBox.appendChild(sk);
      return;
    }
    if (!opcodes) {
      clear(diffBox);
      diffBox.appendChild(errorRow(lastError || "nothing to compare", lastError ? reload : null));
      return;
    }
    diffHandle = renderDiff(diffBox, { opcodes, a: aText, b: bText, mode });
  }

  function paintMeta() {
    matchEl.textContent = pct == null ? "" : `${pct}% match`;
    summaryEl.textContent = summary ? `differs: ${summary}` : "";
  }

  /* ---- data ------------------------------------------------------------ */

  let lastError = "";

  function comparePayload() {
    const p = {};
    if (aText || !a_id) p.a_text = aText;
    if (a_id) p.a_id = a_id;
    if (bText || !b_id) p.b_text = bText;
    if (b_id) p.b_id = b_id;
    return p;
  }

  async function reload() {
    if (disposed) return;
    loading = true;
    lastError = "";
    paintDiff();
    let res;
    try {
      const call = (signal) => ctx.API.compare(comparePayload(), signal);
      res =
        ctx.lanes && typeof ctx.lanes.diff === "function" ? await ctx.lanes.diff(call) : await call();
    } catch (err) {
      if (disposed) return;
      loading = false;
      lastError = "compare failed: " + errMsg(err);
      opcodes = null;
      paintDiff();
      renderActions();
      return;
    }
    if (isAborted(ctx, res)) return; // a newer compare is already running
    if (disposed) return;
    loading = false;
    const data = res && typeof res === "object" ? res : {};
    opcodes = Array.isArray(data.diff) ? data.diff : [];
    summary = str(data.summary);
    pct = data.pct == null ? (data.score == null ? null : Math.round(Number(data.score) * 100)) : Number(data.pct);
    if (!aText) aText = reconstruct(opcodes, "a");
    if (!bText) bText = reconstruct(opcodes, "b");
    paintMeta();
    paintDiff();
    renderActions();
  }

  /* ---- actions --------------------------------------------------------- */

  const api = {
    ctx,
    a_id,
    b_id,
    titleA,
    titleB,
    get a_text() {
      return aText;
    },
    get b_text() {
      return bText;
    },
    get opcodes() {
      return opcodes;
    },
    close: () => layer.close(),
    reload,
  };

  function setBusy(on) {
    busy = !!on;
    for (const b of acts.querySelectorAll ? acts.querySelectorAll("button") : []) {
      if (on) b.disabled = true;
    }
    if (!on) renderActions();
  }

  /** Wrap an action so a throw becomes a toast and the row is never stuck. */
  function guard(fn) {
    return async () => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        toast(ctx, errMsg(err), "error");
      } finally {
        if (!disposed) setBusy(false);
      }
    };
  }

  async function adopt(targetId, targetName, sourceText, which) {
    const ok = await confirmWith(ctx, {
      title: `keep ${which}?`,
      message:
        `Overwrite ${quote(targetName)} with the ${which} version?\n` +
        "Its current body is kept as a version, so this is undoable.",
      confirmLabel: `keep ${which}`,
      danger: true,
    });
    if (!ok) return;
    const rec = unwrapRecord(await ctx.API.update({ id: targetId, body: sourceText }));
    toast(ctx, rec ? `${quote(rec.name || targetName)} updated` : "updated", "success");
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
    if (typeof o.onApplied === "function") o.onApplied(rec);
    layer.close();
  }

  /**
   * Build one action descriptor.
   *
   * An action that cannot apply — `a_id` is null because the left side is an
   * unsaved buffer, say — is rendered DISABLED with the reason in its `title`.
   * Never hidden (the user cannot tell a missing button from a bug) and never
   * silently broken.
   */
  function spec(key, label, opts2) {
    const ready = !loading && !!opcodes;
    const blocked = opts2.reason || "";
    return {
      key,
      label,
      kind: opts2.kind || "",
      disabled: !!blocked || (opts2.needsDiff !== false && !ready),
      title: blocked || (opts2.needsDiff !== false && !ready ? "waiting for the diff" : opts2.title),
      run: opts2.run,
    };
  }

  function defaultSpecs() {
    const bothIds = !!(a_id && b_id);
    const same = bothIds && a_id === b_id;
    const pairReason = !bothIds
      ? "both sides must be saved prompts"
      : same
      ? "both sides are the same record"
      : "";

    const specs = [];

    specs.push(
      spec("keep_left", "keep left", {
        title: `${quote(titleB)} adopts the left body`,
        reason: b_id ? "" : "the right side is not a saved prompt, so there is nothing to overwrite",
        run: () => adopt(b_id, titleB, aText, "left"),
      })
    );

    specs.push(
      spec("keep_right", "keep right", {
        title: `${quote(titleA)} adopts the right body`,
        reason: a_id ? "" : "the left side is not a saved prompt, so there is nothing to overwrite",
        run: () => adopt(a_id, titleA, bText, "right"),
      })
    );

    specs.push(
      spec("merge_new", `merge ${ARROW} new`, {
        title: "edit a union of both bodies and save it as a new prompt",
        run: async () => {
          openMergeEditor(ctx, {
            left: { id: a_id, name: titleA, body: aText },
            right: { id: b_id, name: titleB, body: bText },
            opcodes,
            onSaved: (rec) => {
              if (typeof o.onApplied === "function") o.onApplied(rec);
              layer.close();
            },
          });
        },
      })
    );

    specs.push(
      spec("merge", "merge", {
        kind: "primary",
        title: `merge ${quote(titleB)} into ${quote(titleA)}`,
        reason: pairReason,
        run: async () => {
          const ok = await confirmWith(ctx, {
            title: "merge these two?",
            message:
              `${quote(titleB)} is merged into ${quote(titleA)}.\n` +
              "Usage counts are summed and tags are unioned. " +
              `${quote(titleB)} is deleted, and its body is kept as a version of ${quote(titleA)}.`,
            confirmLabel: "merge",
            danger: true,
          });
          if (!ok) return;
          const rec = unwrapRecord(await ctx.API.merge({ winner_id: a_id, loser_id: b_id }));
          toast(ctx, `merged into ${quote((rec && rec.name) || titleA)}`, "success");
          if (typeof ctx.refreshAll === "function") ctx.refreshAll();
          if (typeof o.onApplied === "function") o.onApplied(rec);
          layer.close();
        },
      })
    );

    specs.push(
      spec("keep_both", "keep both", {
        // Deliberately not gated on the diff: "keep both" is the answer to
        // "these are duplicates", and it stays available even if /compare is
        // down.
        needsDiff: false,
        title: "stop flagging this pair as duplicates",
        reason: pairReason,
        run: async () => {
          const ok = await confirmWith(ctx, {
            title: "keep both?",
            message:
              `${quote(titleA)} and ${quote(titleB)} are both kept.\n` +
              "This pair will not be flagged as duplicates again.",
            confirmLabel: "keep both",
          });
          if (!ok) return;
          await ctx.API.ignorePair(a_id, b_id);
          toast(ctx, "kept both — this pair will not be flagged again", "success");
          if (typeof ctx.refreshAll === "function") ctx.refreshAll();
          layer.close();
        },
      })
    );

    return specs;
  }

  function normaliseSpec(item, byKey) {
    if (typeof item === "string") return byKey[item] || null;
    if (!item || typeof item !== "object") return null;
    const base = item.key && byKey[item.key] ? Object.assign({}, byKey[item.key]) : {};
    const out = Object.assign(base, item);
    const cb = item.run || item.onClick || item.onclick || base.run;
    out.run = typeof cb === "function" ? () => cb(api) : () => {};
    return out;
  }

  function renderActions() {
    clear(acts);
    const defaults = defaultSpecs();
    const byKey = Object.create(null);
    for (const s of defaults) byKey[s.key] = s;

    let specs;
    if (typeof o.actions === "function") {
      let produced = null;
      try {
        produced = o.actions(api, defaults);
      } catch (err) {
        console.error(`${NS} compare actions() threw`, err);
      }
      specs = (Array.isArray(produced) ? produced : defaults)
        .map((s) => normaliseSpec(s, byKey))
        .filter(Boolean);
    } else if (Array.isArray(o.actions)) {
      specs = o.actions.map((s) => normaliseSpec(s, byKey)).filter(Boolean);
    } else {
      specs = defaults;
    }

    for (const s of specs) {
      acts.appendChild(
        btn(s.label, {
          key: s.key,
          kind: s.kind,
          title: s.title,
          disabled: !!s.disabled || busy,
          onClick: guard(() => s.run(api)),
        })
      );
    }
    acts.appendChild(
      btn("close", { kind: "ghost", key: "close", onClick: () => layer.close(), title: "Esc" })
    );
  }

  /* ---- keys ------------------------------------------------------------ */

  const unbind = [];
  unbind.push(
    bindKey(ctx, el, "keydown", (e) => {
      if (!e) return;
      // Escape is handled by modal.js (it pops the top layer). Only the local
      // shortcuts live here.
      if ((e.key === "u" || e.key === "U") && !e.ctrlKey && !e.metaKey && !isTextEntry(e.target)) {
        setMode(mode === "split" ? "unified" : "split");
        if (typeof e.preventDefault === "function") e.preventDefault();
      }
    })
  );

  /* ---- layer ----------------------------------------------------------- */

  const layer = openLayer(ctx, el, {
    closeOnOutside: false,
    onClose: () => {
      disposed = true;
      for (const fn of unbind.splice(0)) {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      }
      for (const d of debounces.splice(0)) {
        try {
          if (d && typeof d.cancel === "function") d.cancel();
        } catch (_) {
          /* ignore */
        }
      }
      if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
      diffHandle = null;
      // Abort work this dialog started; a response landing after close would
      // paint into a detached tree.
      if (loading && ctx.lanes && ctx.lanes.diff && typeof ctx.lanes.diff.cancel === "function") {
        try {
          ctx.lanes.diff.cancel();
        } catch (_) {
          /* ignore */
        }
      }
      if (typeof o.onClose === "function") o.onClose();
    },
  });

  setMode(mode);
  renderActions();
  reload();
  focusFirst(el);

  return {
    el,
    close: () => layer.close(),
    setMode,
    reload,
    get mode() {
      return mode;
    },
  };
}

export const openDiff = openCompare;
export const compareDialog = openCompare;

function isTextEntry(node) {
  if (!node || !node.tagName) return false;
  const tag = String(node.tagName).toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true;
}

/* ==========================================================================
   openMergeEditor
   ========================================================================== */

/**
 * Editable union of two bodies, saved as a NEW record.
 *
 * The seed is deliberately naive — every `equal` run plus both sides' inserts
 * (a `delete` is the left side's insert; a `replace` contributes both) in
 * opcode order. It is a starting point for a human edit, not a merge
 * algorithm, and the dialog says so.
 *
 * @param {object} ctx
 * @param {{left: object, right: object, opcodes?: Array, onSaved?: Function}} opts
 * @returns {{el: HTMLElement, close: () => void, textarea: HTMLTextAreaElement}}
 */
export function openMergeEditor(ctx, opts = {}) {
  const o = opts || {};
  const left = o.left || {};
  const right = o.right || {};
  const a_id = left.id == null || left.id === "" ? null : String(left.id);
  const b_id = right.id == null || right.id === "" ? null : String(right.id);

  const seed = mergeSeed(o.opcodes, str(left.body), str(right.body));
  const defaultName = `${str(left.name) || "merged"}_merged`;

  let busy = false;
  let disposed = false;

  const nameIn = h("input", {
    className: "pl-name",
    type: "text",
    value: defaultName,
    "aria-label": "name for the merged prompt",
    spellcheck: "false",
    ...NO_AUTOFILL,
  });

  const ta = h("textarea", {
    className: "pl-ta",
    value: seed,
    spellcheck: "false",
    "aria-label": "merged body",
  });

  const hint = h(
    "div",
    { className: "pl-dupe-why", style: { margin: "2px 0 6px" } },
    "seeded with a naive union of both sides " +
      MIDDOT +
      " everything from both bodies is here, in order. Edit it before saving."
  );

  const body = h(
    "div",
    { className: "pl-dialog-body", style: { display: "flex", flexDirection: "column", gap: "8px" } },
    h("div", { className: "pl-lbl" }, "name"),
    nameIn,
    hint,
    h("div", { className: "pl-ta-wrap", style: { minHeight: "220px" } }, ta)
  );

  const saveBtn = btn("save as new", {
    kind: "accent",
    key: "save",
    title:
      a_id && b_id
        ? "creates a third prompt that absorbs both, then deletes them"
        : "creates a new prompt; nothing existing is touched",
    onClick: () => save(),
  });

  const acts = h(
    "div",
    { className: "pl-dialog-acts" },
    btn("cancel", { kind: "ghost", onClick: () => layer.close() }),
    saveBtn
  );

  const el = h(
    "div",
    { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "merge into a new prompt" },
    h("div", { className: "pl-dialog-title" }, `merge ${ARROW} new prompt`),
    body,
    acts
  );

  async function save() {
    if (busy || disposed) return;
    const name = str(nameIn.value).trim();
    const text = str(ta.value);
    if (!name) {
      toast(ctx, "the merged prompt needs a name", "error");
      try {
        nameIn.focus();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    if (!text.trim()) {
      toast(ctx, "the merged body is empty", "error");
      return;
    }
    if (a_id && b_id) {
      const ok = await confirmWith(ctx, {
        title: "save the merge?",
        message:
          `${quote(str(left.name))} and ${quote(str(right.name))} are absorbed into ${quote(name)}.\n` +
          "Both originals are deleted and their bodies are kept as versions of the new prompt.",
        confirmLabel: "save as new",
        danger: true,
      });
      if (!ok) return;
    }
    busy = true;
    saveBtn.disabled = true;
    try {
      const res =
        a_id && b_id
          ? await ctx.API.mergeNew({ a_id, b_id, body: text, name })
          : await ctx.API.create({
              name,
              body: text,
              category: left.category || right.category || "",
              tags: Array.isArray(left.tags) ? left.tags.slice() : [],
            });
      const rec = unwrapRecord(res);
      toast(ctx, `created ${quote((rec && rec.name) || name)}`, "success");
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      if (typeof o.onSaved === "function") o.onSaved(rec);
      layer.close();
    } catch (err) {
      toast(ctx, "merge failed: " + errMsg(err), "error");
    } finally {
      busy = false;
      if (!disposed) saveBtn.disabled = false;
    }
  }

  const unbind = [];
  unbind.push(
    bindKey(ctx, el, "keydown", (e) => {
      if (!e) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "s" || e.key === "S")) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        save();
      }
    })
  );

  const layer = openLayer(ctx, el, {
    closeOnOutside: false,
    onClose: () => {
      disposed = true;
      for (const fn of unbind.splice(0)) {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      }
      if (typeof o.onClose === "function") o.onClose();
    },
  });

  try {
    ta.focus();
  } catch (_) {
    /* ignore */
  }

  return { el, close: () => layer.close(), textarea: ta, nameInput: nameIn };
}

/** All `equal` runs plus both sides' inserts, in opcode order. */
function mergeSeed(opcodes, aText, bText) {
  if (!Array.isArray(opcodes) || !opcodes.length) {
    const a = str(aText);
    const b = str(bText);
    if (!a) return b;
    if (!b || a === b) return a;
    return a + "\n\n" + b;
  }
  const out = [];
  for (const op of opcodes) {
    if (!op) continue;
    const kind = str(op.op) || "equal";
    const aTok = Array.isArray(op.a_tokens) ? op.a_tokens : [];
    const bTok = Array.isArray(op.b_tokens) ? op.b_tokens : [];
    if (kind === "equal") {
      if (aTok.length) out.push(aTok.join(" "));
      continue;
    }
    // delete  -> the left side's insert
    // insert  -> the right side's insert
    // replace -> one of each, left first
    if (aTok.length) out.push(aTok.join(" "));
    if (bTok.length) out.push(bTok.join(" "));
  }
  return out.join(" ");
}

/* ==========================================================================
   openVersions
   ========================================================================== */

/**
 * Two-pane version history.
 *
 *   left  — the snapshots, newest first, with the live body as the head entry
 *   right — the selected snapshot diffed against the live body
 *
 * `GET /versions` answers previews only (a record at the 50-version cap would
 * otherwise be a multi-megabyte response), so the body is fetched on demand —
 * and the fetch plus its compare go through ONE `ctx.lanes.versions` run, so
 * holding the down-arrow can never interleave two responses.
 *
 * @param {object} ctx
 * @param {{id: string, record?: object, onRestored?: Function}} opts
 * @returns {{el: HTMLElement, close: () => void, reload: () => void}}
 */
export function openVersions(ctx, opts = {}) {
  const o = opts || {};
  const id = str(o.id || (o.record && o.record.id));
  // A COPY: restore updates the local view of the record, and mutating the
  // inspector's `current` object behind its back would desync its dirty check.
  const record = Object.assign({ id }, o.record && typeof o.record === "object" ? o.record : null);

  let currentBody = str(record.body);
  let rows = []; // display order: [current, newest, …, oldest]
  let selected = 0;
  let listLoading = true;
  let listError = "";
  let paneState = "idle"; // idle | loading | ready | error
  let paneError = "";
  let paneOpcodes = null;
  let paneVersion = null; // {index, name, ts, body}
  let disposed = false;
  let seq = 0; // belt-and-braces over the lane's own sequence guard
  let vlist = null;

  /* ---- chrome ---------------------------------------------------------- */

  const listBox = h("div", {
    className: "pl-list",
    role: "listbox",
    tabIndex: 0,
    "aria-label": "versions",
    style: { border: "1px solid var(--pl-border-soft)", borderRadius: "6px", maxHeight: "100%" },
  });

  const paneHead = h("div", {
    style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: "0" },
  });
  const paneTitle = h("div", { className: "pl-lbl" }, "");
  const paneMeta = h("span", { className: "pl-row-meta" }, "");
  const paneActs = h("div", { className: "pl-dupe-acts", style: { marginLeft: "auto", display: "flex", gap: "8px" } });
  paneHead.appendChild(paneTitle);
  paneHead.appendChild(paneMeta);
  paneHead.appendChild(paneActs);

  const paneBody = h("div", { style: { minHeight: "0", minWidth: "0" } });

  const pane = h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: "0", minHeight: "0" } },
    paneHead,
    paneBody
  );

  const body = h(
    "div",
    {
      className: "pl-dialog-body",
      style: {
        display: "grid",
        gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)",
        gap: "12px",
        minHeight: "0",
      },
    },
    listBox,
    pane
  );

  const acts = h(
    "div",
    { className: "pl-dialog-acts" },
    btn("close", { kind: "ghost", onClick: () => layer.close(), title: "Esc" })
  );

  const el = h(
    "div",
    { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "version history" },
    h("div", { className: "pl-dialog-title" }, `versions ${MIDDOT} ${str(record.name) || id}`),
    body,
    acts
  );

  /* ---- list ------------------------------------------------------------ */

  function rowEl() {
    const name = h("span", { className: "pl-row-name" });
    const badge = h("span", { className: "pl-badge-dupe", hidden: true }, "current");
    const preview = h("div", { className: "pl-row-body" });
    const meta = h("div", { className: "pl-row-meta" });
    const row = h(
      "div",
      { className: "pl-row", role: "option", "aria-selected": "false" },
      h("span", { className: "pl-row-bar" }),
      name,
      badge,
      preview,
      meta
    );
    row.__parts = { name, badge, preview, meta };
    return row;
  }

  function paintRow(el2, item, index) {
    if (!el2 || !el2.__parts) return;
    const p = el2.__parts;
    if (!item) {
      el2.classList.add("pl-row-skel");
      p.name.textContent = "";
      p.preview.textContent = "";
      p.meta.textContent = "";
      p.badge.hidden = true;
      return;
    }
    el2.classList.remove("pl-row-skel");
    p.name.textContent = item.label;
    p.badge.hidden = !item.isCurrent;
    p.preview.textContent = item.preview;
    p.meta.textContent = item.meta;
    el2.setAttribute("aria-selected", index === selected ? "true" : "false");
    cls(el2, "is-sel", index === selected);
    el2.dataset.idx = String(index);
  }

  function rowMeta(item) {
    const bits = [];
    const rel = relTime(item.ts);
    if (rel) bits.push(rel);
    bits.push(`${fmtInt(item.chars)} chars`);
    if (item.src) bits.push("from a merge");
    return bits.join(` ${MIDDOT} `);
  }

  function buildRows(previews) {
    const list = [];
    list.push({
      index: null,
      isCurrent: true,
      label: str(record.name) || "current",
      preview: truncate(str(currentBody).replace(/\s+/g, " ").trim(), 160),
      chars: str(currentBody).length,
      ts: str(record.updated),
      src: null,
    });
    const sorted = (previews || []).slice().sort((x, y) => (Number(y.index) || 0) - (Number(x.index) || 0));
    for (const v of sorted) {
      list.push({
        index: Number(v.index),
        isCurrent: false,
        label: str(v.name) || `version ${Number(v.index) + 1}`,
        preview: str(v.preview),
        chars: Number(v.chars) || 0,
        ts: str(v.ts),
        src: v.src || null,
      });
    }
    for (const item of list) item.meta = rowMeta(item);
    return list;
  }

  async function paintList() {
    clear(listBox);
    if (vlist && typeof vlist.destroy === "function") {
      try {
        vlist.destroy();
      } catch (_) {
        /* ignore */
      }
      vlist = null;
    }
    if (listLoading) {
      listBox.appendChild(h("div", { className: "pl-list-empty" }, "loading versions…"));
      return;
    }
    if (listError) {
      listBox.appendChild(errorRow(listError, reload));
      return;
    }
    if (!rows.length) {
      listBox.appendChild(h("div", { className: "pl-list-empty" }, "no versions yet"));
      return;
    }

    if (rows.length > VIRTUALISE_AT) {
      // Lazy import: a broken or missing list.js must degrade to plain rows,
      // not to an empty pane.
      try {
        const mod = await import("./list.js");
        if (mod && typeof mod.VirtualList === "function") {
          const spacer = h("div", { className: "pl-list-spacer" });
          const win = h("div", { className: "pl-list-win" });
          listBox.appendChild(spacer);
          listBox.appendChild(win);
          vlist = new mod.VirtualList({
            viewport: listBox,
            spacer,
            win,
            createRow: rowEl,
            updateRow: paintRow,
            onActivate: (index) => select(index),
            source: { get: (i) => rows[i] || null, peek: (i) => rows[i] || null },
          });
          vlist.setTotal(rows.length);
          return;
        }
      } catch (err) {
        console.warn(`${NS} VirtualList unavailable; using plain rows`, err && err.message);
        clear(listBox);
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const el2 = rowEl();
      // Plain rows are not virtualised, so they must not be pinned to
      // --pl-row-h; a long preview would be clipped.
      el2.style.height = "auto";
      el2.style.minHeight = "72px";
      paintRow(el2, rows[i], i);
      listBox.appendChild(el2);
    }
  }

  function onListClick(e) {
    let node = e.target;
    while (node && node !== listBox && !(node.dataset && node.dataset.idx != null)) node = node.parentNode;
    if (!node || node === listBox) return;
    const i = Number(node.dataset.idx);
    if (Number.isFinite(i)) select(i);
  }

  function repaintSelection() {
    if (vlist && typeof vlist.repaint === "function") {
      vlist.repaint();
      return;
    }
    const kids = listBox.querySelectorAll ? listBox.querySelectorAll(".pl-row") : [];
    for (const kid of kids) {
      const i = Number(kid.dataset ? kid.dataset.idx : NaN);
      const on = i === selected;
      kid.setAttribute("aria-selected", on ? "true" : "false");
      cls(kid, "is-sel", on);
    }
  }

  /* ---- right pane ------------------------------------------------------ */

  let diffHandle = null;

  function paintPane() {
    if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
    diffHandle = null;
    clear(paneActs);
    const item = rows[selected] || null;

    paneTitle.textContent = item ? item.label : "";
    paneMeta.textContent = item ? item.meta : "";

    const isCurrent = !item || item.isCurrent;
    const haveBody = !!(paneVersion && paneVersion.body != null);

    paneActs.appendChild(
      btn("Restore", {
        key: "restore",
        kind: "primary",
        disabled: isCurrent || paneState !== "ready",
        title: isCurrent
          ? "this is already the current version"
          : "snapshots the current body first, then restores this one",
        onClick: () => doRestore(item),
      })
    );
    paneActs.appendChild(
      btn("Load into node", {
        key: "load",
        disabled: !isCurrent && !haveBody,
        title: "sends this version to the node WITHOUT saving it — the stored prompt is untouched",
        onClick: () => doLoad(item),
      })
    );
    paneActs.appendChild(
      btn("Copy", {
        key: "copy",
        disabled: !isCurrent && !haveBody,
        title: "copy this version's text to the clipboard",
        onClick: () => doCopy(item),
      })
    );

    clear(paneBody);
    if (!item) return;
    if (item.isCurrent) {
      paneBody.appendChild(
        h("div", { className: "pl-list-empty" }, "this is the current body — pick a snapshot to see what changed")
      );
      const col = h("div", { className: "pl-diff-col", style: { maxHeight: "40vh" } }, currentBody);
      paneBody.appendChild(col);
      return;
    }
    if (paneState === "loading") {
      paneBody.appendChild(h("div", { className: "pl-diff" }, skeleton(3), skeleton(3)));
      return;
    }
    if (paneState === "error") {
      paneBody.appendChild(errorRow(paneError, () => select(selected, { force: true })));
      return;
    }
    if (paneState !== "ready") return;

    const labels = h(
      "div",
      { className: "pl-diff" },
      h("div", { className: "pl-lbl" }, item.label),
      h("div", { className: "pl-lbl" }, "current")
    );
    const box = h("div", { style: { minHeight: "0" } });
    paneBody.appendChild(labels);
    paneBody.appendChild(box);
    const mode = narrow() ? "unified" : "split";
    // NOT `labels.hidden`: .pl-diff sets `display: grid`, which beats the UA
    // `[hidden] { display: none }` rule, and librarian.css has no
    // `.pl-diff[hidden]` override. An inline display wins outright.
    labels.style.display = mode === "unified" ? "none" : "";
    diffHandle = renderDiff(box, {
      opcodes: paneOpcodes,
      a: paneVersion ? str(paneVersion.body) : "",
      b: currentBody,
      mode,
    });
  }

  function narrow() {
    try {
      const root = ctx && ctx.root;
      return !!(root && root.dataset && root.dataset.w === "narrow");
    } catch (_) {
      return false;
    }
  }

  /* ---- selection ------------------------------------------------------- */

  async function select(index, opts2 = {}) {
    if (disposed) return;
    const i = Math.max(0, Math.min(rows.length - 1, Number(index) || 0));
    const changed = i !== selected;
    selected = i;
    repaintSelection();
    if (vlist && typeof vlist.scrollToIndex === "function") vlist.scrollToIndex(i);
    const item = rows[i];
    if (!item) return;
    if (item.isCurrent) {
      paneState = "idle";
      paneVersion = null;
      paneOpcodes = null;
      paintPane();
      return;
    }
    if (!changed && !opts2.force && paneState === "ready" && paneVersion && paneVersion.index === item.index) {
      paintPane();
      return;
    }

    const mine = ++seq;
    paneState = "loading";
    paneError = "";
    paneVersion = null;
    paneOpcodes = null;
    paintPane();

    // ONE lane run for both calls: the version body and its compare travel
    // together, so a superseded selection cannot half-land.
    const work = async (signal) => {
      const vres = await ctx.API.version(id, item.index, signal);
      const version = (vres && (vres.version || vres.prompt)) || null;
      const vbody = version ? str(version.body) : "";
      const cres = await ctx.API.compare({ a_text: vbody, b_text: currentBody }, signal);
      return { version, vbody, cres };
    };

    let res;
    try {
      res =
        ctx.lanes && typeof ctx.lanes.versions === "function"
          ? await ctx.lanes.versions(work)
          : await work();
    } catch (err) {
      if (disposed || mine !== seq) return;
      paneState = "error";
      paneError = "could not load this version: " + errMsg(err);
      paintPane();
      return;
    }
    if (isAborted(ctx, res)) return; // a newer selection is already in flight
    if (disposed || mine !== seq) return; // …and the same guard, locally

    paneVersion = Object.assign({}, res.version || {}, { index: item.index, body: res.vbody });
    paneOpcodes = (res.cres && Array.isArray(res.cres.diff) && res.cres.diff) || [];
    paneState = "ready";
    paintPane();
  }

  /* ---- per-snapshot actions -------------------------------------------- */

  async function doRestore(item) {
    if (!item || item.isCurrent) return;
    const ok = await confirmWith(ctx, {
      title: "restore this version?",
      message: RESTORE_CONFIRM,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      const rec = unwrapRecord(await ctx.API.restoreVersion(id, item.index));
      toast(ctx, "restored — the previous body is now a version", "success");
      if (rec) {
        currentBody = str(rec.body);
        record.name = rec.name != null ? rec.name : record.name;
        record.updated = rec.updated != null ? rec.updated : record.updated;
        record.body = currentBody;
      }
      if (typeof o.onRestored === "function") o.onRestored(rec);
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      await reload();
    } catch (err) {
      toast(ctx, "restore failed: " + errMsg(err), "error");
    }
  }

  function bodyFor(item) {
    if (!item) return "";
    if (item.isCurrent) return currentBody;
    return paneVersion && paneVersion.index === item.index ? str(paneVersion.body) : "";
  }

  function doLoad(item) {
    const text = bodyFor(item);
    if (!item || (!item.isCurrent && !text)) return;
    if (typeof ctx.loadIntoNode !== "function") {
      toast(ctx, "no node to load into", "error");
      return;
    }
    const res = ctx.loadIntoNode(Object.assign({}, record, { id: record.id || id, body: text }));
    if (res && res.ok === false) {
      toast(ctx, res.reason === "stale_target" ? "that node is gone — pick another" : "could not load into the node", "error");
      return;
    }
    toast(ctx, "sent to the node (not saved)", "success");
  }

  async function doCopy(item) {
    const text = bodyFor(item);
    if (!item || (!item.isCurrent && !text)) return;
    const ok = await copyText(text);
    toast(ctx, ok ? "copied" : "could not copy — select the text and copy manually", ok ? "success" : "error");
  }

  /* ---- data ------------------------------------------------------------ */

  async function reload() {
    if (disposed) return;
    listLoading = true;
    listError = "";
    await paintList();

    if (!currentBody && id && typeof ctx.API.get === "function") {
      try {
        const rec = unwrapRecord(await ctx.API.get(id));
        if (rec) {
          currentBody = str(rec.body);
          record.name = record.name || rec.name;
          record.updated = record.updated || rec.updated;
        }
      } catch (_) {
        /* the previews still work without it */
      }
    }

    let res;
    try {
      const call = (signal) => ctx.API.versions(id, signal);
      res =
        ctx.lanes && typeof ctx.lanes.versions === "function"
          ? await ctx.lanes.versions(call)
          : await call();
    } catch (err) {
      if (disposed) return;
      listLoading = false;
      listError = "could not load versions: " + errMsg(err);
      await paintList();
      return;
    }
    if (isAborted(ctx, res)) return;
    if (disposed) return;

    listLoading = false;
    rows = buildRows((res && res.versions) || []);
    selected = rows.length > 1 ? 1 : 0;
    await paintList();
    await select(selected, { force: true });
  }

  /* ---- keys ------------------------------------------------------------ */

  /**
   * Arrow-key browsing is debounced so holding ↓ moves the highlight at once
   * but fetches only the version the user stops on. The lane would serialise
   * the requests anyway; this stops them being made at all. Cancelled on close.
   */
  const scheduleSelect = debounce((i) => select(i), 110);
  const debounces = [scheduleSelect];
  try {
    if (ctx && Array.isArray(ctx.debounces)) ctx.debounces.push(scheduleSelect);
  } catch (_) {
    /* ignore */
  }

  function moveSelection(next) {
    if (next === selected || !rows.length) return;
    selected = Math.max(0, Math.min(rows.length - 1, next));
    repaintSelection();
    if (vlist && typeof vlist.scrollToIndex === "function") vlist.scrollToIndex(selected);
    scheduleSelect(selected);
  }

  // THE KEY BUS, not addEventListener: modal.js's window-capture guard stops
  // key events before they reach this subtree. See bindKey().
  const unbind = [];
  unbind.push(
    bindKey(ctx, el, "keydown", (e) => {
      if (!e || isTextEntry(e.target)) return;
      const k = e.key;
      let next = null;
      if (k === "ArrowDown") next = Math.min(rows.length - 1, selected + 1);
      else if (k === "ArrowUp") next = Math.max(0, selected - 1);
      else if (k === "Home") next = 0;
      else if (k === "End") next = rows.length - 1;
      else return;
      // Safe to preventDefault: the event is already isolated from ComfyUI,
      // and this stops the dialog scrolling under the selection.
      if (typeof e.preventDefault === "function") e.preventDefault();
      moveSelection(next);
    })
  );

  /* ---- layer ----------------------------------------------------------- */

  const layer = openLayer(ctx, el, {
    closeOnOutside: false,
    onClose: () => {
      disposed = true;
      seq++; // any response still in flight is now superseded
      for (const d of debounces.splice(0)) {
        try {
          if (d && typeof d.cancel === "function") d.cancel();
        } catch (_) {
          /* ignore */
        }
      }
      for (const fn of unbind.splice(0)) {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      }
      if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
      diffHandle = null;
      if (vlist && typeof vlist.destroy === "function") {
        try {
          vlist.destroy();
        } catch (_) {
          /* ignore */
        }
      }
      vlist = null;
      try {
        listBox.removeEventListener("click", onListClick);
      } catch (_) {
        /* ignore */
      }
      if (ctx.lanes && ctx.lanes.versions && typeof ctx.lanes.versions.cancel === "function") {
        try {
          ctx.lanes.versions.cancel();
        } catch (_) {
          /* ignore */
        }
      }
      if (typeof o.onClose === "function") o.onClose();
    },
  });

  // One delegated click listener for both the plain and the virtualised list
  // (recycled rows would otherwise need re-binding on every render).
  listBox.addEventListener("click", onListClick);

  paintPane();
  reload();
  focusFirst(el);

  return {
    el,
    close: () => layer.close(),
    reload,
    select,
    get selectedIndex() {
      return selected;
    },
    get rows() {
      return rows;
    },
  };
}

export const openVersionsDialog = openVersions;
export const versionsDialog = openVersions;
