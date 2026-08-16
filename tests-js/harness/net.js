/* ==========================================================================
   The network seam

   web/prompt_librarian/api/request.js:120 is the ONLY place the pack talks to
   the network (`api.fetchApi`), and tier 0 asserts it stays that way. So one
   stub here covers 100% of transport, with no fetch interception anywhere.
   ========================================================================== */

/**
 * Build a fake ComfyUI `api` object.
 *
 * Routes are matched by URL prefix, LONGEST FIRST — `/prompt_librarian/dupes`
 * is a prefix of `/prompt_librarian/dupes/all`, so insertion order alone gets
 * the wrong one and the bug looks like a backend problem.
 *
 * An unstubbed URL REJECTS rather than hanging or 404ing: a test that reaches
 * an unexpected endpoint should fail by name, immediately.
 */
export function createApi() {
  const routes = [];
  const calls = [];

  const respond = (value) => {
    const spec = value && value.__http ? value : { json: value };
    const { status = 200, json = null, ctype = "application/json", text } = spec;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k) => (String(k).toLowerCase() === "content-type" ? ctype : null),
      },
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(text ?? JSON.stringify(json)),
    };
  };

  const api = {
    fetchApi(rawUrl, init = {}) {
      const url = String(rawUrl);
      const [pathname, query] = url.split("?");
      let body;
      if (init.body !== undefined) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({
        url,
        path: pathname,
        method: (init.method || "GET").toUpperCase(),
        query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
        body,
        headers: init.headers,
        signal: init.signal,
      });

      if (init.signal && init.signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }

      const hit = routes
        .filter((r) => pathname.startsWith(r.prefix))
        .sort((a, b) => b.prefix.length - a.prefix.length)[0];

      if (!hit) {
        return Promise.reject(
          new Error(`no stub for ${(init.method || "GET").toUpperCase()} ${url}`),
        );
      }
      return Promise.resolve(hit.fn({ url, path: pathname, init, body })).then(respond);
    },

    // The pack never registers listeners today; tier 0 would notice if it did.
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},

    /** @param {string} prefix @param {any|Function} value payload or handler */
    route(prefix, value) {
      routes.push({ prefix, fn: typeof value === "function" ? value : () => value });
      return api;
    },

    calls,
    /** Calls whose path ends with `suffix` — the readable way to assert. */
    callsTo(suffix) {
      return calls.filter((c) => c.path.endsWith(suffix));
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
    },
  };
  return api;
}

/**
 * Wrap a payload with an explicit HTTP shape, for the error paths.
 *
 *   http({ status: 409, json: { error: "stale", code: "conflict" } })
 *   http({ status: 404, ctype: "text/html", text: "<html>404</html>" })
 */
export function http(spec) {
  return { __http: true, ...spec };
}
