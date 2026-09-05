/* Load optional pickers and dialogs inside handlers; their failure must not
 * disable editing or the local save-conflict dialog.
 */

import { NOT_YET } from "./constants.js";
import { unwrapRecord } from "./records.js";

async function tryImport(spec) {
  try {
    return await import(spec);
  } catch (err) {
    return null;
  }
}

function pickFn(mod, names) {
  if (!mod) return null;
  for (const n of names) if (typeof mod[n] === "function") return mod[n];
  return null;
}

/** @param {object} pane */
export function createNeighbours(pane) {
  const { ctx, D } = pane;
  const els = pane.els;

  async function openTagPicker() {
    const mod = await tryImport("../pickers/index.js");
    if (mod) {
      const fn = mod.openTagPicker || mod.tagPicker;
      if (typeof fn === "function") {
        try {
          // Anchor to the permanent label; chips move and are replaced as tags change.
          fn(ctx, {
            anchor: els.textLabel,
            placement: "overlay-start",
            value: pane.buf.tags.slice(),
            onPick: pane.addTag,
            onRemove: pane.removeTag,
          });
          return;
        } catch (err) {  }
      }
    }
    const tags = (pane.S().tags || [])
      .map((t) => (t && t.name != null ? String(t.name) : String(t)))
      .filter((t) => !pane.buf.tags.includes(t));
    pane.openLocalPopover(els.textLabel, tags, pane.addTag, {
      placement: "overlay-start",
      withInput: true,
      placeholder: "new tag…",
      emptyLabel: "no tags yet",
    });
  }

  async function openPicker(which, ev) {
    if (which === "wildcards" && !pane.capOk("wildcards")) return;
    if (which === "snippets" && !pane.capOk("snippets")) return;
    const anchor = (ev && ev.currentTarget) || (which === "wildcards" ? els.wildLink : els.snipLink);
    const mod = await tryImport("../pickers/index.js");
    const fn =
      which === "wildcards"
        ? pickFn(mod, ["openWildcards", "openWildcardPicker", "wildcardPicker"])
        : pickFn(mod, ["openSnippets", "openSnippetPicker", "snippetPicker"]);
    if (!fn) { pane.toast(which + ": " + NOT_YET); return; }
    try {
      fn(ctx, { anchor, textarea: els.ta, onInsert: (text) => pane.insertAtCaret(text) });
    } catch (err) {
      pane.toast(which + ": " + NOT_YET);
    }
  }

  async function openDiffVsSaved() {
    if (!pane.diffOk()) return;
    if (!pane.current || !pane.current.id) { pane.toast("nothing saved to diff against"); return; }
    if (!pane.isDirty()) { pane.toast("no changes"); return; }
    const mod = await tryImport("../compare/index.js");
    const fn = pickFn(mod, ["openDiff", "openCompare", "openDiffDialog"]);
    if (!fn) { pane.toast("diff: " + NOT_YET); return; }
    try {
      fn(ctx, {
        a_id: pane.current.id,
        a_text: String(pane.baseline ? pane.baseline.body || "" : ""),
        b_text: pane.buf.body,
        titleA: "saved",
        titleB: "editing",
      });
    } catch (err) { pane.toast("diff: " + NOT_YET); }
  }

  async function openVersions() {
    if (!pane.capOk("versions")) return;
    if (!pane.current || !pane.current.id) { pane.toast("select a saved prompt first"); return; }
    const mod = await tryImport("../compare/index.js");
    const fn = pickFn(mod, ["openVersions", "openVersionsDialog", "versionsDialog"]);
    if (!fn) { pane.toast("versions: " + NOT_YET); return; }
    try {
      fn(ctx, {
        id: pane.current.id,
        record: pane.current,
        onRestored: (rec) => { if (rec) pane.adoptRecord(unwrapRecord(rec), { push: true }); },
      });
    } catch (err) { pane.toast("versions: " + NOT_YET); }
  }

  async function compareWith(m) {
    const mod = await tryImport("../compare/index.js");
    const fn = pickFn(mod, ["openCompare", "openDiff", "compareDialog"]);
    if (!fn) { pane.toast("compare: " + NOT_YET); return; }
    try {
      fn(ctx, {
        a_id: pane.current && pane.current.id ? pane.current.id : null,
        a_text: pane.buf.body,
        b_id: m.id,
        b_text: m.body,
        titleA: D.labelOf(pane.buf.body) || "this",
        titleB: m.label,
      });
    } catch (err) { pane.toast("compare: " + NOT_YET); }
  }

  async function compareConflict(fresh) {
    const mod = await tryImport("../compare/index.js");
    const fn = pickFn(mod, ["openCompare", "openDiff", "compareDialog"]);
    if (!fn) { pane.toast("compare: " + NOT_YET); return; }
    try {
      fn(ctx, {
        a_id: fresh.id,
        a_text: pane.buf.body,
        b_id: fresh.id,
        b_text: String(fresh.body || ""),
        titleA: "mine",
        titleB: "theirs",
      });
    } catch (_) { pane.toast("compare: " + NOT_YET); }
  }

  pane.openTagPicker = openTagPicker;
  pane.openPicker = openPicker;
  pane.openDiffVsSaved = openDiffVsSaved;
  pane.openVersions = openVersions;
  pane.compareWith = compareWith;
  pane.compareConflict = compareConflict;
}
