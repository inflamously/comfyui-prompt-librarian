/* ==========================================================================
   Prompt Librarian — renderDiff(), the split/unified diff primitive
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { clear, h } from "../shared/dom.js";
import { fmtInt } from "../shared/format.js";
import { raf, str, tokensOf } from "./common.js";

/**
 * Long-body mitigation: a pair of 100 000-char bodies is ~15 000 word tokens
 * per side, and rendering every one of them as its own aligned chunk pair is
 * tens of thousands of layout boxes for a diff nobody can read anyway. The cap
 * is visible (see the `showing first N of M tokens` notice), never silent.
 */
export const MAX_TOKENS_PER_SIDE = 5000;

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
  const teardown = [];

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
export function reconstruct(opcodes, side) {
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
