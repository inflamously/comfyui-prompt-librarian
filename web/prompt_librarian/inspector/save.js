/* ==========================================================================
   THE SAVE FLOW — the feature this pane exists for
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

       NEVER A SILENT OVERWRITE

   The save path is deliberately paranoid and deliberately self-contained:
     1. not dirty and not "save as new"       -> stop, say so
     2. staleness check (someone else edited) -> conflict UI, stop
     3. dupe gate, always re-run on save      -> resolve UI, stop
     4. commit (create | update+expect_updated); 409 re-enters step 2
     5. adopt the server's record as both `current` and `baseline`

   Steps 2-3 build their dialogs INLINE via the pane's own layer host rather
   than through compare/. The gate is the safety property; it must still work
   on an install where compare/ failed to load.

   SAVE STATUS — what `save()` returns. Ctrl+S ignores it; the close path in
   modal/close.js needs it, because "I put a dialog on screen" and "I wrote the
   record" are the same `undefined` otherwise:

     "saved"    committed; the buffer is now clean
     "clean"    nothing to write — already matches what is stored
     "blocked"  a decision is on screen (conflict / duplicate) or the body is
                empty. The modal must stay open.
     "failed"   the write or its pre-flight errored; a toast says why
     "busy"     a save is already in flight, or the pane is disposed

   Only "saved" and "clean" mean it is safe to close. The vocabulary is
   duplicated as a comment in modal/ctx.js and compared there as a plain
   string — modal/ must not import from inspector/, which is lazily loaded and
   optional.
   ========================================================================== */

