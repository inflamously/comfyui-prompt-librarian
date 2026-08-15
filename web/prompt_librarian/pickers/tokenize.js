/* ==========================================================================
   Prompt Librarian — the wildcard / snippet token grammar
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

const MAX_TOKENS = 4000; // tokenizer safety cap

/**
 * The grammar, as a source string rather than a literal so every call builds a
 * FRESH RegExp — a module-level /g regex carries `lastIndex` between calls and
 * would skip tokens on the second call.
 *
 *   {a|b}          brace choice
 *   __file__       wildcard file, `__sub/dir/name__` allowed
 *   [[snippet]]    stored snippet reference
 *
 * Deliberately aligned with prompt_librarian/wildcards.py, because a highlight
 * that disagrees with the resolver is worse than no highlight:
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
export const TOK_CLASS = {
  brace: "pl-tok-wild",
  file: "pl-tok-wild",
  snippet: "pl-tok-snip",
};

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
