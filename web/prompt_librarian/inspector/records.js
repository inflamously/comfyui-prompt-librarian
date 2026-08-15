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

/** Records come back bare, or wrapped as {prompt}/{record}. */
export function unwrapRecord(r) {
  if (!r || typeof r !== "object") return null;
  if (r.prompt && typeof r.prompt === "object") return r.prompt;
  if (r.record && typeof r.record === "object") return r.record;
  return r;
}

/** Score as a 0..1 fraction, tolerating a 0..100 payload. */
export function frac(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

export const pct = (v) => Math.round(frac(v) * 100) + "%";

/** Normalise a dupe response into sorted `{id, name, score, summary, body}`. */
export function matchesOf(r) {
  const arr = Array.isArray(r) ? r : (r && (r.matches || r.dupes)) || [];
  const out = [];
  for (const m of arr) {
    if (!m) continue;
    out.push({
      id: m.id != null ? String(m.id) : "",
      name: String(m.name || m.id || "(unnamed)"),
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
    name: String((rec && rec.name) || ""),
    tags: Array.isArray(rec && rec.tags) ? rec.tags.map(String) : [],
    body: String((rec && rec.body) || ""),
  };
}

/** Field signature used for the dirty comparison (tags order-insensitive). */
export function sig(o) {
  if (!o) o = {};
  const tags = Array.isArray(o.tags) ? o.tags.map(String).slice().sort() : [];
  return JSON.stringify([String(o.name || ""), tags.join(""), String(o.body || "")]);
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
