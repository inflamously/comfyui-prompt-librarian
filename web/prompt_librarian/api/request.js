/* Keep the ComfyUI transport import here. api.fetchApi preserves the host
 * and reverse-proxy URL prefixes; direct requests would bypass them.
 */

import { api } from "../../../../scripts/api.js";
import { escapeQuery } from "../shared/format.js";

export const BASE = "/prompt_librarian/";

/** Lanes return ABORTED for superseded/cancelled work; callers should ignore it
 * rather than treat cancellation as an error.
 */
export const ABORTED = Symbol("aborted");


/** Carry HTTP status, response body, and machine-readable backend/transport code.
 */
export class ApiError extends Error {
  constructor(status, body, code) {
    const detail =
      (body && typeof body === "object" && (body.error || body.message)) ||
      (typeof body === "string" && body.trim() ? body.trim().slice(0, 200) : "") ||
      "";
    super(detail || `request failed (${code || status || "error"})`);
    this.name = "ApiError";
    this.status = Number(status) || 0;
    this.body = body == null ? null : body;
    this.code = code || codeForStatus(this.status);
  }

  /** True when retrying could plausibly work (server hiccup, network drop). */
  get transient() {
    return this.status === 0 || this.status >= 500;
  }
}

export function codeForStatus(status) {
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status >= 500) return "internal";
  if (!status) return "network";
  return "http_" + status;
}

/** True for the DOMException an aborted fetch rejects with. */
export function isAbort(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  // Safari/older engines: DOMException code 20 == ABORT_ERR.
  return err.code === 20 && typeof err.name === "string";
}

/** Set JSON Content-Type only when sending a body. Check response Content-Type
 * before parsing so an HTML error page becomes a useful not_json error.
 *
 * @param {string} path route name, appended to BASE
 * @param {{method?: string, body?: any, signal?: AbortSignal, query?: object}} [opts]
 * @returns {Promise<any>} the parsed JSON body
 */
export async function req(path, opts = {}) {
  const method = opts.method || "GET";
  const init = { method };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "Content-Type": "application/json" };
  }
  if (opts.signal) init.signal = opts.signal;

  const url = BASE + path + (opts.query ? escapeQuery(opts.query) : "");

  let res;
  try {
    res = await api.fetchApi(url, init);
  } catch (err) {
    // An abort must propagate untouched so the lane can recognise it.
    if (isAbort(err)) throw err;
    throw new ApiError(0, { error: String((err && err.message) || err) }, "network");
  }

  const ctype = String((res.headers && res.headers.get && res.headers.get("content-type")) || "");
  const isJson = /\bjson\b/i.test(ctype);

  let payload = null;
  if (isJson) {
    try {
      payload = await res.json();
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ApiError(res.status, null, "bad_json");
    }
  } else {
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      if (isAbort(err)) throw err;
    }
    if (!res.ok) throw new ApiError(res.status, text, codeForStatus(res.status));
    throw new ApiError(
      res.status,
      text,
      "not_json"
    );
  }

  if (!res.ok) {
    throw new ApiError(res.status, payload, (payload && payload.code) || codeForStatus(res.status));
  }
  // Treat an error envelope as failure even when the HTTP status is 200.
  if (payload && typeof payload === "object" && payload.code && payload.error) {
    throw new ApiError(res.status, payload, payload.code);
  }
  return payload;
}

/** Fetch a non-JSON download through ComfyUI's prefix-aware transport. */
export async function download(path, opts = {}) {
  let res;
  try {
    res = await api.fetchApi(BASE + path, { method: "GET", signal: opts.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, { error: String((err && err.message) || err) }, "network");
  }
  if (!res.ok) throw new ApiError(res.status, null, codeForStatus(res.status));
  return res.blob();
}

/** Upload one JSON file as multipart without materialising it in JavaScript. */
export async function upload(path, file, opts = {}) {
  const form = new FormData();
  form.append("library", file, (file && file.name) || "library.json");
  const url = BASE + path + (opts.query ? escapeQuery(opts.query) : "");
  let res;
  try {
    res = await api.fetchApi(url, { method: "POST", body: form, signal: opts.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, { error: String((err && err.message) || err) }, "network");
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch (_) {
    /* rendered below as bad_json */
  }
  if (!res.ok || !payload) {
    throw new ApiError(res.status, payload, (payload && payload.code) || "bad_json");
  }
  return payload;
}
