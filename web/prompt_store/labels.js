/** Shown when a combo has nothing to offer. Also the "no category" sentinel. */
export const EMPTY_LABEL = "<empty>";

const MAX_LABEL = 50;

export function truncate(t) {
    const s = (t || "").replace(/\s+/g, " ").trim();
    if (!s) return "(empty)";
    return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s;
}

/** Elide substantial shared prefixes/suffixes so variations remain distinguishable.
 * Suffix duplicate labels to keep the combo mapping unique.
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
