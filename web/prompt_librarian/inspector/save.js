/* ==========================================================================
   THE SAVE FLOW — the feature this pane exists for
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

       NEVER A SILENT OVERWRITE

   SAVING CREATES BY DEFAULT. Ctrl+S, the primary button and every save-on-
   leave path pass `asNew` — they mint a new record. Overwriting is plan B:
   the inspector's secondary `Update` button for the record in the editor, and
   the `merge` / `overwrite` rows of the duplicate panel's `revise` dialog
   (inspector/dupes.js) for anything else.

   NEAR DUPLICATES NO LONGER BLOCK A SAVE. There used to be a "Possible
   duplicate — nothing saved yet" dialog in the middle of this path; it is
   gone. Creating is now the default, so a near match costs an extra record
   rather than someone else's text, and the standing duplicate panel below the
   editor — amber, with `revise` on it — is where that gets resolved, on the
   user's own clock. What survives here is the EXACT-copy shortcut, which is
   not a decision anyone would want to be asked about.

   The save path:
     1. not dirty, with a record loaded       -> stop, say so
     2. staleness check (someone else edited) -> conflict UI, stop
     3. exact-copy check: a 1.00 match while creating means there is nothing
        to write, so the stored record is adopted and the save ends "clean"
     4. commit (create | update+expect_updated); 409 re-enters step 2
     5. adopt the server's record as both `current` and `baseline`

   Step 2 builds its dialog INLINE via the pane's own layer host rather than
   through compare/: refusing a silent overwrite is the safety property left
   on this path, and it must still work on an install where compare/ failed
   to load.

   SHAPE. `SaveFlow` is the class that owns the effects — one instance per
   pane, holding the pane and nothing else. Every DECISION it makes is a pure
   function exported above it (`preflight`, `classifyMatches`, `exactAction`,
   `expectUpdatedFor`, `sameContent`, `nearMessage`): same input, same output,
   no `pane`, no API, no DOM. Those are the parts worth reasoning about and
   testing directly; the methods around them are plumbing that talks to the
   backend and the screen.

   `createSave(pane)` stays the entry point and still hangs the methods off
   `pane` — index.js, dupes.js, view.js and modal/close.js call them there.

   SAVE STATUS — what `save()` returns. Ctrl+S ignores it; the close path in
   modal/close.js needs it, because "I put a dialog on screen" and "I wrote the
   record" are the same `undefined` otherwise:

     "saved"    committed; the buffer is now clean
     "clean"    nothing to write — already matches what is stored
     "blocked"  the conflict dialog is on screen, or the body is empty. The
                modal must stay open.
     "failed"   the write or its pre-flight errored; a toast says why
     "busy"     a save is already in flight, or the pane is disposed

   Only "saved" and "clean" mean it is safe to close. The vocabulary is
   duplicated as a comment in modal/ctx.js and compared there as a plain
   string — modal/ must not import from inspector/, which is lazily loaded and
   optional.
   ========================================================================== */

import { LDQUO, MDASH, MIDDOT, RDQUO } from "./constants.js";
import { bufferFrom, ensureOk, errMsg, isConflict, matchesOf, sig, unwrapRecord } from "./records.js";

/**
 * A similarity at or above this is "the same text", not "similar text": the
 * backend scores on normalized bodies, so 1.00 means the two normalize to the
 * same string. Just under 1 to stay clear of float noise.
 */
export const EXACT = 0.9999;

/* ==========================================================================
   PURE DECISIONS — no pane, no API, no DOM. Everything below `SaveFlow` uses
   these; nothing here reaches back out.
   ========================================================================== */

/**
 * Step 1. What, if anything, stops the save before any request is made.
 *
 * @param {{disposed?:boolean, saving?:boolean, dirty?:boolean,
 *          hasRecord?:boolean, body?:string}} s
 * @returns {null|{status:"busy"|"clean"|"blocked", toast?:string,
 *                 tone?:string, focusBody?:boolean}}
 *   null when the save may proceed.
 */
export function preflight(s) {
  if (s.disposed || s.saving) return { status: "busy" };
  // Nothing typed since the record was loaded: there is nothing to write,
  // whichever mode we are in. This matters more now that "save as new" is the
  // default — without it, Ctrl+S on an untouched record would go and ask the
  // backend whether it is a duplicate of itself, and a dupe-check outage
  // (which saves anyway, by design) would fork the record for no reason.
  if (!s.dirty && s.hasRecord) return { status: "clean", toast: "no changes" };
  // The body is the only thing a record needs. There is nothing else to ask
  // the user for before saving — the handle is derived from this text.
  if (!String(s.body || "").trim()) {
    return { status: "blocked", toast: "prompt text is empty", tone: "error", focusBody: true };
  }
  return null;
}

