import { h } from "../shared/dom.js";
import {
  ARROW,
  MIDDOT,
  bindKey,
  btn,
  confirmWith,
  errMsg,
  labelOf,
  openLayer,
  quote,
  str,
  toast,
  unwrapRecord,
} from "./common.js";

/** Seed an editable union from equal runs and both sides' inserts.
 * Save as a new record so the inputs remain intact.
 *
 * @param {object} ctx
 * @param {{left: object, right: object, opcodes?: Array, onSaved?: Function}} opts
 * @returns {{el: HTMLElement, close: () => void, textarea: HTMLTextAreaElement}}
 */
export function openMergeEditor(ctx, opts = {}) {
  const o = opts || {};
  const left = o.left || {};
  const right = o.right || {};
  const a_id = left.id == null || left.id === "" ? null : String(left.id);
  const b_id = right.id == null || right.id === "" ? null : String(right.id);

  const seed = mergeSeed(o.opcodes, str(left.body), str(right.body));

  let busy = false;
  let disposed = false;

  const ta = h("textarea", {
    className: "pl-ta",
    value: seed,
    spellcheck: "false",
    "aria-label": "merged body",
  });

  const hint = h(
    "div",
    { className: "pl-dupe-why", style: { margin: "2px 0 6px" } },
    "seeded with a naive union of both sides " +
      MIDDOT +
      " everything from both bodies is here, in order. Edit it before saving."
  );

  const body = h(
    "div",
    { className: "pl-dialog-body", style: { display: "flex", flexDirection: "column", gap: "8px" } },
    hint,
    h("div", { className: "pl-ta-wrap", style: { minHeight: "220px" } }, ta)
  );

  const saveBtn = btn("save as new", {
    kind: "accent",
    key: "save",
    title:
      a_id && b_id
        ? "creates a third prompt that absorbs both, then deletes them"
        : "creates a new prompt; nothing existing is touched",
    onClick: () => save(),
  });

  const acts = h(
    "div",
    { className: "pl-dialog-acts" },
    btn("cancel", { kind: "ghost", onClick: () => layer.close() }),
    saveBtn
  );

  const el = h(
    "div",
    { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "merge into a new prompt" },
    h("div", { className: "pl-dialog-title" }, `merge ${ARROW} new prompt`),
    body,
    acts
  );

  async function save() {
    if (busy || disposed) return;
    const text = str(ta.value);
    if (!text.trim()) {
      toast(ctx, "the merged body is empty", "error");
      return;
    }
    if (a_id && b_id) {
      const ok = await confirmWith(ctx, {
        title: "save the merge?",
        message:
          `${quote(labelOf(left))} and ${quote(labelOf(right))} are absorbed into one new prompt.\n` +
          "Both originals are deleted and their bodies are kept as versions of the new prompt.",
        confirmLabel: "save as new",
        danger: true,
      });
      if (!ok) return;
    }
    busy = true;
    saveBtn.disabled = true;
    try {
      const res =
        a_id && b_id
          ? await ctx.API.mergeNew({ a_id, b_id, body: text })
          : await ctx.API.create({
              body: text,
              tags: Array.isArray(left.tags) ? left.tags.slice() : [],
            });
      const rec = unwrapRecord(res);
      toast(ctx, `created ${quote(labelOf(rec) || "the merged prompt")}`, "success");
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      if (typeof o.onSaved === "function") o.onSaved(rec);
      layer.close();
    } catch (err) {
      toast(ctx, "merge failed: " + errMsg(err), "error");
    } finally {
      busy = false;
      if (!disposed) saveBtn.disabled = false;
    }
  }

  const unbind = [];
  unbind.push(
    bindKey(ctx, el, "keydown", (e) => {
      if (!e) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "s" || e.key === "S")) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        save();
      }
    })
  );

  const layer = openLayer(ctx, el, {
    closeOnOutside: false,
    onClose: () => {
      disposed = true;
      for (const fn of unbind.splice(0)) {
        try {
          fn();
        } catch (_) {
        }
      }
      if (typeof o.onClose === "function") o.onClose();
    },
  });

  try {
    ta.focus();
  } catch (_) {
  }

  return { el, close: () => layer.close(), textarea: ta };
}

function mergeSeed(opcodes, aText, bText) {
  if (!Array.isArray(opcodes) || !opcodes.length) {
    const a = str(aText);
    const b = str(bText);
    if (!a) return b;
    if (!b || a === b) return a;
    return a + "\n\n" + b;
  }
  const out = [];
  for (const op of opcodes) {
    if (!op) continue;
    const kind = str(op.op) || "equal";
    const aTok = Array.isArray(op.a_tokens) ? op.a_tokens : [];
    const bTok = Array.isArray(op.b_tokens) ? op.b_tokens : [];
    if (kind === "equal") {
      if (aTok.length) out.push(aTok.join(" "));
      continue;
    }
    // delete  -> the left side's insert
    // insert  -> the right side's insert
    // replace -> one of each, left first
    if (aTok.length) out.push(aTok.join(" "));
    if (bTok.length) out.push(bTok.join(" "));
  }
  return out.join(" ");
}
