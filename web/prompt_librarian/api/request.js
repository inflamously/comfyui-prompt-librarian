/* ==========================================================================
   Prompt Librarian — the request primitive
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only.

   This is the ONLY file under web/prompt_librarian/ besides the entry that
   imports from ComfyUI. The fragile relative path to the core tree exists
   here and in web/prompt_librarian/index.js, and nowhere else — every other
   module talks to the backend through `API`.

   `api.fetchApi` is used rather than bare `fetch` because it prefixes
   ComfyUI's base URL (`/api`, plus any reverse-proxy prefix). A bare
   `fetch("/prompt_librarian/search")` works on a default install and 404s
   behind a proxy, which is exactly the kind of bug that only shows up on
   somebody else's machine.
   ========================================================================== */

import { api } from "../../../../scripts/api.js";
import { escapeQuery } from "../shared/format.js";

/** Route prefix. Every route is `/prompt_librarian/<name>`. */
export const BASE = "/prompt_librarian/";

/**
 * Returned by a lane's `run()` when the call was superseded or cancelled.
 * A cancellation is NOT an error: every call site would otherwise need a
 * try/catch whose only job is to swallow an AbortError, and the one that
 * forgets turns a keystroke into a red console trace.
 *
 *   const res = await lanes.search((signal) => API.search(params, signal));
 *   if (res === ABORTED) return;      // a newer search is already running
 */
export const ABORTED = Symbol("aborted");

/* --------------------------------------------------------------------------
   Errors
   -------------------------------------------------------------------------- */

/**
 * A backend (or transport) failure with the pieces the UI needs to explain
 * itself: the HTTP status, the parsed body when there was one, and the
 * backend's machine-readable `code` (`bad_request`, `not_found`, `too_large`,
 * `conflict`, `readonly`, `same_record`, `write_failed`, `internal`, plus the
 * transport-side `network`, `not_json` and `bad_json`).
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

/**
 * Perform one request against the librarian routes.
 *
 * Two things here are load-bearing:
 *
 * 1. `Content-Type: application/json` is set ONLY when there is a body. Some
 *    aiohttp/proxy stacks treat a content-type on an empty GET as a malformed
 *    request, and it is meaningless anyway.
 * 2. The response's content-type is CHECKED before parsing. If the backend
 *    routes were never registered (an import error in
 *    `prompt_librarian/api/`, a ComfyUI version whose route table differs)
 *    the server answers with an HTML 404 page. `res.json()` on that throws a
 *    SyntaxError with a message about "<" — an unreadable error for the most
 *    likely real-world failure.
 *    A non-JSON response therefore becomes a clean ApiError with code
 *    `not_json`, which the modal renders as "the librarian backend is not
 *    responding".
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
  // The guard in prompt_librarian/api/ answers errors with a non-2xx status,
  // but a handler that returns 200 with {error, code} must not be mistaken for
  // data.
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