/** True when this save writes over the record in the editor rather than creating. */
export function isUpdateSave(asNew, current) {
  return !asNew && !!(current && current.id);
}

/**
 * Step 3, part one. Reduce the dupe-check matches to the two things the flow
 * acts on: how many near matches to mention, and the exact copy (if any).
 *
 * `m.ignored` is the "keep both" decision taken elsewhere (compare/), and it
 * still applies: a muted pair must not resurface as an adoption. The record in
 * the editor is only "not a match" when we are about to update it — creating
 * from an edited copy of it, it is the most relevant match there is.
 *
 * @returns {{near:number, exact:object|null}}
 */
export function classifyMatches(matches, { threshold, isUpdate, curId }) {
  const found = (matches || []).filter(
    (m) => !m.ignored && !(isUpdate && String(m.id) === String(curId))
  );
  return {
    near: found.filter((m) => m.score >= threshold).length,
    exact: found.find((m) => m.score >= EXACT) || null,
  };
}

/**
 * Step 3, part two. What an exact match means for this save.
 *
 * The body is what the dupe check scores, so an "exact" match says nothing
 * about the TAGS. Retagging a record without touching its text lands here —
 * the record in the editor is its own exact match, since `exclude_id` is null
 * while creating. Adopting it would put the stored tags back over the ones
 * just typed and call it "already saved". So: same record, tags moved ->
 * update it in place rather than mint an identical-bodied twin.
 *
 * @returns {"commit"|"update-current"|"adopt"}
 */
export function exactAction({ exact, isUpdate, curId }) {
  if (!exact || isUpdate) return "commit";
  if (curId && String(exact.id) === String(curId)) return "update-current";
  return "adopt";
}

/**
 * True when the stored record and the buffer hold the same prompt — body AND
 * tags. `adoptExact` throws the buffer away, so it is only "nothing added"
 * when the tags match too. The body is compared trimmed (the backend scores
 * normalized text); the tags go through sig() so their order does not matter.
 */
export function sameContent(rec, buf) {
  if (!rec) return false;
  if (String(rec.body || "").trim() !== String((buf && buf.body) || "").trim()) return false;
  return sig({ tags: bufferFrom(rec).tags }) === sig({ tags: (buf && buf.tags) || [] });
}

/** The `expect_updated` an update carries: an explicit override, else the baseline's. */
export function expectUpdatedFor(baseline, opts = {}) {
  if (opts.expectUpdated !== undefined) return opts.expectUpdated;
  return baseline ? baseline.updated : undefined;
}

/** The "saved, but look at the panel" line. `fmtInt` keeps this free of `D`. */
export function nearMessage(near, fmtInt) {
  return (
    "saved " + MDASH + " " + fmtInt(near) + " near match" + (near === 1 ? "" : "es") +
    ", see the duplicate panel"
  );
}

/* ==========================================================================
   THE EFFECTS
   ========================================================================== */

export class SaveFlow {
  /** @param {object} pane */
  constructor(pane) {
    this.pane = pane;
    this.ctx = pane.ctx;
    this.D = pane.D;
    this.h = pane.D.h;
    // Bound once: these are handed to index.js/dupes.js as bare functions and
    // used as event handlers, where `this` would otherwise be lost.
    for (const name of [
      "setSaving", "save", "commit", "adoptExact", "openConflict", "mergeInto", "overwriteMatch",
    ]) {
      this[name] = this[name].bind(this);
    }
  }

  setSaving(on) {
    this.pane.saving = !!on;
    this.pane.renderActions();
  }

