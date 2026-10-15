/* The compare dialog's action buttons, and what each does. An action that
 * cannot apply stays visible, disabled, with a title saying why.
 */

import { ARROW, quote, shortLabel, unwrapRecord } from "./text.js";

/**
 * The actions for `dlg` (a CompareDialog): keep left, keep right, merge → new,
 * merge, keep both. Each is {key, label, kind, disabled, title, run}.
 */
export function compareActions(dlg) {
  const { a_id, b_id, titleA, titleB } = dlg;
  const pairReason = !(a_id && b_id) ? "both sides must be saved prompts"
    : a_id === b_id ? "both sides are the same record" : "";
  const ready = !dlg.loading && !!dlg.opcodes;
  const spec = (key, label, { kind = "", title, reason = "", needsDiff = true, run }) => {
    const waiting = needsDiff && !ready;
    return { key, label, kind, disabled: !!reason || waiting, title: reason || (waiting ? "waiting for the diff" : title), run };
  };
  return [
    spec("keep_left", "keep left", {
      title: `${quote(titleB)} adopts the left body`,
      reason: b_id ? "" : "the right side is not a saved prompt, so there is nothing to overwrite",
      run: () => adopt(dlg, b_id, titleB, dlg.aText, "left"),
    }),
    spec("keep_right", "keep right", {
      title: `${quote(titleA)} adopts the right body`,
      reason: a_id ? "" : "the left side is not a saved prompt, so there is nothing to overwrite",
      run: () => adopt(dlg, a_id, titleA, dlg.bText, "right"),
    }),
    spec("merge_new", `merge ${ARROW} new`, {
      title: "edit a union of both bodies and save it as a new prompt",
      run: async () => dlg.deps.openMergeEditor({
        left: { id: a_id, label: titleA, body: dlg.aText },
        right: { id: b_id, label: titleB, body: dlg.bText },
        opcodes: dlg.opcodes,
        onSaved: () => dlg.deps.close(),
      }),
    }),
    spec("merge", "merge", {
      kind: "primary",
      title: `merge ${quote(titleB)} into ${quote(titleA)}`,
      reason: pairReason,
      run: () => merge(dlg),
    }),
    spec("keep_both", "keep both", {
      needsDiff: false, // must work even when the diff request fails
      title: "stop flagging this pair as duplicates",
      reason: pairReason,
      run: () => keepBoth(dlg),
    }),
  ];
}

/** Overwrite record `id` with `text` (its old body is kept as a version). */
async function adopt(dlg, id, name, text, which) {
  const { api, confirm, toast, onLibraryChanged, close } = dlg.deps;
  const ok = await confirm({
    title: `keep ${which}?`,
    message: `Overwrite ${quote(name)} with the ${which} version?\n` +
      "Its current body is kept as a version, so this is undoable.",
    confirmLabel: `keep ${which}`,
    danger: true,
  });
  if (!ok) return;
  const rec = unwrapRecord(await api.update({ id, body: text }));
  toast(rec ? `${quote(shortLabel(rec) || name)} updated` : "updated", { kind: "success" });
  onLibraryChanged();
  close();
}

async function merge(dlg) {
  const { api, confirm, toast, onLibraryChanged, close } = dlg.deps;
  const { a_id, b_id, titleA, titleB } = dlg;
  const ok = await confirm({
    title: "merge these two?",
    message: `${quote(titleB)} is merged into ${quote(titleA)}.\n` +
      "Usage counts are summed and tags are unioned. " +
      `${quote(titleB)} is deleted, and its body is kept as a version of ${quote(titleA)}.`,
    confirmLabel: "merge",
    danger: true,
  });
  if (!ok) return;
  const rec = unwrapRecord(await api.merge({ winner_id: a_id, loser_id: b_id }));
  toast(`merged into ${quote(shortLabel(rec) || titleA)}`, { kind: "success" });
  onLibraryChanged();
  close();
}

async function keepBoth(dlg) {
  const { api, confirm, toast, onLibraryChanged, close } = dlg.deps;
  const ok = await confirm({
    title: "keep both?",
    message: `${quote(dlg.titleA)} and ${quote(dlg.titleB)} are both kept.\n` +
      "This pair will not be flagged as duplicates again.",
    confirmLabel: "keep both",
  });
  if (!ok) return;
  await api.ignorePair(dlg.a_id, dlg.b_id);
  toast("kept both — this pair will not be flagged again", { kind: "success" });
  onLibraryChanged();
  close();
}
