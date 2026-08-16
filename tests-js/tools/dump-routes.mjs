#!/usr/bin/env node
/* ==========================================================================
   Dump the JS API surface as JSON, for the cross-language route contract.

       node tests-js/tools/dump-routes.mjs

   Every method on `API` is invoked against a recording `fetchApi` that always
   rejects, so the URL and body are captured but no flow continues. Recording at
   the TRANSPORT boundary rather than mocking `req` means what is reported is
   literally what would go on the wire — and it exercises BASE + escapeQuery
   composition for free.

   Consumed by tests/test_route_contract.py, which compares the result against
   the Python route table. Deliberately does NOT read openapi.json: that file is
   gitignored, generated on demand, and needs pydantic.
   ========================================================================== */

import { imp, seedHost } from "../harness/mount.js";

/**
 * Every method on `API`, with placeholder arguments realistic enough that the
 * required body keys are present.
 *
 * This table is itself a test: a method added to routes.js without an entry
 * here fails the "every method was called" assertion below, so the contract
 * cannot silently stop covering part of the surface.
 */
const CALLS = {
  ping: [],
  search: [{ q: "x", tags: ["t"], limit: 10 }],
  get: ["ID"],
  meta: [["ID"]],
  taxonomy: [],
  versions: ["ID"],
  version: ["ID", 0],
  dupesAll: [0.9],
  wildcards: [],
  snippets: [],
  exportRaw: [],
  create: [{ body: "B", tags: ["t"] }],
  update: [{ id: "ID", body: "B", tags: ["t"], expect_updated: "TS" }],
  del: ["ID"],
  bulkDelete: [{ ids: ["ID"] }],
  bulkRetag: [{ ids: ["ID"] }, ["add"], ["remove"]],
  bulkMerge: [{ ids: ["ID"] }, "ID"],
  rate: ["ID", 3],
  usage: ["ID", { body: "B" }],
  dupes: [{ text: "B", exclude_id: "ID", threshold: 0.9, limit: 5, summaries: false }],
  ignorePair: ["A", "B"],
  compare: [{ a_id: "A", a_text: "TA", b_id: "B", b_text: "TB" }],
  merge: [{ winner_id: "A", loser_id: "B", body: "B" }],
  mergeNew: [{ a_id: "A", b_id: "B", body: "B", tags: ["t"] }],
  restoreVersion: ["ID", 0],
  resolve: [{ text: "B", seed: 1, n: 1 }],
  setSnippet: ["NAME", "BODY"],
  delSnippet: ["NAME"],
  settings: [{ dupe_threshold: 0.9 }],
  importRaw: [{ prompts: [] }, "replace"],
};

const seen = [];

const host = seedHost();
host.api.fetchApi = (rawUrl, init = {}) => {
  const url = String(rawUrl);
  const [path, query] = url.split("?");
  let body;
  if (init.body !== undefined) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = null;
    }
  }
  seen.push({
    method: (init.method || "GET").toLowerCase(),
    path,
    // JSON.stringify drops `undefined`, so this is what the wire carries —
    // not every optional key the method mentions.
    body: body && typeof body === "object" ? Object.keys(body).sort() : [],
    query: query ? [...new URLSearchParams(query).keys()].sort() : [],
  });
  // Reject so nothing downstream of the request runs.
  return Promise.reject(new Error("dump-routes: transport stopped here"));
};

const { API } = await imp("prompt_librarian/api/routes.js");

const methods = Object.keys(API).filter((k) => typeof API[k] === "function").sort();
const missing = methods.filter((m) => !(m in CALLS));
if (missing.length) {
  console.error(`dump-routes.mjs: no placeholder args for: ${missing.join(", ")}`);
  process.exit(2);
}

const records = [];
for (const name of methods) {
  const before = seen.length;
  try {
    await API[name](...CALLS[name]);
  } catch {
    /* the transport always rejects; that is the point */
  }
  const made = seen.slice(before);
  if (made.length !== 1) {
    console.error(`dump-routes.mjs: ${name} made ${made.length} requests, expected 1`);
    process.exit(2);
  }
  records.push({ fn: name, ...made[0] });
}

process.stdout.write(JSON.stringify(records, null, 2) + "\n");
