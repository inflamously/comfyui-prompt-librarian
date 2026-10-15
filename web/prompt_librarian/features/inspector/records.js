/* Record and buffer helpers for the inspector: pure functions. */

/** A readable message for anything thrown or returned as an error. */
export function errMsg(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return String(e.message || e.error || e.code || e);
}

/** Whether an error is the backend's optimistic-concurrency conflict (409). */
export function isConflict(x) {
  if (!x) return false;
  const code = x.code || (x.body && x.body.code) || (x.data && x.data.code);
  if (code === "conflict") return true;
  if (Number(x.status) === 409 || Number(x.statusCode) === 409) return true;
  return /\bconflict\b|\b409\b/i.test(String(x.message || x.error || ""));
}

/** Accept bare records or envelopes; carry the derived envelope label into the
 * view copy without adding it to the persisted record.
 */
export function unwrapRecord(r) {
  if (!r || typeof r !== "object") return null;
  let rec = r;
  if (r.prompt && typeof r.prompt === "object") rec = r.prompt;
  else if (r.record && typeof r.record === "object") rec = r.record;
  if (rec !== r && typeof r.label === "string" && r.label) rec.label = r.label;
  return rec;
}

/** The editable part of a record: {tags, body}. */
export function bufferFrom(rec) {
  return {
    tags: Array.isArray(rec && rec.tags) ? rec.tags.map(String) : [],
    body: String((rec && rec.body) || ""),
  };
}

/** A comparison key for dirty checks. Corpus-derived labels are left out:
 * unrelated writes change them. */
export function sig(o) {
  if (!o) o = {};
  const tags = Array.isArray(o.tags) ? o.tags.map(String).slice().sort() : [];
  // Serialize the array: joined strings could collide and mark a retagged record clean.
  return JSON.stringify([tags, String(o.body || "")]);
}

/** A stored draft's body; accepts the JSON buffer, a raw body string, or null. */
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
