/* What the dupes panel's "merge" and "overwrite" do with the editor's text.
 * Both ask first, write, then adopt the surviving record.
 */

import { ensureOk } from "../../../api/request.js";
import { labelOf } from "../../../shared/text.js";
import { quoted } from "../glyphs.js";
import { errMsg, unwrapRecord } from "../records.js";

/** Merge the editor into match `m`: it keeps its id, usage and history and takes this text. */
export async function mergeInto(pane, m) {
  if (!m || !m.id) return;
  const mine = pane.current && pane.current.id ? String(pane.current.id) : null;
  const ok = await ask(pane, {
    title: "Merge",
    message: `Merge into ${quoted(m.label)}? It keeps the id, usage count and history; ` +
      (mine ? "this record is absorbed and removed." : "your text becomes its current body."),
    confirmLabel: "Merge",
    danger: false,
  });
  if (!ok) return;
  try {
    const rec = mine && mine !== String(m.id)
      ? unwrapRecord(ensureOk(await pane.deps.api.merge({ winner_id: m.id, loser_id: mine, body: pane.buf.body })))
      : await replaceBodyOf(pane, m.id); // nothing of ours is saved yet: update the match itself
    if (mine) pane.clearDraft(mine);
    if (rec && rec.id) {
      pane.clearDraft(rec.id);
      pane.adoptRecord(rec, { push: true });
      pane.toast(`merged into ${quoted(labelOf(rec))}`, "success");
    } else {
      pane.toast("merged", "success");
    }
    pane.saveFlow.afterWrite();
  } catch (err) {
    pane.toast("merge failed: " + errMsg(err), "error");
  }
}

/** Replace the text of match `m` with the editor's and keep both records. */
export async function overwriteMatch(pane, m) {
  if (!m || !m.id) return;
  const ok = await ask(pane, {
    title: `Overwrite ${quoted(m.label)}?`,
    message: `Replaces the text of ${quoted(m.label)} with what you have here. ` +
      "Its previous text is kept in that record's version history.",
    confirmLabel: "Overwrite",
    danger: true,
  });
  if (!ok) return;
  try {
    const rec = await replaceBodyOf(pane, m.id);
    if (rec && rec.id) {
      pane.clearDraft(rec.id);
      pane.adoptRecord(rec, { push: true });
    }
    pane.toast(`overwrote ${quoted(m.label)}`, "success");
    pane.saveFlow.afterWrite();
  } catch (err) {
    pane.toast("overwrite failed: " + errMsg(err), "error");
  }
}

async function ask(pane, opts) {
  let ok = false;
  try {
    ok = await pane.deps.dialogs.confirm({ cancelLabel: "Cancel", ...opts });
  } catch (_) { ok = false; }
  return ok && !pane.disposed;
}

/** Write the buffer body onto record `id`, keeping its tags and using its own
 * `updated` stamp for optimistic concurrency. Errors go to the caller. */
async function replaceBodyOf(pane, id) {
  const { api } = pane.deps;
  const fresh = unwrapRecord(ensureOk(await api.get(id)));
  if (!fresh || !fresh.id) throw new Error("that prompt no longer exists");
  return unwrapRecord(ensureOk(await api.update({
    id: fresh.id, tags: fresh.tags, body: pane.buf.body, expect_updated: fresh.updated,
  })));
}
