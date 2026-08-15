/* ==========================================================================
   Prompt Librarian — record / payload shapes
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Pure functions: everything the pane needs to read a backend answer, compare
   two buffers, or recognise a conflict. No DOM, no state.
   ========================================================================== */

/** sessionStorage key prefix for per-record drafts. */
export const DRAFT_PREFIX = "pl:draft:";

export function errMsg(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message || e.error || e.code || e);
}

/** The API layer may either throw or hand back `{error, code}`. Unify. */
export function ensureOk(res) {
  if (res && typeof res === "object" && res.error) {
    const e = new Error(String(res.error));
    e.code = res.code;
    e.status = res.status;
    throw e;
  }
  return res;
}

export function isConflict(x) {
  if (!x) return false;
  const code = x.code || (x.body && x.body.code) || (x.data && x.data.code);
  if (code === "conflict") return true;
  if (Number(x.status) === 409 || Number(x.statusCode) === 409) return true;
  return /\bconflict\b|\b409\b/i.test(String(x.message || x.error || ""));
}

/** Records come back bare, or wrapped as {prompt}/{record}.
 *
 * The derived `label` travels in the envelope BESIDE the record rather than
 * inside it — a derived field inside would end up in the exported file, which
 * is a stored name again by another route. Carry it onto the unwrapped copy so
 * the pane has one shape to read; nothing ever sends this copy back.
 */
export function unwrapRecord(r) {
  if (!r || typeof r !== "object") return null;
  let rec = r;
  if (r.prompt && typeof r.prompt === "object") rec = r.prompt;
  else if (r.record && typeof r.record === "object") rec = r.record;
  if (rec !== r && typeof r.label === "string" && r.label) rec.label = r.label;
  return rec;
}

/** Score as a 0..1 fraction, tolerating a 0..100 payload. */
export function frac(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

export const pct = (v) => Math.round(frac(v) * 100) + "%";

/** Normalise a dupe response into sorted `{id, label, score, summary, body}`.
 *
 * `label` is the backend's derived handle for the match; it falls back to the
 * preview and then to the id, because a row has to say *something* and the id
 * is the only thing every match is guaranteed to have.
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
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function bufferFrom(rec) {
  return {
    tags: Array.isArray(rec && rec.tags) ? rec.tags.map(String) : [],
    body: String((rec && rec.body) || ""),
  };
}

/** Field signature used for the dirty comparison (tags order-insensitive).
 *
 * The label is not in it, and must not be: it is derived from the body and
 * from the rest of the library, so a label that moved because a *different*
 * record was saved is not an unsaved edit of this one.
 */
export function sig(o) {
  if (!o) o = {};
  const tags = Array.isArray(o.tags) ? o.tags.map(String).slice().sort() : [];
  return JSON.stringify([tags.join(""), String(o.body || "")]);
}

/** Accepts a raw body string or the modal's JSON buffer; returns a body. */
export function draftBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw.body == null ? null : String(raw.body);
  const s = String(raw);
  if (s.charAt(0) === "{") {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object") return o.body == null ? null : String(o.body);
    } catch (_) { /* not JSON — treat as a plain body */ }
  }
  return s;
}
