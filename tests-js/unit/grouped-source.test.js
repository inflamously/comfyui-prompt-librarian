/* ==========================================================================
   browse/grouped-source.js — the duplicate accordion's index mapping

   No DOM and no network: a fake PagedSource is enough, because the whole
   contract is "which flat index is which record". That mapping is what keeps
   `VirtualList` — which places every row at `i * rowH` and knows nothing about
   groups — correct while clusters open and close underneath it.
   ========================================================================== */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const { GroupedView, attachMembers, MEMBERS } = await imp(
  "prompt_librarian/browse/grouped-source.js",
);

/** A resident-everything stand-in for PagedSource. */
function fakeSource(rows, recordTotal) {
  return {
    rows,
    total: rows.length,
    recordTotal: recordTotal == null ? rows.length : recordTotal,
    known: true,
    busy: false,
    pages: new Map([[0, rows]]),
    get(i) {
      return this.rows[i] || null;
    },
    peek(i) {
      return this.rows[i] || null;
    },
    load() {
      return Promise.resolve();
    },
    reset() {
      this.didReset = true;
    },
    ensureRange(a, b) {
      this.ranged = [a, b];
      return Promise.resolve();
    },
  };
}

function row(id, members = []) {
  return { id, label: id, group_size: 1 + members.length, [MEMBERS]: members };
}

/** rows: [plain, cluster-of-3, plain] — 3 rows standing for 5 records. */
function fixture() {
  const rows = [
    row("solo"),
    row("rep", [{ id: "m1" }, { id: "m2" }]),
    row("other"),
  ];
  return new GroupedView(fakeSource(rows, 5));
}

describe("attachMembers", () => {
  test("moves the sibling map onto the hits it belongs to", () => {
    const res = {
      hits: [{ id: "rep" }, { id: "solo" }],
      groups: { rep: [{ id: "m1" }] },
    };
    const hits = attachMembers(res);
    assert.equal(hits[0][MEMBERS].length, 1);
    assert.deepEqual(hits[1][MEMBERS], [], "a hit with no cluster gets an empty list");
  });

  test("survives a payload with no groups at all", () => {
    assert.deepEqual(attachMembers({ hits: [{ id: "a" }] })[0][MEMBERS], []);
    assert.deepEqual(attachMembers(null), []);
    assert.deepEqual(attachMembers({}), []);
  });
});

describe("collapsed", () => {
  test("a cluster is exactly one row", () => {
    const v = fixture();
    assert.equal(v.total, 3);
    assert.deepEqual([v.get(0).id, v.get(1).id, v.get(2).id], ["solo", "rep", "other"]);
    assert.equal(v.isMember(1), false);
  });

  test("row count and record count are different numbers, on purpose", () => {
    const v = fixture();
    assert.equal(v.total, 3);
    assert.equal(v.recordTotal, 5);
  });
});

describe("expanded", () => {
  test("opening inserts the members directly below the header", () => {
    const v = fixture();
    assert.equal(v.toggle(1), true);
    assert.equal(v.total, 5);
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((i) => v.get(i).id),
      ["solo", "rep", "m1", "m2", "other"],
    );
    assert.deepEqual([1, 2, 3, 4].map((i) => v.isMember(i)), [false, true, true, false]);
  });

  test("everything after an open group shifts by exactly its member count", () => {
    const v = fixture();
    assert.equal(v.toFlat(2), 2, "closed: top index and flat index agree");
    v.toggle(1);
    assert.equal(v.toFlat(2), 4, "open: 'other' moved down past two members");
    assert.equal(v.locate(4).top, 2);
  });

  test("closing puts it back", () => {
    const v = fixture();
    v.toggle(1);
    v.toggle(1);
    assert.equal(v.total, 3);
    assert.equal(v.get(2).id, "other");
  });

  test("a plain row is not a group and cannot be toggled", () => {
    const v = fixture();
    assert.equal(v.toggle(0), false);
    assert.equal(v.total, 3);
  });

  test("a member row is not itself a group", () => {
    const v = fixture();
    v.toggle(1);
    assert.equal(v.toggle(2), false, "index 2 is m1, not a header");
    assert.equal(v.total, 5);
  });

  test("reset closes everything and resets the source", () => {
    const v = fixture();
    v.toggle(1);
    v.reset();
    assert.equal(v.total, 3);
    assert.equal(v.source.didReset, true);
  });
});

describe("stale spans self-heal", () => {
  test("a group whose representative moved is dropped, not honoured", () => {
    // A save can replace a page under an open group. Trusting the remembered
    // index would shift every row below it by two for the rest of the session.
    const v = fixture();
    v.toggle(1);
    assert.equal(v.total, 5);
    v.source.rows[1] = row("someone-else");
    assert.equal(v.total, 3, "the span was dropped rather than applied blind");
    assert.equal(v.expanded.size, 0);
  });

  test("an unloaded page is 'not here yet', not 'moved'", () => {
    const v = fixture();
    v.toggle(1);
    v.source.peek = () => null; // every index is a hole
    assert.equal(v.total, 5, "the span survives a hole");
  });
});

describe("idsAt — what a row stands for", () => {
  test("a collapsed cluster stands for every record in it", () => {
    const v = fixture();
    assert.deepEqual(v.idsAt(1), ["rep", "m1", "m2"]);
  });

  test("so does an open one, from its header", () => {
    const v = fixture();
    v.toggle(1);
    assert.deepEqual(v.idsAt(1), ["rep", "m1", "m2"]);
  });

  test("a member stands for itself alone", () => {
    const v = fixture();
    v.toggle(1);
    assert.deepEqual(v.idsAt(2), ["m1"]);
    assert.deepEqual(v.idsAt(3), ["m2"]);
  });

  test("a plain row stands for itself", () => {
    assert.deepEqual(fixture().idsAt(0), ["solo"]);
  });
});

describe("idsInRange", () => {
  test("a range over a collapsed cluster covers its hidden members", async () => {
    const v = fixture();
    assert.deepEqual(await v.idsInRange(0, 2), ["solo", "rep", "m1", "m2", "other"]);
  });

  test("an open cluster does not double-count its members", async () => {
    const v = fixture();
    v.toggle(1);
    assert.deepEqual(await v.idsInRange(0, 4), ["solo", "rep", "m1", "m2", "other"]);
  });

  test("the range is loaded in TOP-LEVEL indices, which is what pages", async () => {
    const v = fixture();
    v.toggle(1);
    await v.idsInRange(0, 4);
    assert.deepEqual(v.source.ranged, [0, 2], "flat 0..4 is top-level 0..2");
  });

  test("a range that runs past the end simply stops", async () => {
    const v = fixture();
    assert.deepEqual(await v.idsInRange(2, 99), ["other"]);
  });
});
