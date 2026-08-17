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
import { ensureOk, errMsg, isConflict, matchesOf, unwrapRecord } from "./records.js";

/**
 * A similarity at or above this is "the same text", not "similar text": the
 * backend scores on normalized bodies, so 1.00 means the two normalize to the
 * same string. Just under 1 to stay clear of float noise.
 */
const EXACT = 0.9999;

/** @param {object} pane */
export function createSave(pane) {
  const { ctx, D } = pane;
  const h = D.h;

  function setSaving(on) {
    pane.saving = !!on;
    pane.renderActions();
  }

  /** @returns {Promise<"saved"|"clean"|"blocked"|"failed"|"busy">} see the header */
  async function save(asNew) {
    if (pane.disposed || pane.saving) return "busy";
    const isUpdate = !asNew && !!(pane.current && pane.current.id);

    // Nothing typed since the record was loaded: there is nothing to write,
    // whichever mode we are in. This matters more now that "save as new" is
    // the default — without it, Ctrl+S on an untouched record would go and ask
    // the backend whether it is a duplicate of itself, and a dupe-check outage
    // (which saves anyway, by design) would fork the record for no reason.
    if (!pane.isDirty() && pane.current && pane.current.id) { pane.toast("no changes"); return "clean"; }
    // The body is the only thing a record needs. There is nothing else to
    // ask the user for before saving — the handle is derived from this text.
    if (!pane.buf.body.trim()) { pane.toast("prompt text is empty", "error"); pane.focusBody(); return "blocked"; }

    setSaving(true);
    try {
      // ---- 2. staleness -------------------------------------------------
      if (isUpdate) {
        let fresh = null;
        try {
          fresh = unwrapRecord(ensureOk(await ctx.API.get(pane.current.id)));
        } catch (err) {
          pane.toast("could not check for remote changes: " + errMsg(err), "error");
          return "failed";
        }
        if (!fresh || !fresh.id) { pane.toast("this prompt no longer exists", "error"); return "failed"; }
        if (pane.baseline && String(fresh.updated || "") !== String(pane.baseline.updated || "")) {
          openConflict(fresh, asNew);
          return "blocked";
        }
      }

      // ---- 3. exact-copy check ------------------------------------------
      // NOT a gate any more: near matches do not stop a save, they light up
      // the duplicate panel below the editor, whose `revise` button owns
      // merge / overwrite. Only a 1.00 match is acted on here, because that is
      // not a decision — it is the same text, and writing it would add a
      // second identical record for nothing.
      //
      // Deliberately NOT through ctx.lanes.dupe: a keystroke landing mid-save
      // must not be able to abort the check. Freshly run every time, whatever
      // the live panel happens to be showing.
      const t = pane.threshold();
      let near = 0;
      let exact = null;
      try {
        const r = await ctx.API.dupes({
          body: pane.buf.body,
          exclude_id: isUpdate ? pane.current.id : null,
          threshold: t,
          summaries: true,
          limit: 10,
        });
        if (r !== ctx.ABORTED) {
          // `m.ignored` is the "keep both" decision taken elsewhere (compare/),
          // and it still applies: a muted pair must not resurface as an
          // adoption. The record in the editor is only "not a match" when we
          // are about to update it — creating from an edited copy of it, it is
          // the most relevant match there is.
          const curId = pane.current && pane.current.id;
          const found = matchesOf(ensureOk(r)).filter(
            (m) => !m.ignored && !(isUpdate && m.id === curId)
          );
          near = found.filter((m) => m.score >= t).length;
          exact = found.find((m) => m.score >= EXACT) || null;
        }
      } catch (err) {
        // An outage here costs the exact-copy shortcut, nothing more: the save
        // goes ahead and the panel below will say what it finds next time.
        near = 0;
      }
      if (pane.disposed) return "busy";
      // An exact copy of something already stored, with nothing of our own to
      // update: writing it would add a second identical record and nothing
      // else. Adopt the one that exists instead — the buffer ends up clean, so
      // this counts as saved and the modal may close.
      if (exact && !isUpdate) {
        const kept = await adoptExact(exact);
        if (kept) return "clean";
      }

      // ---- 5. commit ----------------------------------------------------
      const rec = await commit(asNew);
      if (!rec) return "failed";
      // Near matches are reported, never blocking: `commit` has already
      // re-run the live check, so the panel below is amber with a `revise`
      // button on it. This line is only so the outcome is not silent.
      if (near) {
        pane.toast(
          "saved " + MDASH + " " + D.fmtInt(near) + " near match" + (near === 1 ? "" : "es") +
            ", see the duplicate panel"
        );
      }
      return "saved";
    } finally {
      setSaving(false);
    }
  }

  /**
   * Step 5. `create` or `update` with expect_updated; a 409 falls back into
   * the conflict branch rather than a generic error toast.
   */
  async function commit(asNew, opts = {}) {
    const payload = pane.getBuffer();
    const isUpdate = !asNew && !!(pane.current && pane.current.id);
    let rec = null;
    try {
      if (isUpdate) {
        const expect =
          opts.expectUpdated !== undefined
            ? opts.expectUpdated
            : pane.baseline
            ? pane.baseline.updated
            : undefined;
        rec = unwrapRecord(
          ensureOk(await ctx.API.update(Object.assign({}, payload, { id: pane.current.id, expect_updated: expect })))
        );
      } else {
        rec = unwrapRecord(ensureOk(await ctx.API.create(payload)));
      }
    } catch (err) {
      if (isUpdate && isConflict(err)) {
        let fresh = null;
        try { fresh = unwrapRecord(ensureOk(await ctx.API.get(pane.current.id))); } catch (_) { fresh = null; }
        if (fresh) { openConflict(fresh, asNew); return null; }
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
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
    return rec;
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
  async function adoptExact(m) {
    let rec = null;
    try {
      rec = unwrapRecord(ensureOk(await ctx.API.get(m.id)));
    } catch (_) {
      rec = null;
    }
    if (!rec || !rec.id || pane.disposed) return false;
    // Only when it really is identical: `get` is a second opinion on a score
    // that was computed against a snapshot of the corpus.
    if (String(rec.body || "").trim() !== String(pane.buf.body || "").trim()) return false;
    pane.clearDraft(rec.id);
    if (pane.current && pane.current.id) pane.clearDraft(pane.current.id);
    pane.adoptRecord(rec, { silent: false, push: true });
    pane.toast("already saved as " + LDQUO + D.labelOf(rec) + RDQUO + " " + MDASH + " nothing added", "success");
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
    return true;
  }

  /* ---- Conflict UI (step 2) ---------------------------------------- */

  function openConflict(fresh, asNew) {
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
            setSaving(true);
            try {
              pane.baseline = JSON.parse(JSON.stringify(fresh));
              pane.current = Object.assign({}, pane.current || {}, { id: fresh.id, updated: fresh.updated });
              await commit(asNew, { expectUpdated: fresh.updated });
            } finally {
              setSaving(false);
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
  async function mergeInto(m, opts = {}) {
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
        const fresh = unwrapRecord(ensureOk(await ctx.API.get(m.id)));
        if (!fresh) throw new Error("match not found");
        rec = unwrapRecord(
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
      if (mine) pane.clearDraft(mine);
      if (rec && rec.id) {
        pane.clearDraft(rec.id);
        pane.adoptRecord(rec, { silent: false, push: true });
        pane.toast("merged into " + LDQUO + D.labelOf(rec) + RDQUO, "success");
      } else {
        pane.toast("merged", "success");
      }
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      pane.scheduleDupes.cancel();
      pane.runDupes(false);
    } catch (err) {
      pane.toast("merge failed: " + errMsg(err), "error");
    }
  }

  /** "overwrite that one" — my text replaces the match's body. */
  async function overwriteMatch(m, close) {
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
      const fresh = unwrapRecord(ensureOk(await ctx.API.get(m.id)));
      if (!fresh || !fresh.id) throw new Error("that prompt no longer exists");
      const rec = unwrapRecord(
        ensureOk(
          await ctx.API.update({
            id: fresh.id,
            tags: fresh.tags,
            body: pane.buf.body,
            expect_updated: fresh.updated,
          })
        )
      );
      if (rec && rec.id) {
        pane.clearDraft(rec.id);
        pane.adoptRecord(rec, { silent: false, push: true });
      }
      pane.toast("overwrote " + LDQUO + m.label + RDQUO, "success");
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      pane.scheduleDupes.cancel();
      pane.runDupes(false);
    } catch (err) {
      pane.toast("overwrite failed: " + errMsg(err), "error");
    }
  }

  pane.setSaving = setSaving;
  pane.save = save;
  pane.commit = commit;
  pane.adoptExact = adoptExact;
  pane.openConflict = openConflict;
  pane.mergeInto = mergeInto;
  pane.overwriteMatch = overwriteMatch;
}
