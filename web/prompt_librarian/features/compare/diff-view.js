/* A word-level diff of two texts. Split mode shows two columns whose chunks
 * stay index-aligned (every opcode gets a chunk on both sides, empty ones
 * included, and paired chunks share a height), with the scroll positions
 * synced. Unified mode shows one column with inline insertions and deletions.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { str, tokensOf } from "./text.js";

/** Long bodies show this many tokens per side, and say so. */
export const MAX_TOKENS_PER_SIDE = 5000;

/** deps: opcodes, a and b (the texts), mode ("split" | "unified"). */
export class DiffView extends Component {
  render() {
    const { opcodes = [], a, b } = this.deps;
    this.mode = this.deps.mode === "unified" ? "unified" : "split";
    const root = h("div", { style: { display: "contents" } });
    const wrap = h("div", { className: "pl-diff" });
    if (this.mode === "unified") wrap.style.gridTemplateColumns = "minmax(0, 1fr)";
    if (!opcodes.length) {
      // Nothing to align: just the texts.
      if (this.mode === "unified") wrap.append(h("div", { className: "pl-diff-col" }, str(a) || str(b)));
      else wrap.append(h("div", { className: "pl-diff-col" }, str(a)), h("div", { className: "pl-diff-col" }, str(b)));
      root.append(wrap);
      return root;
    }
    const budget = { a: MAX_TOKENS_PER_SIDE, b: MAX_TOKENS_PER_SIDE, capped: false };
    if (this.mode === "unified") wrap.append(unifiedColumn(opcodes, budget));
    else this.splitColumns(wrap, opcodes, budget);
    if (budget.capped) root.append(capNotice(opcodes, a, b, budget));
    root.append(wrap);
    return root;
  }

  splitColumns(wrap, opcodes, budget) {
    const left = h("div", { className: "pl-diff-col", dataset: { side: "a" } });
    const right = h("div", { className: "pl-diff-col", dataset: { side: "b" } });
    const chunks = opcodes.map((op = {}, i) => {
      const kind = str(op.op) || "equal";
      const l = chunkEl(i, kind === "insert" ? "" : take(op.a_tokens, "a", budget).join(" "),
        kind === "delete" || kind === "replace" ? "pl-del" : "", kind === "insert");
      const r = chunkEl(i, kind === "delete" ? "" : take(op.b_tokens, "b", budget).join(" "),
        kind === "insert" || kind === "replace" ? "pl-ins" : "", kind === "delete");
      left.append(l);
      right.append(r);
      return [l, r];
    });
    wrap.append(left, right);
    // Read every height before writing any: interleaving forces a layout per chunk.
    const frame = requestAnimationFrame(() => {
      const heights = chunks.map(([l, r]) => Math.max(l.offsetHeight || 0, r.offsetHeight || 0));
      chunks.forEach(([l, r], i) => { l.style.minHeight = r.style.minHeight = heights[i] + "px"; });
    });
    this.own(() => cancelAnimationFrame(frame));
    this.syncScroll(left, right);
  }

  syncScroll(left, right) {
    let syncing = false;
    const follow = (from, to) => () => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      requestAnimationFrame(() => {
        syncing = false;
        // Catch up with an event dropped while the flag was up.
        if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
      });
    };
    this.listen(left, "scroll", follow(left, right), { passive: true });
    this.listen(right, "scroll", follow(right, left), { passive: true });
  }
}

function unifiedColumn(opcodes, budget) {
  const col = h("div", { className: "pl-diff-col" });
  opcodes.forEach((op = {}, i) => {
    const kind = str(op.op) || "equal";
    const aTok = kind === "insert" ? [] : take(op.a_tokens, "a", budget);
    const bTok = kind === "delete" ? [] : take(op.b_tokens, "b", budget);
    const part = h("span", { dataset: { op: String(i) } });
    if (kind === "equal") {
      part.append(aTok.join(" "));
    } else {
      if (aTok.length) part.append(h("span", { className: "pl-del" }, aTok.join(" ")));
      if (aTok.length && bTok.length) part.append(" ");
      if (bTok.length) part.append(h("span", { className: "pl-ins" }, bTok.join(" ")));
    }
    col.append(part);
    if (i < opcodes.length - 1) col.append(" ");
  });
  return col;
}

/** Take tokens from one side's budget; mark the diff capped once a side runs out. */
function take(tokens, side, budget) {
  const list = Array.isArray(tokens) ? tokens : [];
  const room = budget[side];
  if (list.length > room) budget.capped = true;
  const cut = list.slice(0, Math.max(0, room));
  budget[side] -= cut.length;
  return cut;
}

function capNotice(opcodes, a, b, budget) {
  let totalA = 0;
  let totalB = 0;
  for (const op of opcodes) {
    totalA += op?.a_tokens?.length || 0;
    totalB += op?.b_tokens?.length || 0;
  }
  const shown = Math.max(MAX_TOKENS_PER_SIDE - budget.a, MAX_TOKENS_PER_SIDE - budget.b);
  const total = Math.max(totalA, totalB, tokensOf(a).length, tokensOf(b).length);
  return h("div", {
    className: "pl-list-empty",
    dataset: { plNotice: "cap" },
    style: { padding: "6px 0", textAlign: "left" },
  }, `showing first ${fmtInt(shown)} of ${fmtInt(total)} tokens`);
}

/** One side of one opcode; an empty chunk still holds its place in the column. */
function chunkEl(index, text, extraClass, empty) {
  const el = h("div", {
    className: "pl-diff-chunk" + (extraClass ? " " + extraClass : "") + (empty ? " is-empty" : ""),
    dataset: { op: String(index) },
  });
  if (text) el.textContent = text;
  return el;
}
