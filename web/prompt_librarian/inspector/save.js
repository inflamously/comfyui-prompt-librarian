/* Normal saves create records; Update explicitly overwrites with expect_updated.
 * Near matches do not block creation. Exact copies adopt the stored record.
 * Conflict dialogs are local so they work even if compare/ fails to load.
 *
 * Only "saved" and "clean" permit closing. "blocked" (conflict/empty body),
 * "failed", and "busy" keep the modal open. modal/ compares these strings
 * without importing this optional feature.
 */

import { LDQUO, MDASH, MIDDOT, RDQUO } from "./constants.js";
import { bufferFrom, ensureOk, errMsg, isConflict, matchesOf, sig, unwrapRecord } from "./records.js";

/** Treat normalized similarity near 1 as an exact-copy candidate; allow float noise.
 */
export const EXACT = 0.9999;


/** @param {{disposed?:boolean, saving?:boolean, dirty?:boolean,
 *          hasRecord?:boolean, body?:string}} s
 * @returns {null|{status:"busy"|"clean"|"blocked", toast?:string,
 *                 tone?:string, focusBody?:boolean}}
 *   null when the save may proceed.
 */
export function preflight(s) {
  if (s.disposed || s.saving) return { status: "busy" };
  // Skip unchanged records before dupe requests; an outage must not create a copy.
  if (!s.dirty && s.hasRecord) return { status: "clean", toast: "no changes" };
  if (!String(s.body || "").trim()) {
    return { status: "blocked", toast: "prompt text is empty", tone: "error", focusBody: true };
  }
  return null;
}

export function isUpdateSave(asNew, current) {
  return !asNew && !!(current && current.id);
}

/** Muted matches must not be adopted. Exclude the current record only on update;
 * when creating from an edit, it remains a relevant match.
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

/** Similarity scores only the body. An exact match on the current record must
 * update tags rather than adopt old tags or create an identical-body twin.
 *
 * @returns {"commit"|"update-current"|"adopt"}
 */
export function exactAction({ exact, isUpdate, curId }) {
  if (!exact || isUpdate) return "commit";
  if (curId && String(exact.id) === String(curId)) return "update-current";
  return "adopt";
}

/** Adoption discards the edit buffer, so require matching body AND tags.
 * Tag order is irrelevant.
 */
export function sameContent(rec, buf) {
  if (!rec) return false;
  if (String(rec.body || "").trim() !== String((buf && buf.body) || "").trim()) return false;
  return sig({ tags: bufferFrom(rec).tags }) === sig({ tags: (buf && buf.tags) || [] });
}

export function expectUpdatedFor(baseline, opts = {}) {
  if (opts.expectUpdated !== undefined) return opts.expectUpdated;
  return baseline ? baseline.updated : undefined;
}

export function nearMessage(near, fmtInt) {
  return (
    "saved " + MDASH + " " + fmtInt(near) + " near match" + (near === 1 ? "" : "es") +
    ", see the duplicate panel"
  );
}


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
      if (isUpdate) {
        const verdict = await this.checkStale(asNew);
        if (verdict) return verdict;
      }

      const { near, exact } = await this.findMatches(isUpdate);
      if (pane.disposed) return "busy";

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

      const rec = await this.commit(asNew);
      if (!rec) return "failed";
      if (near) pane.toast(nearMessage(near, D.fmtInt));
      return "saved";
    } finally {
      this.setSaving(false);
    }
  }

  /** Return a blocking/failure status, or null when the save may continue.
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

  /** Do not use the typing dupe lane: a keystroke must not cancel this fresh check.
   * If it fails, saving continues without exact-copy adoption.
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

  /** Use expect_updated; a 409 reopens the conflict flow.
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

  afterWrite() {
    const { pane, ctx } = this;
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
  }

  /** Adopt the matched record and update the node link; a no-op would leave the
   * editor detached from the stored record.
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

  /** Write the buffer body onto the match, preserving its tags and using its
   * updated stamp for optimistic concurrency. Let callers report errors.
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

/** Attach bound callbacks to pane for editor and modal consumers.
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
