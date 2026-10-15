/* Saving. "Save as new" creates a record; "Update" overwrites the selected one,
 * guarded by `expect_updated`. Near duplicates never block a save (the panel
 * lights up instead); an exact copy adopts the stored record. A record that
 * changed elsewhere opens the conflict dialog.
 *
 * save() resolves to one of five statuses. Only "saved" and "clean" let the
 * modal close; "blocked" (a conflict, an empty body), "failed" and "busy" keep
 * it open. modal/lifecycle/close.js compares these strings.
 */

import { ABORTED, ensureOk } from "../../../api/request.js";
import { matchesOf } from "../../../shared/matches.js";
import { labelOf } from "../../../shared/text.js";
import { MDASH, quoted } from "../glyphs.js";
import { errMsg, isConflict, unwrapRecord } from "../records.js";
import { ConflictDialog } from "./conflict-dialog.js";
import { classifyMatches, exactAction, expectUpdatedFor, isUpdateSave, nearMessage, preflight, sameContent } from "./rules.js";

/**
 * The save flow over an inspector pane. It uses the pane's state (current,
 * baseline, buf, disposed, saving), its methods (isDirty, getBuffer,
 * adoptRecord, clearDraft, saveDraft, maybeOfferDraft, compareConflict,
 * renderActions, focusBody, toast, threshold, openLayer), its dupes panel, and
 * deps.api and deps.onLibraryChanged.
 */
export class SaveFlow {
  constructor(pane) {
    this.pane = pane;
  }

  setSaving(on) {
    this.pane.saving = !!on;
    this.pane.renderActions();
  }

  /** @returns {Promise<"saved"|"clean"|"blocked"|"failed"|"busy">} */
  async save(asNew) {
    const { pane } = this;
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
      const action = exactAction({ exact, isUpdate, curId: pane.current && pane.current.id });
      if (action === "update-current") return (await this.commit(false)) ? "saved" : "failed";
      if (action === "adopt" && (await this.adoptExact(exact))) return "clean";
      const rec = await this.commit(asNew);
      if (!rec) return "failed";
      if (near) pane.toast(nearMessage(near));
      return "saved";
    } finally {
      this.setSaving(false);
    }
  }

  /** null when the update may go ahead; otherwise the status to stop with. */
  async checkStale(asNew) {
    const { pane } = this;
    let fresh = null;
    try {
      fresh = unwrapRecord(ensureOk(await pane.deps.api.get(pane.current.id)));
    } catch (err) {
      pane.toast("could not check for remote changes: " + errMsg(err), "error");
      return "failed";
    }
    if (!fresh || !fresh.id) {
      pane.toast("this prompt no longer exists", "error");
      return "failed";
    }
    if (pane.baseline && String(fresh.updated || "") !== String(pane.baseline.updated || "")) {
      this.openConflict(fresh, asNew);
      return "blocked";
    }
    return null;
  }

  /** A fresh check, not on the typing lane: a keystroke must not cancel it. If it
   * fails, the save goes on without exact-copy adoption. */
  async findMatches(isUpdate) {
    const { pane } = this;
    const threshold = pane.threshold();
    try {
      const r = await pane.deps.api.dupes({
        body: pane.buf.body,
        exclude_id: isUpdate ? pane.current.id : null,
        threshold,
        summaries: true,
        limit: 10,
      });
      if (r === ABORTED) return { near: 0, exact: null };
      return classifyMatches(matchesOf(ensureOk(r)), { threshold, isUpdate, curId: pane.current && pane.current.id });
    } catch (_) {
      return { near: 0, exact: null };
    }
  }

  /** Write the buffer; a 409 on update opens the conflict dialog instead. */
  async commit(asNew, opts = {}) {
    const { pane } = this;
    const { api } = pane.deps;
    const payload = pane.getBuffer();
    const isUpdate = isUpdateSave(asNew, pane.current);
    let rec = null;
    try {
      rec = unwrapRecord(ensureOk(isUpdate
        ? await api.update({ ...payload, id: pane.current.id, expect_updated: expectUpdatedFor(pane.baseline, opts) })
        : await api.create(payload)));
    } catch (err) {
      if (isUpdate && isConflict(err)) {
        let fresh = null;
        try { fresh = unwrapRecord(ensureOk(await api.get(pane.current.id))); } catch (_) { fresh = null; }
        if (fresh) {
          this.openConflict(fresh, asNew);
          return null;
        }
      }
      pane.toast("save failed: " + errMsg(err), "error");
      return null;
    }
    if (!rec || !rec.id) {
      pane.toast("save failed: no record returned", "error");
      return null;
    }
    if (pane.current && pane.current.id) pane.clearDraft(pane.current.id);
    pane.clearDraft(rec.id);
    // Push: "save as new" mints an id, and a node left on the old one (or none)
    // silently stops counting usage against what was just saved.
    pane.adoptRecord(rec, { push: true });
    pane.toast(isUpdate ? "saved" : `created ${quoted(labelOf(rec))}`, "success");
    this.afterWrite();
    return rec;
  }

  afterWrite() {
    this.pane.deps.onLibraryChanged();
    this.pane.dupes.check();
  }

  /** Adopt the stored copy `m` and link the node to it. False when it cannot be
   * loaded or is not really identical; the caller then saves normally. */
  async adoptExact(m) {
    const { pane } = this;
    let rec = null;
    try {
      rec = unwrapRecord(ensureOk(await pane.deps.api.get(m.id)));
    } catch (_) {
      rec = null;
    }
    if (!rec || !rec.id || pane.disposed) return false;
    // `get` is a second opinion on a score computed against a corpus snapshot.
    if (!sameContent(rec, pane.buf)) return false;
    pane.clearDraft(rec.id);
    if (pane.current && pane.current.id) pane.clearDraft(pane.current.id);
    pane.adoptRecord(rec, { push: true });
    pane.toast(`already saved as ${quoted(labelOf(rec))} ${MDASH} nothing added`, "success");
    pane.dupes.check();
    return true;
  }

  openConflict(fresh, asNew) {
    const { pane } = this;
    const run = (fn) => () => { layer.close(); fn(); };
    const layer = pane.openLayer(new ConflictDialog({
      fresh,
      mine: pane.buf.body,
      onCompare: run(() => pane.compareConflict(fresh)),
      onTheirs: run(() => {
        // The local edit is dropped; it stays in the session draft until the next clean save.
        pane.saveDraft();
        pane.adoptRecord(fresh, { push: true });
        pane.maybeOfferDraft(fresh);
        pane.toast("reloaded their version");
        pane.dupes.check();
      }),
      onMine: run(() => this.overwriteWithMine(fresh, asNew)),
      onCancel: run(() => {}),
    }), { closeOnOutside: false });
    return layer;
  }

  /** The confirmed overwrite: re-baseline onto `fresh` so expect_updated matches, then commit. */
  async overwriteWithMine(fresh, asNew) {
    const { pane } = this;
    this.setSaving(true);
    try {
      pane.baseline = JSON.parse(JSON.stringify(fresh));
      pane.current = { ...(pane.current || {}), id: fresh.id, updated: fresh.updated };
      await this.commit(asNew, { expectUpdated: fresh.updated });
    } finally {
      this.setSaving(false);
    }
  }
}
