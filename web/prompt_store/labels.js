/* ==========================================================================
   Prompt Library (the OLD node) — combo label building
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Exports and `const` data only.

   A category's prompts are shown in a combo, and a combo can only show one
   line. These helpers turn full prompt bodies into short, distinguishable
   labels.
   ========================================================================== */

/** Shown when a combo has nothing to offer. Also the "no category" sentinel. */
export const EMPTY_LABEL = "<empty>";

const MAX_LABEL = 50;

/** Collapse whitespace and cap at MAX_LABEL characters. */
export function truncate(t) {
    const s = (t || "").replace(/\s+/g, " ").trim();
    if (!s) return "(empty)";
    return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s;
}

/**
 * Labels for a category's prompts.
 *
 * When the prompts share a long common prefix and/or suffix (the usual case
 * for variations on one base prompt) the shared part is elided and only the
 * differing middle is shown, so the combo lists what actually differs rather
 * than fifty identical openings. Duplicated labels get a `(2)`, `(3)` suffix.
 */
export function makeLabels(texts) {
    const tokenize = t => (t || "").trim().split(/\s+/).filter(Boolean);
    const tokens = texts.map(tokenize);

    let prefixLen = 0, suffixLen = 0;
    if (tokens.length > 1) {
        const minLen = Math.min(...tokens.map(t => t.length));
        while (prefixLen < minLen && tokens.every(t => t[prefixLen] === tokens[0][prefixLen]))
            prefixLen++;
        const suffixMax = minLen - prefixLen;
        while (suffixLen < suffixMax && tokens.every(t => t[t.length - 1 - suffixLen] === tokens[0][tokens[0].length - 1 - suffixLen]))
            suffixLen++;
    }

    const avgLen = tokens.reduce((s, t) => s + t.length, 0) / (tokens.length || 1);
    const useDiff = tokens.length > 1 && avgLen > 0 && (prefixLen + suffixLen) / avgLen > 0.3;

    const seen = {};
    return texts.map((t, i) => {
        let label;
        if (useDiff) {
            const tok = tokens[i];
            const end = suffixLen > 0 ? tok.length - suffixLen : tok.length;
            const unique = tok.slice(prefixLen, end);
            const s = unique.join(" ");
            if (!s) label = "(base)";
            else label = (prefixLen > 0 ? "…" : "") + truncate(s) + (suffixLen > 0 ? "…" : "");
        } else {
            label = truncate(t);
        }
        if (seen[label]) { seen[label] += 1; label = `${label} (${seen[label]})`; }
        else seen[label] = 1;
        return label;
    });
}