import { LDQUO, MDASH, MIDDOT, RDQUO } from "./constants.js";
import { ensureOk, errMsg, isConflict, matchesOf, pct, unwrapRecord } from "./records.js";

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

    if (isUpdate && !pane.isDirty()) { pane.toast("no changes"); return "clean"; }
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

      // ---- 3. dupe gate -------------------------------------------------
      // Deliberately NOT through ctx.lanes.dupe: a keystroke landing mid-save
      // must not be able to abort the gate. Freshly run every time, whatever
      // the live panel happens to be showing.
      const t = pane.threshold();
      let gate = [];
      try {
        const r = await ctx.API.dupes({
          body: pane.buf.body,
          exclude_id: isUpdate ? pane.current.id : null,
          threshold: t,
          summaries: true,
          limit: 10,
        });
        if (r !== ctx.ABORTED) {
          gate = matchesOf(ensureOk(r)).filter(
            (m) => m.score >= t && m.id !== (pane.current && pane.current.id)
          );
        }
      } catch (err) {
        // A dupe-check outage must not become an unsaveable library; warn and
        // proceed, since the backend's own constraints still apply.
        pane.toast("duplicate check unavailable — saving without it", "error");
        gate = [];
      }
      if (pane.disposed) return "busy";
      if (gate.length) { openResolve(gate, asNew); return "blocked"; }

      // ---- 5. commit ----------------------------------------------------
      return (await commit(asNew)) ? "saved" : "failed";
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

  /* ---- Resolve UI (step 3) ----------------------------------------- *
   * Built inline, on purpose: the gate is the safety property of this   *
   * feature and must survive compare/ being absent. There is NO primary *
   * Save here — every path is an explicit decision, and `save anyway`   *
   * is a ghost button.                                                  *
   *                                                                     *
   * `save anyway` IS THE LAST DIALOG. Clicking it used to open a second *
   * confirm and then leave every pair flagged, so the next save — and   *
   * save-on-close is a save — re-opened this same dialog for the same   *
   * matches, forever. One decision, taken once: it commits immediately  *
   * and mutes every pair it just listed, exactly like `keep both` does  *
   * for the one row it sits on.                                         *
   * ------------------------------------------------------------------ */

  function openResolve(matches, asNew) {
    const dlg = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Possible duplicate" });
    let layer = null;
    const close = () => { if (layer) layer.close(); };
    const busy = (on) => { for (const b of dlg.querySelectorAll("button")) b.disabled = !!on; };

    const body = h("div", { className: "pl-dialog-body" });
    body.appendChild(
      h(
        "p",
        null,
        "This text is at least " + Math.round(pane.threshold() * 100) + "% similar to " +
          D.fmtInt(matches.length) + " existing prompt" + (matches.length === 1 ? "" : "s") +
          ". Pick what should happen — nothing is written until you do."
      )
    );

    for (const m of matches) {
      const acts = h(
        "div",
        { className: "pl-dupe-acts" },
        h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => pane.compareWith(m) }, "compare"),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm pl-btn-accent",
            type: "button",
            onclick: async () => { busy(true); try { await mergeInto(m, { close }); } finally { busy(false); } },
          },
          "merge into this"
        ),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm",
            type: "button",
            title: "Save anyway and stop flagging this pair",
            onclick: async () => { busy(true); try { await keepBoth(m, asNew, close); } finally { busy(false); } },
          },
          "keep both"
        ),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm",
            type: "button",
            onclick: async () => { busy(true); try { await overwriteMatch(m, close); } finally { busy(false); } },
          },
          "overwrite that one"
        )
      );
      body.appendChild(
        h(
          "div",
          { className: "pl-dupe" },
          h("div", { className: "pl-score" }, pct(m.score)),
          h("div", { className: "pl-dupe-name" }, m.label),
          h("div", { className: "pl-dupe-why" }, m.summary ? "differs: " + m.summary : ""),
          acts
        )
      );
    }

    const acts = h(
      "div",
      { className: "pl-dialog-acts" },
      // Secondary ghost, never a primary: saving a duplicate must feel like
      // the deliberate exception it is. It is not, however, a decision worth
      // asking about twice — this dialog already named every match.
      h(
        "button",
        {
          className: "pl-btn pl-btn-ghost",
          type: "button",
          title:
            "Save alongside " + (matches.length === 1 ? "this match" : "all " + D.fmtInt(matches.length) + " matches") +
            " and stop flagging " + (matches.length === 1 ? "the pair" : "those pairs"),
          onclick: async () => { busy(true); try { await keepAll(matches, asNew, close); } finally { busy(false); } },
        },
        "save anyway"
      ),
      h("button", { className: "pl-btn", type: "button", onclick: () => close() }, "cancel")
    );

    dlg.appendChild(
      h("div", { className: "pl-dialog-title" }, "Possible duplicate " + MDASH + " nothing saved yet")
    );
    dlg.appendChild(body);
    dlg.appendChild(acts);
    layer = pane.openLayer(dlg, { closeOnOutside: false });
    return layer;
  }

  /**
   * "keep both" / "save anyway": go through with what the user asked for
   * (create for `save as new` / a brand-new record, update otherwise) and then
   * record the pair(s) in `ignored` so those exact comparisons stop nagging.
   *
   * MUTING IS THE POINT, not a nicety. Without it the very next save re-runs
   * the gate, finds the same matches and re-opens the same dialog — and
   * closing the modal is a save. A decision the user has taken has to stick.
   *
   * DEVIATION from the letter of the brief ("proceeds as create"): when the
   * user is updating an existing record, creating instead would silently
   * fork their prompt into two. "Keep both" means "keep this record and that
   * record" — the ignorePair call is the part that matters.
   *
   * @param {Array<object>} matches the rows to mute against what we just saved
   */
  async function keepAll(matches, asNew, close) {
    if (close) close();
    setSaving(true);
    let rec = null;
    try {
      rec = await commit(asNew);
    } finally {
      setSaving(false);
    }
    if (!rec || !rec.id) return; // commit already said why
    const ids = (matches || []).map((m) => m && m.id).filter((id) => id && String(id) !== String(rec.id));
    if (!ids.length) return;

    // Best effort, and never fatal: the record IS saved by now. A pair that
    // could not be muted is a nag, not a data loss, so it gets one honest
    // toast rather than an error per id.
    let failed = 0;
    for (const id of ids) {
      try {
        ensureOk(await ctx.API.ignorePair(rec.id, id));
      } catch (_) {
        failed++;
      }
    }
    if (failed) {
      pane.toast(
        "saved, but " + D.fmtInt(failed) + " of " + D.fmtInt(ids.length) + " pair" +
          (ids.length === 1 ? "" : "s") + " could not be muted — they will keep being flagged",
        "error"
      );
      return;
    }
    pane.toast(
      "saved " + MDASH + " " + (ids.length === 1 ? "this pair" : "these " + D.fmtInt(ids.length) + " pairs") +
        " will stop being flagged"
    );
    // The panel is still showing the matches the gate found; now that they are
    // muted the backend will not return them, so ask again.
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
  }

  /** "keep both" — the per-row button: mute exactly the pair it sits on. */
  function keepBoth(m, asNew, close) {
    return keepAll(m ? [m] : [], asNew, close);
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
  pane.openConflict = openConflict;
  pane.openResolve = openResolve;
  pane.keepBoth = keepBoth;
  pane.keepAll = keepAll;
  pane.mergeInto = mergeInto;
  pane.overwriteMatch = overwriteMatch;
}
