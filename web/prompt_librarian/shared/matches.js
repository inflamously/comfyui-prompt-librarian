/* Duplicate matches as the API returns them, normalized for display. */

/** A score as a 0–1 fraction; percent-shaped values (> 1) are scaled down. */
export function frac(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/** A score as a whole percent, e.g. "97%". */
export const pct = (v) => Math.round(frac(v) * 100) + "%";

/** Normalize matches to {id, label, score, summary, body, ignored}.
 * Fall back to preview or ID when no derived label is available.
 */
export function matchesOf(r) {
  const arr = Array.isArray(r) ? r : (r && (r.matches || r.dupes)) || [];
  const out = [];
  for (const m of arr) {
    if (!m) continue;
    const id = m.id != null ? String(m.id) : "";
    out.push({
      id,
      label: String(m.label || m.preview || id || "(empty prompt)"),
      score: frac(m.score != null ? m.score : m.ratio),
      summary: m.summary == null ? "" : String(m.summary),
      body: typeof m.body === "string" ? m.body : null,
      ignored: !!m.ignored,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