  /** @returns {Promise<"saved"|"clean"|"blocked"|"failed"|"busy">} see the header */
  async save(asNew) {
    const { pane, D } = this;

    // ---- 1. pre-flight --------------------------------------------------
    const stop = preflight({
      disposed: pane.disposed,
      saving: pane.saving,
      dirty: pane.isDirty(),
      hasRecord: !!(pane.current && pane.current.id),
      body: pane.buf.body,
    });
    if (stop) {
      if (stop.toast) pane.toast(stop.toast, stop.tone);
      if (stop.focusBody) pane.focusBody();
      return stop.status;
    }

    const isUpdate = isUpdateSave(asNew, pane.current);
    this.setSaving(true);
    try {
      // ---- 2. staleness -------------------------------------------------
      if (isUpdate) {
        const verdict = await this.checkStale(asNew);
        if (verdict) return verdict;
      }

      // ---- 3. exact-copy check ------------------------------------------
      // NOT a gate any more: near matches do not stop a save, they light up
      // the duplicate panel below the editor, whose `revise` button owns
      // merge / overwrite. Only a 1.00 match is acted on here, because that is
      // not a decision — it is the same text, and writing it would add a
      // second identical record for nothing.
      const { near, exact } = await this.findMatches(isUpdate);
      if (pane.disposed) return "busy";

      // An exact copy of something already stored, with nothing of our own to
      // update: writing it would add a second identical record and nothing
      // else. Adopt the one that exists instead — the buffer ends up clean, so
      // this counts as saved and the modal may close.
      const action = exactAction({
        exact,
        isUpdate,
        curId: pane.current && pane.current.id,
      });
      if (action === "update-current") {
        const rec = await this.commit(false);
        return rec ? "saved" : "failed";
      }
      if (action === "adopt" && (await this.adoptExact(exact))) return "clean";

      // ---- 5. commit ----------------------------------------------------
      const rec = await this.commit(asNew);
      if (!rec) return "failed";
      // Near matches are reported, never blocking: `commit` has already
      // re-run the live check, so the panel below is amber with a `revise`
      // button on it. This line is only so the outcome is not silent.
      if (near) pane.toast(nearMessage(near, D.fmtInt));
      return "saved";
    } finally {
      this.setSaving(false);
    }
  }

  /**
   * Step 2. `null` when the save may go on; a status when it may not (the
   * conflict dialog is up, or the record is gone).
   *
   * @returns {Promise<null|"failed"|"blocked">}
   */
  async checkStale(asNew) {
    const { pane, ctx } = this;
    let fresh = null;
    try {
      fresh = unwrapRecord(ensureOk(await ctx.API.get(pane.current.id)));
    } catch (err) {
      pane.toast("could not check for remote changes: " + errMsg(err), "error");
      return "failed";
    }
    if (!fresh || !fresh.id) { pane.toast("this prompt no longer exists", "error"); return "failed"; }
    if (pane.baseline && String(fresh.updated || "") !== String(pane.baseline.updated || "")) {
      this.openConflict(fresh, asNew);
      return "blocked";
    }
    return null;
  }

  /**
   * Step 3's request. Deliberately NOT through ctx.lanes.dupe: a keystroke
   * landing mid-save must not be able to abort the check. Freshly run every
   * time, whatever the live panel happens to be showing.
   *
   * An outage here costs the exact-copy shortcut, nothing more: the save goes
   * ahead and the panel below will say what it finds next time.
   *
   * @returns {Promise<{near:number, exact:object|null}>}
   */
  async findMatches(isUpdate) {
    const { pane, ctx } = this;
    const threshold = pane.threshold();
    try {
      const r = await ctx.API.dupes({
        body: pane.buf.body,
        exclude_id: isUpdate ? pane.current.id : null,
        threshold,
        summaries: true,
        limit: 10,
      });
      if (r === ctx.ABORTED) return { near: 0, exact: null };
      return classifyMatches(matchesOf(ensureOk(r)), {
        threshold,
        isUpdate,
        curId: pane.current && pane.current.id,
      });
    } catch (_) {
      return { near: 0, exact: null };
    }
  }

  /**
   * Step 5. `create` or `update` with expect_updated; a 409 falls back into
   * the conflict branch rather than a generic error toast.
   */
  async commit(asNew, opts = {}) {
    const { pane, ctx, D } = this;
    const payload = pane.getBuffer();
    const isUpdate = isUpdateSave(asNew, pane.current);
    let rec = null;
    try {
      if (isUpdate) {
        rec = unwrapRecord(
          ensureOk(
            await ctx.API.update(
              Object.assign({}, payload, {
                id: pane.current.id,
                expect_updated: expectUpdatedFor(pane.baseline, opts),
              })
            )
          )
        );
      } else {
        rec = unwrapRecord(ensureOk(await ctx.API.create(payload)));
      }
    } catch (err) {
      if (isUpdate && isConflict(err)) {
        let fresh = null;
        try { fresh = unwrapRecord(ensureOk(await ctx.API.get(pane.current.id))); } catch (_) { fresh = null; }
        if (fresh) { this.openConflict(fresh, asNew); return null; }
      }
      pane.toast("save failed: " + errMsg(err), "error");
      return null;
    }
    if (!rec || !rec.id) { pane.toast("save failed: no record returned", "error"); return null; }
    if (pane.current && pane.current.id) pane.clearDraft(pane.current.id);
    pane.clearDraft(rec.id);
    // push: a save can MINT AN ID ("save as new"). If the node keeps the old
    // one — or none — usage silently stops counting against what just saved.
    pane.adoptRecord(rec, { silent: false, push: true });
    pane.toast(isUpdate ? "saved" : "created " + LDQUO + D.labelOf(rec) + RDQUO, "success");
    this.afterWrite();
    return rec;
  }

