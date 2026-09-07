import { attachAutocomplete } from "./autocomplete.js";
/* Feature modules share one mutable pane object, created here.
 * Render prompt bodies and tags as text, never HTML.
 */

import { LDQUO, MUL, RDQUO } from "./constants.js";
import { createDrafts } from "./drafts.js";
import { createDupes } from "./dupes.js";
import { createLayerHost } from "./layers.js";
import { createNeighbours } from "./neighbours.js";
import { createSave } from "./save.js";
import { resolveHelpers } from "./helpers.js";
import { bufferFrom, errMsg, ensureOk, sig, unwrapRecord } from "./records.js";
import { buildView } from "./view.js";

/**
 * Mount the inspector into `el` (the `.pl-inspect` element).
 *
 * @param {HTMLElement} el
 * @param {object} ctx  see the modal/ctx.js contract
 * @returns {{unmount:()=>void, selectPrompt:(id:string)=>Promise<void>,
 *            isDirty:()=>boolean, getBuffer:()=>object,
 *            setBody:(t:string)=>void, focusBody:()=>void}}
 */
export function mountInspector(el, ctx) {
  const D = resolveHelpers(ctx);

  /* Mutate buf in place and mirror silently to shared state: guards need fresh
   * values, but subscribers must not rebuild the editor on each keystroke.
   */
  const pane = {
    ctx,
    el,
    D,
    buf: { tags: [], body: "" },
    current: null, // canonical server record for the selection
    baseline: null, // snapshot the dirty check and expect_updated use
    renderedId: null,
    disposed: false,
    saving: false,
    dupeSeq: 0, // guards a slow response overwriting a fresh one
    dupePaused: false, // body over the live-check ceiling
    ratingBusy: false,
    pendingId: null, // id of an in-flight selectPrompt fetch
    leaving: false, // the unsaved-changes gate is on screen
    pendingDraft: null,
    /** Track the inbound value, not a temporary flag: the outbound rAF callback
     * runs after inbound processing has finished.
     */
    lastInbound: null,
  };

  const subs = [];


  const S = () => (typeof ctx.getState === "function" ? ctx.getState() || {} : {});

  function toast(msg, kind) {
    try {
      if (typeof ctx.toast === "function") ctx.toast(String(msg), kind ? { kind } : undefined);
      else console.log("[prompt-librarian]", msg);
    } catch (_) { /* a toast failing must never break a flow */ }
  }

  /** Replace the previous load notice so rapid row navigation cannot stack toasts.
   */
  let lastLoadToast = null;
  function loadToast(label) {
    try {
      if (lastLoadToast && lastLoadToast.parentNode) lastLoadToast.parentNode.removeChild(lastLoadToast);
    } catch (_) { /* already gone */ }
    lastLoadToast = null;
    try {
      if (typeof ctx.toast !== "function") return;
      lastLoadToast = ctx.toast("loaded " + LDQUO + label + RDQUO + " into the node", {
        kind: "success",
        ms: 2500,
      });
    } catch (_) { /* a toast failing must never break a selection */ }
  }

  function capOk(name) {
    const caps = (ctx && ctx.caps) || S().caps || {};
    return caps[name] !== false;
  }

  /** The backend advertises `compare`; the brief calls it `diff`. Honour both. */
  function diffOk() {
    return capOk("diff") && capOk("compare");
  }

  function lane(name, fn) {
    const l = ctx.lanes && ctx.lanes[name];
    if (typeof l === "function") return l(fn);
    return Promise.resolve(fn(undefined));
  }

  function isDirty() {
    return sig(pane.buf) !== sig(pane.baseline ? bufferFrom(pane.baseline) : null);
  }

  function getBuffer() {
    return {
      tags: pane.buf.tags.slice(),
      body: pane.buf.body,
    };
  }

  function syncBuffer(silent = true) {
    try {
      if (typeof ctx.setState === "function") ctx.setState({ buffer: getBuffer() }, { silent: !!silent });
    } catch (_) { /* state is a convenience here, not a dependency */ }
  }

  Object.assign(pane, { S, toast, capOk, diffOk, lane, isDirty, getBuffer, syncBuffer });


  const layerHost = createLayerHost(pane);
  Object.assign(pane, layerHost);

  const view = buildView(pane);
  const els = view.els;
  pane.els = els;
  const applyCaps = view.applyCaps;
  applyCaps();

  const ta = els.ta;
  const autocomplete = attachAutocomplete(ta, ctx, el);


  function renderCounts() {
    els.charsEl.textContent = D.fmtInt(D.charCount(pane.buf.body));
    els.tokensEl.textContent = "~" + D.fmtInt(D.estimateTokens(pane.buf.body));
    els.editedEl.hidden = !isDirty();
    renderLabel();
  }

  /** Use the server label for unchanged bodies; edited/unsaved text uses the
   * local fallback because its corpus label is no longer valid.
   */
  function renderLabel() {
    const rec = pane.current || {};
    const label = isDirty() || !rec.id
      ? D.labelOf(pane.buf.body)
      : D.labelOf({ label: rec.label, body: pane.buf.body });
    els.labelEl.textContent = label || "(empty prompt)";
    els.labelEl.classList.toggle("is-empty", !label);
  }

  function renderTags() {
    D.clearEl(els.tagsRow);
    for (const tag of pane.buf.tags) {
      const chip = D.h(
        "span",
        { className: "pl-chip" },
        D.h("span", null, tag),
        D.h(
          "button",
          {
            className: "pl-chip-x",
            type: "button",
            "aria-label": "Remove tag " + tag,
            title: "Remove tag",
            onclick: () => removeTag(tag),
          },
          MUL
        )
      );
      els.tagsRow.appendChild(chip);
    }
    els.tagsRow.appendChild(
      D.h("button", { className: "pl-chip pl-chip-add", type: "button", onclick: () => pane.openTagPicker() }, "+ tag")
    );
  }

  function renderFields() {
    if (ta.value !== pane.buf.body) ta.value = pane.buf.body;
    renderTags();
    renderCounts();
    renderStats();
    renderActions();
  }

  function renderStats() {
    const rec = pane.current || {};
    els.usedV.textContent = D.fmtInt(rec.used || 0) + MUL;
    els.lastV.textContent = rec.last_run ? D.relTime(rec.last_run) || "—" : "—";
    const nv = Array.isArray(rec.versions) ? rec.versions.length : Number(rec.version_count || 0);
    els.versV.textContent = D.fmtInt(nv);
    renderStars(Number(rec.rating) || 0);
  }

  function renderStars(rating) {
    D.clearEl(els.starsEl);
    const enabled = !!(pane.current && pane.current.id);
    els.starsEl.setAttribute("aria-disabled", enabled ? "false" : "true");
    els.starsEl.setAttribute("aria-label", "Rating " + Math.round(rating) + " of 5");
    const glyphs = D.starsOf(rating);
    for (let i = 1; i <= 5; i++) {
      els.starsEl.appendChild(
        D.h(
          "span",
          {
            dataset: { i: String(i) },
            role: "button",
            "aria-label": i + " star" + (i === 1 ? "" : "s"),
            title: enabled ? "Rate " + i + "/5" : "",
          },
          glyphs[i - 1] || (i <= rating ? D.STAR_FULL : D.STAR_EMPTY)
        )
      );
    }
  }

  function renderActions() {
    const hasRec = !!(pane.current && pane.current.id);
    els.delBtn.disabled = !hasRec || pane.saving;
    els.saveBtn.disabled = !hasRec || pane.saving;
    els.saveNewBtn.disabled = pane.saving;
    els.newBtn.disabled = pane.saving;
    els.diffLink.disabled = !diffOk() || !hasRec;
    els.versLink.disabled = !capOk("versions") || !hasRec;
    els.versV.disabled = !capOk("versions") || !hasRec;
  }


  function afterEdit(bodyChanged) {
    syncBuffer(true);
    renderCounts();
    if (bodyChanged) {
      pane.dupePaused = false;
      pane.scheduleDupes();
      pane.scheduleDraft();
      // Route every edit source through one outbound hook.
      pushBody();
    }
  }

  /* Skip inbound node values to avoid echoing them back after the queued frame.
   */

  /** rAF-coalesced: a fast typist must not force a canvas repaint per key. */
  const pushBody = D.rafThrottle(() => {
    if (pane.disposed) return;
    if (pane.lastInbound !== null && pane.buf.body === pane.lastInbound) return;
    if (typeof ctx.pushToNode !== "function") return;
    try {
      ctx.pushToNode(pane.buf.body);
    } catch (_) { /* the binding is a convenience here, never a dependency */ }
  });

  /** Push body and link only on explicit selection, not background refresh.
   */
  function pushRecord(rec) {
    if (!rec || typeof ctx.pushToNode !== "function") return;
    pane.lastInbound = null;
    pushBody.cancel();
    try {
      const res = ctx.pushToNode(
        String(rec.body == null ? "" : rec.body),
        String(rec.id == null ? "" : rec.id)
      );
      // Show load feedback only if selection actually changed the node.
      if (res && res.ok && !res.unchanged) loadToast(D.labelOf(rec) || rec.id);
    } catch (_) { /* never block a selection on the binding */ }
  }


  /**
   * Take a server record as the new selection.
   *
   * @param {object|null} rec
   * @param {{silent?: boolean, push?: boolean}} [opts]
   *
   * `push` writes the record through to the node (body AND `prompt_id` — the
   * link is what makes usage counting work). It is opt-in, and set on exactly
   * one path: a user picking a row. The three callers that must NOT push are
   * the reason it is not simply "always":
   *
   *   - adoptRecord(null) on deselect — would wipe the node's prompt;
   *   - the background refresh in onCurrentChanged() — the record did not
   *     change under the user, the server just answered again;
   *   - the initial paint from restored state — merely OPENING the panel must
   *     never rewrite the node.
   */
  function adoptRecord(rec, opts = {}) {
    autocomplete.dismiss();
    pane.current = rec || null;
    pane.baseline = rec ? JSON.parse(JSON.stringify(rec)) : null;
    const nb = bufferFrom(rec);
    pane.buf.tags = nb.tags;
    pane.buf.body = nb.body;
    pane.renderedId = rec && rec.id ? String(rec.id) : null;
    if (opts.push && rec) pushRecord(rec);
    try {
      if (typeof ctx.setState === "function") {
        ctx.setState(
          { current: pane.current, baseline: pane.baseline, buffer: getBuffer() },
          { silent: opts.silent !== false }
        );
      }
    } catch (_) {}
    els.draftBar.hidden = true;
    pane.pendingDraft = null;
    renderFields();
  }

  /** Gate selection changes so unsaved edits are saved or explicitly discarded
   * before adopting another record.
   *
   * @param {string} nextId the record about to be selected
   * @returns {Promise<boolean>} true when the switch may proceed
   */
  async function confirmLeave(nextId) {
    const rec = pane.current;
    const curId = rec && rec.id ? String(rec.id) : "";
    if (curId && curId === String(nextId)) return true;
    if (!isDirty()) return true;
    if (!pane.buf.body.trim() && !curId) return true;
    if (typeof ctx.choiceDialog !== "function") { pane.saveDraft(); return true; }

    // Leaving creates a record; overwrites require explicit Update.
    const asNew = true;
    const label = rec ? D.labelOf(rec) || rec.id : "";
    let answer = "cancel";
    try {
      answer = await ctx.choiceDialog({
        title: "Unsaved changes",
        message: rec
          ? "You edited " + LDQUO + label + RDQUO + " without saving.\nWhat should happen to those changes?"
          : "You have an unsaved prompt in the editor.\nWhat should happen to it?",
        cancelLabel: "Keep editing",
        cancelValue: "cancel",
        choices: [
          { value: "save", label: "Save as new", primary: true },
          { value: "discard", label: "Discard", danger: true },
        ],
      });
    } catch (_) { answer = "cancel"; }
    if (pane.disposed) return false;

    if (answer === "save") {
      const status = await requestSave(asNew);
      if (pane.disposed) return false;
      if (status !== "saved" && status !== "clean") { restoreSelection(); return false; }
      return true;
    }
    if (answer === "discard") {
      pane.discardDraft();
      if (curId) {
        pane.clearDraft(curId);
        // Clean the buffer before leaving, or draft parking would recreate the discarded edit.
        adoptRecord(pane.current);
      }
      return true;
    }
    restoreSelection();
    return false;
  }

  function restoreSelection() {
    try {
      if (typeof ctx.setState === "function") {
        ctx.setState({ currentId: pane.renderedId == null ? null : String(pane.renderedId) });
      }
    } catch (_) { /* the highlight is cosmetic; never block on it */ }
  }

  async function selectPrompt(id) {
    if (pane.disposed) return;
    if (id == null || id === "") {
      autocomplete.dismiss();
      pane.pendingId = null;
      pane.dupeSeq++;
      adoptRecord(null);
      pane.publishDupes([], false);
      return;
    }
    // modal/ctx.js may both patch `currentId` (which we subscribe to) and call
    // ctx.inspector.select() for the same click; one fetch is enough.
    if (pane.pendingId != null && pane.pendingId === String(id)) return;
    // Re-selecting an edited record must not reload and discard its buffer.
    if (pane.renderedId && pane.renderedId === String(id) && isDirty()) return;
    // Serialize leave decisions so a second click cannot redirect the first answer.
    if (pane.leaving) return;
    pane.leaving = true;
    let mayLeave;
    try {
      mayLeave = await confirmLeave(id);
    } finally {
      pane.leaving = false;
    }
    if (!mayLeave || pane.disposed) return;
    // Only the no-dialog fallback can still have an outgoing dirty buffer.
    if (pane.current && pane.current.id && String(pane.current.id) !== String(id) && isDirty()) pane.saveDraft();
    autocomplete.dismiss();
    pane.pendingId = String(id);
    let r;
    try {
      r = await lane("record", (signal) => ctx.API.get(String(id), signal));
    } catch (err) {
      autocomplete.dismiss();
      pane.pendingId = null;
      if (!pane.disposed) toast("could not load prompt: " + errMsg(err), "error");
      return;
    }
    autocomplete.dismiss();
    pane.pendingId = null;
    if (r === ctx.ABORTED || pane.disposed) return;
    let rec;
    try { rec = unwrapRecord(ensureOk(r)); } catch (err) { toast("could not load prompt: " + errMsg(err), "error"); return; }
    if (!rec || !rec.id) { toast("prompt not found", "error"); return; }
    adoptRecord(rec, { push: true });
    pane.maybeOfferDraft(rec);
    pane.scheduleDupes.cancel();
    pane.runDupes(false);
  }


  function removeTag(tag) {
    pane.buf.tags = pane.buf.tags.filter((t) => t !== tag);
    renderTags();
    afterEdit(false);
  }

  function addTag(tag) {
    const t = String(tag || "").trim();
    if (!t) return;
    if (pane.buf.tags.includes(t)) return;
    if (pane.buf.tags.length >= 32) { toast("32 tags is the limit", "error"); return; }
    pane.buf.tags = pane.buf.tags.concat([t]);
    renderTags();
    afterEdit(false);
  }

  function insertAtCaret(text) {
    const s = String(text == null ? "" : text);
    try {
      if (typeof ta.setRangeText === "function") {
        const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        const end = ta.selectionEnd == null ? start : ta.selectionEnd;
        ta.setRangeText(s, start, end, "end");
      } else {
        ta.value = String(ta.value || "") + s;
      }
    } catch (_) {
      ta.value = String(ta.value || "") + s;
    }
    pane.buf.body = ta.value;
    afterEdit(true);
  }


  function onStarClick(e) {
    const t = e && e.target;
    const i = t && t.dataset ? Number(t.dataset.i) : NaN;
    if (!Number.isFinite(i)) return;
    rate(i);
  }

  function onStarKey(e) {
    if (!pane.current || !pane.current.id) return;
    const cur = Number(pane.current.rating) || 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { rate(Math.min(5, cur + 1)); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { rate(Math.max(0, cur - 1)); e.preventDefault(); }
    else if (e.key >= "0" && e.key <= "5") { rate(Number(e.key)); e.preventDefault(); }
  }

  async function rate(value) {
    if (!pane.current || !pane.current.id || pane.ratingBusy) return;
    const id = pane.current.id;
    const prev = Number(pane.current.rating) || 0;
    const next = Math.max(0, Math.min(5, Math.round(value)));
    if (next === prev) return;
    pane.ratingBusy = true;
    pane.current.rating = next;
    renderStars(next);
    try {
      const r = await ctx.API.rate(id, next);
      if (r === ctx.ABORTED) throw new Error("aborted");
      const rec = unwrapRecord(ensureOk(r));
      if (rec && rec.id && pane.current && pane.current.id === rec.id) {
        pane.current.rating = Number(rec.rating) || next;
        if (pane.baseline) pane.baseline.rating = pane.current.rating;
        renderStars(pane.current.rating);
      } else if (pane.baseline) {
        pane.baseline.rating = next;
      }
    } catch (err) {
      if (pane.current && pane.current.id === id) {
        pane.current.rating = prev;
        renderStars(prev);
      }
      toast("could not save rating: " + errMsg(err), "error");
    } finally {
      pane.ratingBusy = false;
    }
  }


  async function remove() {
    if (!pane.current || !pane.current.id) return;
    const rec = pane.current;
    let ok = false;
    try {
      ok = await ctx.confirmDialog({
        title: "Delete prompt",
        // No soft delete on the backend (caps.soft_delete === false), so we
        // must not promise an Undo we cannot deliver.
        message: "Delete " + LDQUO + (D.labelOf(rec) || rec.id) + RDQUO + "? This cannot be undone.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        danger: true,
      });
    } catch (_) { ok = false; }
    if (!ok || pane.disposed) return;
    try {
      ensureOk(await ctx.API.del(rec.id));
    } catch (err) {
      toast("delete failed: " + errMsg(err), "error");
      return;
    }
    pane.clearDraft(rec.id);
    pane.dupeSeq++;
    adoptRecord(null, { silent: false });
    pane.publishDupes([], false);
    toast("deleted " + LDQUO + (D.labelOf(rec) || rec.id) + RDQUO, "success");
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
  }


  /** Deselect before clearing so Save creates a new record. Gate unsaved changes first.
   */
  async function newPrompt() {
    if (pane.disposed || pane.leaving) return;
    pane.leaving = true;
    let mayLeave;
    try {
      mayLeave = await confirmLeave("");
    } finally {
      pane.leaving = false;
    }
    if (!mayLeave || pane.disposed) return;

    autocomplete.dismiss();
    pane.pendingId = null;
    pane.dupeSeq++; // any in-flight dupe answer is about the old body
    // Notify state subscribers so the old row highlight clears.
    adoptRecord(null, { silent: false });
    try {
      if (typeof ctx.setState === "function") ctx.setState({ currentId: null });
    } catch (_) { /* the highlight is cosmetic; never block on it */ }
    pane.publishDupes([], false);
    // Use setBody to clear the bound node too; adoptRecord does not push by default.
    setBody("");
    focusBody();
  }


  /**
   * Replace the prompt body.
   *
   * @param {string} text
   * @param {{fromNode?: boolean}} [opts] `fromNode` marks the inbound half of
   *   the node binding: the value already IS what the node holds, so it must
   *   not be pushed back, and it must not steal the box from someone who is
   *   typing in it. Focus is the tiebreaker — whichever textarea the caret is
   *   in wins, which is the only rule that never surprises the user.
   */
  function setBody(text, opts = {}) {
    const next = String(text == null ? "" : text);
    if (opts.fromNode) {
      if (pane.buf.body === next) return;
      try {
        if (typeof document !== "undefined" && document.activeElement === ta) return;
      } catch (_) { /* no document.activeElement — apply it */ }
      autocomplete.dismiss();
      pane.lastInbound = next;
      pane.buf.body = next;
      ta.value = next;
      afterEdit(true);
      return;
    }
    autocomplete.dismiss();
    pane.buf.body = next;
    ta.value = pane.buf.body;
    afterEdit(true);
  }

  function focusBody() {
    try { ta.focus(); } catch (_) {}
  }

  Object.assign(pane, {
    renderCounts,
    renderLabel,
    renderTags,
    renderFields,
    renderStats,
    renderStars,
    renderActions,
    afterEdit,
    adoptRecord,
    selectPrompt,
    removeTag,
    addTag,
    insertAtCaret,
    onStarClick,
    onStarKey,
    rate,
    remove,
    newPrompt,
    setBody,
    focusBody,
  });


  const { scheduleDupes } = createDupes(pane);
  const { scheduleDraft } = createDrafts(pane);
  createNeighbours(pane);
  createSave(pane);


  function onCurrentChanged() {
    if (pane.disposed) return;
    const st = S();
    const rec = st.current || null;
    const id = rec && rec.id ? String(rec.id) : null;
    if (id === pane.renderedId) {
      // Do not re-adopt during an edit; save-time concurrency checks handle remote changes.
      if (rec && !isDirty()) adoptRecord(rec);
      return;
    }
    adoptRecord(rec);
    if (rec) {
      pane.maybeOfferDraft(rec);
      scheduleDupes.cancel();
      pane.runDupes(false);
    } else {
      pane.dupeSeq++;
      pane.publishDupes([], false);
    }
  }

  /** `currentId` is set the instant a row is clicked, before the fetch lands. */
  function onCurrentIdChanged() {
    if (pane.disposed) return;
    const id = S().currentId;
    const sid = id == null ? null : String(id);
    if (sid === pane.renderedId || sid === pane.pendingId) return;
    if (sid == null) { selectPrompt(""); return; }
    selectPrompt(sid);
  }

  if (typeof ctx.subscribe === "function") {
    const offs = [
      ctx.subscribe("current", onCurrentChanged),
      ctx.subscribe("currentId", onCurrentIdChanged),
      ctx.subscribe("dupes", () => { if (!pane.disposed) pane.renderDupes(); }),
      ctx.subscribe("caps", () => { if (!pane.disposed) { applyCaps(); renderActions(); } }),
    ];
    for (const off of offs) if (typeof off === "function") subs.push(off);
  }

  /* Register on the stable context; the modal reaches panes through these hooks.
   */
  const registered = { inspector: false, isDirty: false, requestSave: false, debounces: false };
  /** Always return a promise of a save status; Ctrl+S and close await this hook.
   */
  function requestSave(asNew) {
    return Promise.resolve()
      .then(() => pane.save(!!asNew))
      .catch((err) => {
        console.error("[prompt-librarian] save threw", err);
        return "failed";
      });
  }
  const publicApi = { unmount, selectPrompt, isDirty, requestSave, getBuffer, setBody, focusBody };
  try {
    if (ctx && typeof ctx === "object") {
      ctx.inspector = Object.assign({ select: (id) => selectPrompt(id) }, publicApi);
      registered.inspector = true;
      if (typeof ctx.isDirty !== "function") {
        ctx.isDirty = isDirty;
        registered.isDirty = true;
      }
      // Register requestSave with isDirty so close never observes only one hook.
      if (typeof ctx.requestSave !== "function") {
        ctx.requestSave = requestSave;
        registered.requestSave = true;
      }
      if (Array.isArray(ctx.debounces)) {
        ctx.debounces.push(scheduleDupes, scheduleDraft);
        registered.debounces = true;
      }
    }
  } catch (_) { /* a frozen ctx just means no registration */ }

  {
    const st = S();
    if (st.current) adoptRecord(st.current);
    else renderFields();
    pane.renderDupes();
  }

  function unmount() {
    if (pane.disposed) return;
    pane.disposed = true;
    autocomplete.detach();
    pane.dupeSeq++; // any in-flight response is now stale by definition
    try { scheduleDupes.cancel(); } catch (_) {}
    try { scheduleDraft.cancel(); } catch (_) {}
    // A queued rAF push would fire into a node we no longer own the pane for.
    try { pushBody.cancel(); } catch (_) {}
    try {
      const l = ctx.lanes || {};
      for (const key of ["dupe", "record"]) {
        const fn = l[key];
        if (fn && typeof fn.abort === "function") fn.abort();
        else if (fn && typeof fn.cancel === "function") fn.cancel();
      }
    } catch (_) {}
    for (const off of subs) { try { off(); } catch (_) {} }
    subs.length = 0;
    // Un-register from the shared ctx, but only what is still ours.
    try {
      if (registered.inspector && ctx.inspector && ctx.inspector.unmount === unmount) ctx.inspector = null;
      if (registered.isDirty && ctx.isDirty === isDirty) ctx.isDirty = null;
      if (registered.requestSave && ctx.requestSave === requestSave) ctx.requestSave = null;
      if (registered.debounces && Array.isArray(ctx.debounces)) {
        for (const d of [scheduleDupes, scheduleDraft]) {
          const i = ctx.debounces.indexOf(d);
          if (i >= 0) ctx.debounces.splice(i, 1);
        }
      }
    } catch (_) {}
    pane.closeAllLayers();
    D.clearEl(el);
  }

  return publicApi;
}
