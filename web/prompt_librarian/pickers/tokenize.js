const MAX_TOKENS = 4000; // tokenizer safety cap

/** Match wildcards/syntax.py, including Unicode file names and non-greedy
 * __a____b__ matching. Unlike resolution, highlighting stops at newlines
 * to keep unmatched braces from coloring the rest of the prompt.
 */
const WC_SOURCE =
  "\\{[^{}\\n]*\\}|__[\\p{L}\\p{N}_\\-.\\/\\\\]+?__|\\[\\[[^\\[\\]\\n]*\\]\\]";
const WC_FLAGS = "gu";

export const TOK_CLASS = {
  brace: "pl-tok-wild",
  file: "pl-tok-wild",
  snippet: "pl-tok-snip",
};

/** Return non-overlapping ranges in source order. Highlight only innermost
 * braces; the outer extent depends on resolution.
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
