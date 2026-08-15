/* ==========================================================================
   Prompt Librarian — the compare / merge dialog
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { clear, h } from "../shared/dom.js";
import {
  ARROW,
  SWAP,
  bindKey,
  btn,
  confirmWith,
  errMsg,
  errorRow,
  focusFirst,
  isAborted,
  isTextEntry,
  labelOf,
  openLayer,
  quote,
  skeleton,
  str,
  toast,
  unwrapRecord,
} from "./common.js";
import { reconstruct, renderDiff } from "./diff.js";
import { openMergeEditor } from "./merge-editor.js";

/**
 * The compare/merge dialog. One dialog serves three callers — the dupe panel,
 * `diff vs saved`, and the version history — which is why the action set is a
 * parameter rather than a hard-coded row.
 *
 * @param {object} ctx modal ctx
 * @param {{a_id?: string|null, a_text?: string, b_id?: string|null,
 *          b_text?: string, titleA?: string, titleB?: string,
 *          actions?: Array|Function, mode?: "split"|"unified",
 *          onClose?: Function}} opts
 * @returns {{el: HTMLElement, close: () => void, setMode: (m: string) => void,
 *            reload: () => void}}
 */
export function openCompare(ctx, opts = {}) {
  const o = opts || {};
  const a_id = o.a_id == null || o.a_id === "" ? null : String(o.a_id);
  const b_id = o.b_id == null || o.b_id === "" ? null : String(o.b_id);
  const titleA = str(o.titleA) || (a_id ? "left" : "left");
  const titleB = str(o.titleB) || (b_id ? "right" : "right");

  let aText = str(o.a_text);
  let bText = str(o.b_text);
  let opcodes = null;
  let summary = "";
  let pct = null;
  let loading = true; // the first paint is a skeleton, never an error row
  let busy = false;
  let disposed = false;
  let diffHandle = null;

  /** Timers registered here are cancelled by the layer's onClose. */
  const debounces = [];

  /* ---- chrome ---------------------------------------------------------- */

  const titleEl = h("div", { className: "pl-dialog-title" }, `${titleA}  ${SWAP}  ${titleB}`);
  const matchEl = h("span", { className: "pl-row-match" }, "");
  const summaryEl = h("span", { className: "pl-dupe-why" }, "");
  const metaEl = h(
    "div",
    {
      style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", minWidth: "0" },
    },
    matchEl,
    summaryEl
  );

  const modeTabs = h("div", { className: "pl-tabs", role: "tablist", "aria-label": "Diff mode", style: { padding: "0" } });
  const splitTab = h(
    "button",
    {
      className: "pl-link",
      type: "button",
      role: "tab",
      "aria-selected": "true",
      title: "two columns, chunk-aligned",
      onclick: () => setMode("split"),
    },
    "split"
  );
  const unifiedTab = h(
    "button",
    {
      className: "pl-link",
      type: "button",
      role: "tab",
      "aria-selected": "false",
      title: "one column with inline changes",
      onclick: () => setMode("unified"),
    },
    "unified"
  );
  modeTabs.appendChild(splitTab);
  modeTabs.appendChild(unifiedTab);

  const headRow = h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: "12px", minWidth: "0" } },
    metaEl,
    h("div", { className: "pl-spacer", style: { flex: "1 1 auto" } }),
    modeTabs
  );

  const labels = h(
    "div",
    { className: "pl-diff" },
    h("div", { className: "pl-lbl" }, titleA),
    h("div", { className: "pl-lbl" }, titleB)
  );

  const diffBox = h("div", { style: { minHeight: "0", minWidth: "0" } });
  const body = h("div", { className: "pl-dialog-body" }, headRow, labels, diffBox);
  const acts = h("div", { className: "pl-dialog-acts" });

  const el = h(
    "div",
    {
      className: "pl-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `compare ${titleA} with ${titleB}`,
    },
    titleEl,
    body,
    acts
  );

  /* ---- mode ------------------------------------------------------------ */

  let mode = o.mode === "split" || o.mode === "unified" ? o.mode : defaultMode(ctx);

  function defaultMode(c) {
    try {
      const root = c && c.root;
      if (root && root.dataset && root.dataset.w === "narrow") return "unified";
      const st = c && typeof c.getState === "function" ? c.getState() : null;
      if (st && (st.narrow === true || st.width === "narrow")) return "unified";
    } catch (_) {
      /* ignore */
    }
    return "split";
  }

  function setMode(next) {
    mode = next === "unified" ? "unified" : "split";
    splitTab.setAttribute("aria-selected", mode === "split" ? "true" : "false");
    unifiedTab.setAttribute("aria-selected", mode === "unified" ? "true" : "false");
    // NOT `labels.hidden`: .pl-diff sets `display: grid`, which beats the UA
    // `[hidden] { display: none }` rule, and librarian.css has no
    // `.pl-diff[hidden]` override. An inline display wins outright.
    labels.style.display = mode === "unified" ? "none" : "";
    paintDiff();
  }

  /* ---- painting -------------------------------------------------------- */

  function paintDiff() {
    if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
    diffHandle = null;
    if (loading) {
      clear(diffBox);
      const sk = h("div", { className: "pl-diff" }, skeleton(3), skeleton(3));
      diffBox.appendChild(sk);
      return;
    }
    if (!opcodes) {
      clear(diffBox);
      diffBox.appendChild(errorRow(lastError || "nothing to compare", lastError ? reload : null));
      return;
    }
    diffHandle = renderDiff(diffBox, { opcodes, a: aText, b: bText, mode });
  }

  function paintMeta() {
    matchEl.textContent = pct == null ? "" : `${pct}% match`;
    summaryEl.textContent = summary ? `differs: ${summary}` : "";
  }

  /* ---- data ------------------------------------------------------------ */

  let lastError = "";

  function comparePayload() {
    const p = {};
    if (aText || !a_id) p.a_text = aText;
    if (a_id) p.a_id = a_id;
    if (bText || !b_id) p.b_text = bText;
    if (b_id) p.b_id = b_id;
    return p;
  }

  async function reload() {
    if (disposed) return;
    loading = true;
    lastError = "";
    paintDiff();
    let res;
    try {
      const call = (signal) => ctx.API.compare(comparePayload(), signal);
      res =
        ctx.lanes && typeof ctx.lanes.diff === "function" ? await ctx.lanes.diff(call) : await call();
    } catch (err) {
      if (disposed) return;
      loading = false;
      lastError = "compare failed: " + errMsg(err);
      opcodes = null;
      paintDiff();
      renderActions();
      return;
    }
    if (isAborted(ctx, res)) return; // a newer compare is already running
    if (disposed) return;
    loading = false;
    const data = res && typeof res === "object" ? res : {};
    opcodes = Array.isArray(data.diff) ? data.diff : [];
    summary = str(data.summary);
    pct = data.pct == null ? (data.score == null ? null : Math.round(Number(data.score) * 100)) : Number(data.pct);
    if (!aText) aText = reconstruct(opcodes, "a");
    if (!bText) bText = reconstruct(opcodes, "b");
    paintMeta();
    paintDiff();
    renderActions();
  }

  /* ---- actions --------------------------------------------------------- */

  const api = {
    ctx,
    a_id,
    b_id,
    titleA,
    titleB,
    get a_text() {
      return aText;
    },
    get b_text() {
      return bText;
    },
    get opcodes() {
      return opcodes;
    },
    close: () => layer.close(),
    reload,
  };

  function setBusy(on) {
    busy = !!on;
    for (const b of acts.querySelectorAll ? acts.querySelectorAll("button") : []) {
      if (on) b.disabled = true;
    }
    if (!on) renderActions();
  }

  /** Wrap an action so a throw becomes a toast and the row is never stuck. */
  function guard(fn) {
    return async () => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        toast(ctx, errMsg(err), "error");
      } finally {
        if (!disposed) setBusy(false);
      }
    };
  }

  async function adopt(targetId, targetName, sourceText, which) {
    const ok = await confirmWith(ctx, {
      title: `keep ${which}?`,
      message:
        `Overwrite ${quote(targetName)} with the ${which} version?\n` +
        "Its current body is kept as a version, so this is undoable.",
      confirmLabel: `keep ${which}`,
      danger: true,
    });
    if (!ok) return;
    const rec = unwrapRecord(await ctx.API.update({ id: targetId, body: sourceText }));
    toast(ctx, rec ? `${quote(labelOf(rec) || targetName)} updated` : "updated", "success");
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
    if (typeof o.onApplied === "function") o.onApplied(rec);
    layer.close();
  }

  /**
   * Build one action descriptor.
   *
   * An action that cannot apply — `a_id` is null because the left side is an
   * unsaved buffer, say — is rendered DISABLED with the reason in its `title`.
   * Never hidden (the user cannot tell a missing button from a bug) and never
   * silently broken.
   */
  function spec(key, label, opts2) {
    const ready = !loading && !!opcodes;
    const blocked = opts2.reason || "";
    return {
      key,
      label,
      kind: opts2.kind || "",
      disabled: !!blocked || (opts2.needsDiff !== false && !ready),
      title: blocked || (opts2.needsDiff !== false && !ready ? "waiting for the diff" : opts2.title),
      run: opts2.run,
    };
  }

  function defaultSpecs() {
    const bothIds = !!(a_id && b_id);
    const same = bothIds && a_id === b_id;
    const pairReason = !bothIds
      ? "both sides must be saved prompts"
      : same
      ? "both sides are the same record"
      : "";

    const specs = [];

    specs.push(
      spec("keep_left", "keep left", {
        title: `${quote(titleB)} adopts the left body`,
        reason: b_id ? "" : "the right side is not a saved prompt, so there is nothing to overwrite",
        run: () => adopt(b_id, titleB, aText, "left"),
      })
    );

    specs.push(
      spec("keep_right", "keep right", {
        title: `${quote(titleA)} adopts the right body`,
        reason: a_id ? "" : "the left side is not a saved prompt, so there is nothing to overwrite",
        run: () => adopt(a_id, titleA, bText, "right"),
      })
    );

    specs.push(
      spec("merge_new", `merge ${ARROW} new`, {
        title: "edit a union of both bodies and save it as a new prompt",
        run: async () => {
          openMergeEditor(ctx, {
            left: { id: a_id, label: titleA, body: aText },
            right: { id: b_id, label: titleB, body: bText },
            opcodes,
            onSaved: (rec) => {
              if (typeof o.onApplied === "function") o.onApplied(rec);
              layer.close();
            },
          });
        },
      })
    );

    specs.push(
      spec("merge", "merge", {
        kind: "primary",
        title: `merge ${quote(titleB)} into ${quote(titleA)}`,
        reason: pairReason,
        run: async () => {
          const ok = await confirmWith(ctx, {
            title: "merge these two?",
            message:
              `${quote(titleB)} is merged into ${quote(titleA)}.\n` +
              "Usage counts are summed and tags are unioned. " +
              `${quote(titleB)} is deleted, and its body is kept as a version of ${quote(titleA)}.`,
            confirmLabel: "merge",
            danger: true,
          });
          if (!ok) return;
          const rec = unwrapRecord(await ctx.API.merge({ winner_id: a_id, loser_id: b_id }));
          toast(ctx, `merged into ${quote(labelOf(rec) || titleA)}`, "success");
          if (typeof ctx.refreshAll === "function") ctx.refreshAll();
          if (typeof o.onApplied === "function") o.onApplied(rec);
          layer.close();
        },
      })
    );

    specs.push(
      spec("keep_both", "keep both", {
        // Deliberately not gated on the diff: "keep both" is the answer to
        // "these are duplicates", and it stays available even if /compare is
        // down.
        needsDiff: false,
        title: "stop flagging this pair as duplicates",
        reason: pairReason,
        run: async () => {
          const ok = await confirmWith(ctx, {
            title: "keep both?",
            message:
              `${quote(titleA)} and ${quote(titleB)} are both kept.\n` +
              "This pair will not be flagged as duplicates again.",
            confirmLabel: "keep both",
          });
          if (!ok) return;
          await ctx.API.ignorePair(a_id, b_id);
          toast(ctx, "kept both — this pair will not be flagged again", "success");
          if (typeof ctx.refreshAll === "function") ctx.refreshAll();
          layer.close();
        },
      })
    );

    return specs;
  }

  function normaliseSpec(item, byKey) {
    if (typeof item === "string") return byKey[item] || null;
    if (!item || typeof item !== "object") return null;
    const base = item.key && byKey[item.key] ? Object.assign({}, byKey[item.key]) : {};
    const out = Object.assign(base, item);
    const cb = item.run || item.onClick || item.onclick || base.run;
    out.run = typeof cb === "function" ? () => cb(api) : () => {};
    return out;
  }

  function renderActions() {
    clear(acts);
    const defaults = defaultSpecs();
    const byKey = Object.create(null);
    for (const s of defaults) byKey[s.key] = s;

    let specs;
    if (typeof o.actions === "function") {
      let produced = null;
      try {
        produced = o.actions(api, defaults);
      } catch (err) {
        console.error(`${NS} compare actions() threw`, err);
      }
      specs = (Array.isArray(produced) ? produced : defaults)
        .map((s) => normaliseSpec(s, byKey))
        .filter(Boolean);
    } else if (Array.isArray(o.actions)) {
      specs = o.actions.map((s) => normaliseSpec(s, byKey)).filter(Boolean);
    } else {
      specs = defaults;
    }

    for (const s of specs) {
      acts.appendChild(
        btn(s.label, {
          key: s.key,
          kind: s.kind,
          title: s.title,
          disabled: !!s.disabled || busy,
          onClick: guard(() => s.run(api)),
        })
      );
    }
    acts.appendChild(
      btn("close", { kind: "ghost", key: "close", onClick: () => layer.close(), title: "Esc" })
    );
  }

  /* ---- keys ------------------------------------------------------------ */

  const unbind = [];
  unbind.push(
    bindKey(ctx, el, "keydown", (e) => {
      if (!e) return;
      // Escape is handled by the modal (it pops the top layer). Only the local
      // shortcuts live here.
      if ((e.key === "u" || e.key === "U") && !e.ctrlKey && !e.metaKey && !isTextEntry(e.target)) {
        setMode(mode === "split" ? "unified" : "split");
        if (typeof e.preventDefault === "function") e.preventDefault();
      }
    })
  );

  /* ---- layer ----------------------------------------------------------- */

  const layer = openLayer(ctx, el, {
    closeOnOutside: false,
    onClose: () => {
      disposed = true;
      for (const fn of unbind.splice(0)) {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      }
      for (const d of debounces.splice(0)) {
        try {
          if (d && typeof d.cancel === "function") d.cancel();
        } catch (_) {
          /* ignore */
        }
      }
      if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
      diffHandle = null;
      // Abort work this dialog started; a response landing after close would
      // paint into a detached tree.
      if (loading && ctx.lanes && ctx.lanes.diff && typeof ctx.lanes.diff.cancel === "function") {
        try {
          ctx.lanes.diff.cancel();
        } catch (_) {
          /* ignore */
        }
      }
      if (typeof o.onClose === "function") o.onClose();
    },
  });

  setMode(mode);
  renderActions();
  reload();
  focusFirst(el);

  return {
    el,
    close: () => layer.close(),
    setMode,
    reload,
    get mode() {
      return mode;
    },
  };
}

export const openDiff = openCompare;
export const compareDialog = openCompare;