  /** The three things every successful write does to the rest of the UI. */
  afterWrite() {
    const { pane, ctx } = this;
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
  }

  /**
   * The "you already have this" path: select the stored record instead of
   * creating a copy of it.
   *
   * Deliberately NOT a silent no-op — the panel switches to the record that
   * matched, so the user can see the thing their text turned out to be, and
   * the node ends up pointing at a real id (`push`) rather than at nothing.
   *
   * @returns {Promise<boolean>} false when the record could not be loaded, in
   *   which case the caller falls through to the normal duplicate dialog.
   */
  async adoptExact(m) {
    const { pane, ctx, D } = this;
    let rec = null;
    try {
      rec = unwrapRecord(ensureOk(await ctx.API.get(m.id)));
    } catch (_) {
      rec = null;
    }
    if (!rec || !rec.id || pane.disposed) return false;
    // Only when it really is identical: `get` is a second opinion on a score
    // that was computed against a snapshot of the corpus.
    if (!sameContent(rec, pane.buf)) return false;
    pane.clearDraft(rec.id);
    if (pane.current && pane.current.id) pane.clearDraft(pane.current.id);
    pane.adoptRecord(rec, { silent: false, push: true });
    pane.toast("already saved as " + LDQUO + D.labelOf(rec) + RDQUO + " " + MDASH + " nothing added", "success");
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
    return true;
  }

  /* ---- Conflict UI (step 2) ---------------------------------------- */

  openConflict(fresh, asNew) {
    const { pane, D, h } = this;
    const dlg = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Edit conflict" });
    let layer = null;
    const close = () => { if (layer) layer.close(); };

    const body = h(
      "div",
      { className: "pl-dialog-body" },
      h(
        "p",
        null,
        LDQUO + (D.labelOf(fresh) || fresh.id) + RDQUO + " changed somewhere else " +
          (D.relTime(fresh.updated) ? "(" + D.relTime(fresh.updated) + " ago)" : "") +
          " while you were editing. Saving now would overwrite that change."
      ),
      h(
        "p",
        null,
        "Yours: " + D.fmtInt(D.charCount(pane.buf.body)) + " chars " + MIDDOT + " theirs: " +
          D.fmtInt(D.charCount(String(fresh.body || ""))) + " chars."
      )
    );

    const acts = h(
      "div",
      { className: "pl-dialog-acts" },
      h(
        "button",
        {
          className: "pl-btn",
          type: "button",
          onclick: () => {
            close();
            pane.compareConflict(fresh);
          },
        },
        "compare"
      ),
      h(
        "button",
        {
          className: "pl-btn",
          type: "button",
          onclick: () => {
            close();
            // Take the server's copy; the local edit is dropped (it is still
            // in the sessionStorage draft until the next clean save).
            pane.saveDraft();
            pane.adoptRecord(fresh, { silent: false, push: true });
            pane.maybeOfferDraft(fresh);
            pane.toast("reloaded their version");
            pane.scheduleDupes.cancel();
            pane.runDupes(false);
          },
        },
        "keep theirs"
      ),
      h(
        "button",
        {
          className: "pl-btn pl-btn-primary",
          type: "button",
          onclick: async () => {
            close();
            // Re-baseline onto the fresh record so expect_updated matches,
            // then commit — an explicit, confirmed overwrite.
            this.setSaving(true);
            try {
              pane.baseline = JSON.parse(JSON.stringify(fresh));
              pane.current = Object.assign({}, pane.current || {}, { id: fresh.id, updated: fresh.updated });
              await this.commit(asNew, { expectUpdated: fresh.updated });
            } finally {
              this.setSaving(false);
            }
          },
        },
        "keep mine (overwrite)"
      ),
      h("button", { className: "pl-btn pl-btn-ghost", type: "button", onclick: () => close() }, "cancel")
    );

    dlg.appendChild(h("div", { className: "pl-dialog-title" }, "This prompt changed elsewhere"));
    dlg.appendChild(body);
    dlg.appendChild(acts);
    layer = pane.openLayer(dlg, { closeOnOutside: false });
    return layer;
  }

