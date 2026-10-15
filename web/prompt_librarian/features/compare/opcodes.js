/* Word-level diff opcodes from /compare: [{op, a_tokens, b_tokens}], where op is
 * equal | insert | delete | replace. Pure functions over them.
 */

import { str } from "./text.js";

/** Rebuild one side's text from the opcodes (when only an id was given). */
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

/** A naive union of both sides, in order, to seed the merge editor: equal runs
 * once, and each side's own words (left first where both changed). */
export function mergeSeed(opcodes, aText, bText) {
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
    const aTok = Array.isArray(op.a_tokens) ? op.a_tokens : [];
    const bTok = Array.isArray(op.b_tokens) ? op.b_tokens : [];
    if ((str(op.op) || "equal") === "equal") {
      if (aTok.length) out.push(aTok.join(" "));
      continue;
    }
    if (aTok.length) out.push(aTok.join(" "));
    if (bTok.length) out.push(bTok.join(" "));
  }
  return out.join(" ");
}
