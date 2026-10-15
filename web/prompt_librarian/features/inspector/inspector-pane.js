/* The inspector: the editor for one prompt, with its tags, rating, drafts,
 * duplicate panel and saves. Its state is the record being edited (`current`),
 * the snapshot the dirty check compares against (`baseline`), and the edit
 * buffer (`buf`); it publishes them to the inspector slice. With no record
 * selected, the node's own text is the clean state: it already lives on the
 * node, so it is not an unsaved edit.
 */

import { Component } from "../../shared/component.js";
import { useStyles } from "../../shared/styles.js";
import { labelOf } from "../../shared/text.js";
import { debounce } from "../../shared/timing.js";
import { CAP_TITLE } from "./glyphs.js";
import { compareConflict, compareWith, openDiffVsSaved, openVersions } from "./compare-links.js";
import { discardDraft, hideDraft, offerDraft, restoreDraft, saveDraft } from "./drafts.js";
import { paintActions, paintCounts, paintFields, paintStars, paintTags } from "./fields.js";
import { NodeSync } from "./node-sync.js";
import { onStarClick, onStarKey } from "./rating.js";
import { bufferFrom, sig } from "./records.js";
import { newPrompt, selectPrompt } from "./selection.js";
import { deleteRecord } from "./delete-record.js";
import { mergeInto, overwriteMatch } from "./save/match-actions.js";
import { SaveFlow } from "./save/save-flow.js";
import { buildView } from "./view.js";

const DRAFT_DEBOUNCE_MS = 700;
const MAX_TAGS = 32;

/**
 * deps: api ({get, rate, del, create, update, merge, dupes}), slice (inspector),
 * lane(run) for record loads, caps() -> capability flags, layers() -> LayerStack,
 * toast(message, opts), dialogs ({choose, confirm}), drafts ({save, load, clear}),
 * tags (the tags service), mountDupes(slot, side), attachAutocomplete(textarea, host),
 * compare ({compare, versions}), pushToNode(body, id?), onLibraryChanged().
 */
export class InspectorPane extends Component {
  constructor(deps) {
    super(deps);
    this.buf = { tags: [], body: "" };
    this.current = null;
    this.baseline = null;
    this.nodeBody = "";
    this.renderedId = null;
    this.disposed = false;
    this.saving = false;
    this.ratingBusy = false;
    this.pendingId = null; // the record a selectPrompt fetch is loading
    this.leaving = false; // the unsaved-changes gate is on screen
    this.pendingDraft = null;
    this.layers = new Set(); // layers this pane opened, closed with it
    this.saveFlow = new SaveFlow(this);
  }

  render() {
    useStyles(new URL("./inspector.css", import.meta.url));
    const { root, els } = buildView({
      newPrompt: () => this.newPrompt(),
      restoreDraft: () => restoreDraft(this),
      discardDraft: () => this.discardDraft(),
      input: (value) => { this.buf.body = value; this.afterEdit(true); },
      diff: () => openDiffVsSaved(this),
      versions: () => openVersions(this),
      starClick: (e) => onStarClick(this, e),
      starKey: (e) => onStarKey(this, e),
      save: (asNew) => this.save(asNew),
      remove: () => this.remove(),
    });
    this.els = els;
    this.nodeSync = new NodeSync(this);
    this.draftTimer = debounce(() => saveDraft(this), DRAFT_DEBOUNCE_MS);
    this.own(() => { this.draftTimer.cancel(); this.nodeSync.cancel(); });
    this.watch(this.deps.slice, "currentId", (id) => this.onCurrentIdChanged(id));
    this.refreshCaps();
    return root;
  }

  /** Mount, then attach what needs the live DOM: completion (it looks for the
   * modal root) and the dupes panel, then paint from the slice. */
  mount(parent) {
    super.mount(parent);
    this.autocomplete = this.own(this.deps.attachAutocomplete(this.els.ta, parent));
    this.dupes = this.own(this.deps.mountDupes(this.els.dupesSlot, {
      subject: () => ({ body: this.buf.body, id: this.current?.id ?? null, label: this.current ? this.label() : "" }),
      onCompare: (m) => compareWith(this, m),
      onMerge: (m) => mergeInto(this, m),
      onOverwrite: (m) => overwriteMatch(this, m),
    }));
    this.own(() => {
      for (const layer of this.layers) layer.close();
      this.deps.lane.cancel();
    });
    this.own(() => { this.disposed = true; }); // runs first on destroy
    const restored = this.deps.slice.get("current");
    if (restored) this.adoptRecord(restored);
    else paintFields(this);
    return this;
  }

  /* ---- public: the modal and the other panes call these ---------------- */

  selectPrompt(id) {
    return selectPrompt(this, id);
  }

  /** Whether the buffer differs from the record (or, with none, from the node's text). */
  isDirty() {
    const base = this.baseline ? bufferFrom(this.baseline) : { tags: [], body: this.nodeBody };
    return sig(this.buf) !== sig(base);
  }

  getBuffer() {
    return { tags: this.buf.tags.slice(), body: this.buf.body };
  }

  /** Save and resolve to a status; never rejects (Ctrl+S and close await it). */
  requestSave(asNew) {
    return Promise.resolve()
      .then(() => this.save(!!asNew))
      .catch((err) => {
        console.error("[prompt-librarian] save threw", err);
        return "failed";
      });
  }