  /** "merge into this" / the live panel's `merge` — the match wins. */
  async mergeInto(m, opts = {}) {
    const { pane, ctx, D } = this;
    if (!m || !m.id) return;
    const mine = pane.current && pane.current.id ? String(pane.current.id) : null;
    let ok = false;
    try {
      ok = await ctx.confirmDialog({
        title: "Merge",
        message:
          "Merge into " + LDQUO + m.label + RDQUO + "? It keeps the id, usage count and history; " +
          (mine ? "this record is absorbed and removed." : "your text becomes its current body."),
        confirmLabel: "Merge",
        cancelLabel: "Cancel",
        danger: false,
      });
    } catch (_) { ok = false; }
    if (!ok || pane.disposed) return;
    if (opts.close) opts.close();

    try {
      let rec;
      if (mine && mine !== String(m.id)) {
        rec = unwrapRecord(
          ensureOk(
            await ctx.API.merge({ winner_id: m.id, loser_id: mine, body: pane.buf.body })
          )
        );
      } else {
        // Nothing of ours is saved yet: absorb by updating the match itself.
        rec = await this.replaceBodyOf(m.id);
      }
      if (mine) pane.clearDraft(mine);
      if (rec && rec.id) {
        pane.clearDraft(rec.id);
        pane.adoptRecord(rec, { silent: false, push: true });
        pane.toast("merged into " + LDQUO + D.labelOf(rec) + RDQUO, "success");
      } else {
        pane.toast("merged", "success");
      }
      this.afterWrite();
    } catch (err) {
      pane.toast("merge failed: " + errMsg(err), "error");
    }
  }

  /** "overwrite that one" — my text replaces the match's body. */
  async overwriteMatch(m, close) {
    const { pane, ctx } = this;
    if (!m || !m.id) return;
    let ok = false;
    try {
      ok = await ctx.confirmDialog({
        title: "Overwrite " + LDQUO + m.label + RDQUO + "?",
        message:
          "Replaces the text of " + LDQUO + m.label + RDQUO + " with what you have here. " +
          "Its previous text is kept in that record's version history.",
        confirmLabel: "Overwrite",
        cancelLabel: "Cancel",
        danger: true,
      });
    } catch (_) { ok = false; }
    if (!ok || pane.disposed) return;
    if (close) close();
    try {
      const rec = await this.replaceBodyOf(m.id);
      if (rec && rec.id) {
        pane.clearDraft(rec.id);
        pane.adoptRecord(rec, { silent: false, push: true });
      }
      pane.toast("overwrote " + LDQUO + m.label + RDQUO, "success");
      this.afterWrite();
    } catch (err) {
      pane.toast("overwrite failed: " + errMsg(err), "error");
    }
  }

  /**
   * Put the buffer's body onto someone else's record, keeping their tags and
   * passing their own `updated` as expect_updated. Shared by merge (when
   * nothing of ours is saved yet) and overwrite. Throws — both callers report.
   */
  async replaceBodyOf(id) {
    const { pane, ctx } = this;
    const fresh = unwrapRecord(ensureOk(await ctx.API.get(id)));
    if (!fresh || !fresh.id) throw new Error("that prompt no longer exists");
    return unwrapRecord(
      ensureOk(
        await ctx.API.update({
          id: fresh.id,
          tags: fresh.tags,
          body: pane.buf.body,
          expect_updated: fresh.updated,
        })
      )
    );
  }
}

/**
 * The entry point the pane uses. Builds the flow and hangs its methods off
 * `pane` — index.js, view.js, dupes.js and modal/close.js reach for them
 * there, and the bound methods work as bare callbacks.
 *
 * @param {object} pane
 * @returns {SaveFlow}
 */
export function createSave(pane) {
  const flow = new SaveFlow(pane);
  pane.saveFlow = flow;
  pane.setSaving = flow.setSaving;
  pane.save = flow.save;
  pane.commit = flow.commit;
  pane.adoptExact = flow.adoptExact;
  pane.openConflict = flow.openConflict;
  pane.mergeInto = flow.mergeInto;
  pane.overwriteMatch = flow.overwriteMatch;
  return flow;
}
