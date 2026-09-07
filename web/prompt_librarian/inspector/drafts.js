/* Share the modal draft helpers when available: both use pl:draft:<id>
 * for the whole edit buffer, so their JSON formats must agree.
 */

import { DRAFT_PREFIX, draftBody } from "./records.js";

const DRAFT_DEBOUNCE_MS = 700;

/**
 * @param {object} pane
 * @returns {{scheduleDraft: Function}} everything else is attached to `pane`
 */
export function createDrafts(pane) {
  const { ctx, D } = pane;
  const els = pane.els;

  function draftKey(id) { return DRAFT_PREFIX + String(id); }

  function ss() {
    try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; } catch (_) { return null; }
  }

  function saveDraft() {
    if (!pane.current || !pane.current.id) return;
    const clean = pane.buf.body === String(pane.current.body || "");
    if (typeof ctx.saveDraft === "function" && typeof ctx.clearDraft === "function") {
      try {
        if (clean) ctx.clearDraft(pane.current.id);
        else ctx.saveDraft(pane.current.id, pane.getBuffer());
        return;
      } catch (_) { /* fall through to the local path */ }
    }
    const store = ss();
    if (!store) return;
    try {
      if (clean) store.removeItem(draftKey(pane.current.id));
      else store.setItem(draftKey(pane.current.id), pane.buf.body);
    } catch (_) { /* quota / private mode — drafts are best-effort */ }
  }

  function clearDraft(id) {
    if (!id) return;
    if (typeof ctx.clearDraft === "function") {
      try { ctx.clearDraft(id); return; } catch (_) {}
    }
    const store = ss();
    if (!store) return;
    try { store.removeItem(draftKey(id)); } catch (_) {}
  }

  function maybeOfferDraft(rec) {
    pane.pendingDraft = null;
    els.draftBar.hidden = true;
    if (!rec || !rec.id) return;
    let raw = null;
    if (typeof ctx.loadDraft === "function") {
      try { raw = ctx.loadDraft(rec.id); } catch (_) { raw = null; }
    }
    if (raw == null) {
      const store = ss();
      if (!store) return;
      try { raw = store.getItem(draftKey(rec.id)); } catch (_) { return; }
    }
    const d = draftBody(raw);
    if (d == null || d === String(rec.body || "")) return;
    pane.pendingDraft = d;
    els.draftText.textContent = "unsaved draft found (" + D.fmtInt(D.charCount(d)) + " chars)";
    els.draftBar.hidden = false;
  }

  function restoreDraft() {
    if (pane.pendingDraft == null) return;
    pane.setBody(pane.pendingDraft);
    pane.pendingDraft = null;
    els.draftBar.hidden = true;
    pane.toast("draft restored");
  }

  function discardDraft() {
    pane.pendingDraft = null;
    els.draftBar.hidden = true;
    if (pane.current && pane.current.id) clearDraft(pane.current.id);
  }

  const scheduleDraft = D.debounce(() => saveDraft(), DRAFT_DEBOUNCE_MS);

  pane.saveDraft = saveDraft;
  pane.clearDraft = clearDraft;
  pane.maybeOfferDraft = maybeOfferDraft;
  pane.restoreDraft = restoreDraft;
  pane.discardDraft = discardDraft;
  pane.scheduleDraft = scheduleDraft;

  return { scheduleDraft };
}