  save(asNew) {
    return this.saveFlow.save(asNew);
  }

  /**
   * Replace the body. `fromNode` marks the inbound half of the node binding: that
   * value already IS the node's, so it is not pushed back, and it does not take
   * the box from someone typing in it (whichever textarea has focus wins).
   */
  setBody(text, { fromNode = false } = {}) {
    const next = String(text ?? "");
    const ta = this.els.ta;
    if (fromNode) {
      if (this.buf.body === next || ta.ownerDocument.activeElement === ta) return;
      this.nodeSync.lastInbound = next;
      if (!this.current) this.nodeBody = next;
    }
    this.autocomplete.dismiss();
    this.buf.body = next;
    ta.value = next;
    this.afterEdit(true);
  }

  focusBody() {
    this.els.ta.focus();
  }

  /** Re-read capabilities, e.g. after the backend answered the ping. */
  refreshCaps() {
    for (const [node, ok] of [
      [this.els.diffLink, this.diffOk()],
      [this.els.versLink, this.capOk("versions")],
      [this.els.versV, this.capOk("versions")],
    ]) {
      node.disabled = !ok;
      if (ok) node.removeAttribute("title");
      else node.setAttribute("title", CAP_TITLE);
    }
    if (this.dupes) paintActions(this);
  }

  /* ---- state ------------------------------------------------------------- */

  /**
   * Take a server record (or null) as the selection. `push` writes it through to
   * the node, body and prompt_id; only an explicit pick does that. Deselecting,
   * a background refresh, and restoring on open must leave the node alone.
   */
  adoptRecord(rec, { push = false } = {}) {
    this.autocomplete?.dismiss();
    this.current = rec || null;
    this.baseline = rec ? JSON.parse(JSON.stringify(rec)) : null;
    this.nodeBody = "";
    this.buf = bufferFrom(rec);
    this.renderedId = rec && rec.id ? String(rec.id) : null;
    if (push && rec) this.nodeSync.pushRecord(rec);
    this.deps.slice.set({ current: this.current, baseline: this.baseline, buffer: this.getBuffer() });
    hideDraft(this);
    paintFields(this);
  }

  afterEdit(bodyChanged) {
    this.deps.slice.set({ buffer: this.getBuffer() });
    paintCounts(this);
    if (!bodyChanged) return;
    this.dupes.schedule();
    this.draftTimer();
    this.nodeSync.pushBody(); // every edit source leaves through this one hook
  }

  onCurrentIdChanged(id) {
    if (this.disposed) return;
    const sid = id == null ? null : String(id);
    if (sid === this.renderedId || sid === this.pendingId) return;
    this.selectPrompt(sid ?? "");
  }

  /* ---- actions ----------------------------------------------------------- */

  newPrompt() {
    return newPrompt(this);
  }

  remove() {
    return deleteRecord(this);
  }

  addTag(tag) {
    const t = String(tag || "").trim();
    if (!t || this.buf.tags.includes(t)) return;
    if (this.buf.tags.length >= MAX_TAGS) return this.toast(`${MAX_TAGS} tags is the limit`, "error");
    this.buf.tags = this.buf.tags.concat([t]);
    paintTags(this);
    this.afterEdit(false);
  }

  removeTag(tag) {
    this.buf.tags = this.buf.tags.filter((t) => t !== tag);
    paintTags(this);
    this.afterEdit(false);
  }

  /** The tag picker, anchored to the permanent "// PROMPT TEXT" label: chips move. */
  openTagPicker() {
    this.deps.tags.openPicker({
      anchor: this.els.textLabel,
      placement: "overlay-start",
      selected: this.buf.tags.slice(),
      onPick: (t) => this.addTag(t),
      onRemove: (t) => this.removeTag(t),
    });
  }

  /* ---- helpers the collaborators use (save flow, drafts, rating) --------- */

  toast(message, kind) {
    return this.deps.toast(String(message), kind ? { kind } : {});
  }

  capOk(name) {
    return this.deps.caps()[name] !== false;
  }

  /** The backend advertises `compare`; older ones say `diff`. Both must hold. */
  diffOk() {
    return this.capOk("diff") && this.capOk("compare");
  }

  threshold() {
    return this.dupes.threshold();
  }

  label() {
    return labelOf(this.current);
  }

  renderActions() {
    paintActions(this);
  }

  renderStars(rating) {
    paintStars(this, rating);
  }

  saveDraft() {
    saveDraft(this);
  }

  clearDraft(id) {
    if (id) this.deps.drafts.clear(id);
  }

  maybeOfferDraft(rec) {
    offerDraft(this, rec);
  }

  discardDraft() {
    discardDraft(this);
  }

  compareConflict(fresh) {
    compareConflict(this, fresh);
  }

  /** Push a component onto the layer stack; it closes with this pane. */
  openLayer(component, opts = {}) {
    const stack = this.deps.layers();
    const handle = stack.push({ ...opts, component, onClose: () => this.layers.delete(layer) });
    const layer = { el: handle.el, close: () => stack.pop(handle) };
    this.layers.add(layer);
    return layer;
  }
}
