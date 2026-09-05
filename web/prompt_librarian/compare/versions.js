import { NS } from "../shared/ns.js";
import { clear, cls, h } from "../shared/dom.js";
import { labelOf, truncate } from "../shared/text.js";
import { fmtInt, relTime } from "../shared/format.js";
import { debounce } from "../shared/timing.js";
import {
  MIDDOT,
  bindKey,
  btn,
  confirmWith,
  copyText,
  errMsg,
  errorRow,
  focusFirst,
  isAborted,
  isTextEntry,
  openLayer,
  skeleton,
  str,
  toast,
  unwrapRecord,
} from "./common.js";
import { renderDiff } from "./diff.js";

const VIRTUALISE_AT = 60;

export const RESTORE_CONFIRM = "Restores this version as a new version. History is not erased.";

/** List previews first; fetch full bodies only on selection to bound responses.
 *
 * @param {object} ctx
 * @param {{id: string, record?: object, onRestored?: Function}} opts
 * @returns {{el: HTMLElement, close: () => void, reload: () => void}}
 */
export function openVersions(ctx, opts = {}) {
  const o = opts || {};
  const id = str(o.id || (o.record && o.record.id));
  // A COPY: restore updates the local view of the record, and mutating the
  // inspector's `current` object behind its back would desync its dirty check.
  const record = Object.assign({ id }, o.record && typeof o.record === "object" ? o.record : null);

  let currentBody = str(record.body);
  let rows = []; // display order: [current, newest, …, oldest]
  let selected = 0;
  let listLoading = true;
  let listError = "";
  let paneState = "idle"; // idle | loading | ready | error
  let paneError = "";
  let paneOpcodes = null;
  let paneVersion = null; // {index, ts, body}
  let disposed = false;
  let seq = 0; // belt-and-braces over the lane's own sequence guard
  let vlist = null;


  const listBox = h("div", {
    className: "pl-list",
    role: "listbox",
    tabIndex: 0,
    "aria-label": "versions",
    style: { border: "1px solid var(--pl-border-soft)", borderRadius: "6px", maxHeight: "100%" },
  });

  const paneHead = h("div", {
    style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: "0" },
  });
  const paneTitle = h("div", { className: "pl-lbl" }, "");
  const paneMeta = h("span", { className: "pl-row-meta" }, "");
  const paneActs = h("div", { className: "pl-dupe-acts", style: { marginLeft: "auto", display: "flex", gap: "8px" } });
  paneHead.appendChild(paneTitle);
  paneHead.appendChild(paneMeta);
  paneHead.appendChild(paneActs);

  const paneBody = h("div", { style: { minHeight: "0", minWidth: "0" } });

  const pane = h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: "0", minHeight: "0" } },
    paneHead,
    paneBody
  );

  const body = h(
    "div",
    {
      className: "pl-dialog-body",
      style: {
        display: "grid",
        gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)",
        gap: "12px",
        minHeight: "0",
      },
    },
    listBox,
    pane
  );

  const acts = h(
    "div",
    { className: "pl-dialog-acts" },
    btn("close", { kind: "ghost", onClick: () => layer.close(), title: "Esc" })
  );

  const el = h(
    "div",
    { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "version history" },
    h("div", { className: "pl-dialog-title" }, `versions ${MIDDOT} ${labelOf(record) || id}`),
    body,
    acts
  );


  function rowEl() {
    const label = h("span", { className: "pl-row-name" });
    const badge = h("span", { className: "pl-badge-dupe", hidden: true }, "current");
    const preview = h("div", { className: "pl-row-body" });
    const meta = h("div", { className: "pl-row-meta" });
    const row = h(
      "div",
      { className: "pl-row", role: "option", "aria-selected": "false" },
      h("span", { className: "pl-row-bar" }),
      label,
      badge,
      preview,
      meta
    );
    row.__parts = { label, badge, preview, meta };
    return row;
  }

  function paintRow(el2, item, index) {
    if (!el2 || !el2.__parts) return;
    const p = el2.__parts;
    if (!item) {
      el2.classList.add("pl-row-skel");
      p.label.textContent = "";
      p.preview.textContent = "";
      p.meta.textContent = "";
      p.badge.hidden = true;
      return;
    }
    el2.classList.remove("pl-row-skel");
    p.label.textContent = item.label;
    p.badge.hidden = !item.isCurrent;
    p.preview.textContent = item.preview;
    p.meta.textContent = item.meta;
    el2.setAttribute("aria-selected", index === selected ? "true" : "false");
    cls(el2, "is-sel", index === selected);
    el2.dataset.idx = String(index);
  }

  function rowMeta(item) {
    const bits = [];
    const rel = relTime(item.ts);
    if (rel) bits.push(rel);
    bits.push(`${fmtInt(item.chars)} chars`);
    if (item.src) bits.push("from a merge");
    return bits.join(` ${MIDDOT} `);
  }

  function buildRows(previews) {
    const list = [];
    list.push({
      index: null,
      isCurrent: true,
      label: labelOf(record) || "current",
      preview: truncate(str(currentBody).replace(/\s+/g, " ").trim(), 160),
      chars: str(currentBody).length,
      ts: str(record.updated),
      src: null,
    });
    const sorted = (previews || []).slice().sort((x, y) => (Number(y.index) || 0) - (Number(x.index) || 0));
    for (const v of sorted) {
      list.push({
        index: Number(v.index),
        isCurrent: false,
        // Historical labels use the current corpus.
        label: str(v.label) || `version ${Number(v.index) + 1}`,
        preview: str(v.preview),
        chars: Number(v.chars) || 0,
        ts: str(v.ts),
        src: v.src || null,
      });
    }
    for (const item of list) item.meta = rowMeta(item);
    return list;
  }

  async function paintList() {
    clear(listBox);
    if (vlist && typeof vlist.destroy === "function") {
      try {
        vlist.destroy();
      } catch (_) {
      }
      vlist = null;
    }
    if (listLoading) {
      listBox.appendChild(h("div", { className: "pl-list-empty" }, "loading versions…"));
      return;
    }
    if (listError) {
      listBox.appendChild(errorRow(listError, reload));
      return;
    }
    if (!rows.length) {
      listBox.appendChild(h("div", { className: "pl-list-empty" }, "no versions yet"));
      return;
    }

    if (rows.length > VIRTUALISE_AT) {
      // Fall back to plain rows if the optional virtual list cannot load.
      try {
        const mod = await import("../browse/virtual-list.js");
        if (mod && typeof mod.VirtualList === "function") {
          const spacer = h("div", { className: "pl-list-spacer" });
          const win = h("div", { className: "pl-list-win" });
          listBox.appendChild(spacer);
          listBox.appendChild(win);
          vlist = new mod.VirtualList({
            viewport: listBox,
            spacer,
            win,
            createRow: rowEl,
            updateRow: paintRow,
            onActivate: (index) => select(index),
            source: { get: (i) => rows[i] || null, peek: (i) => rows[i] || null },
          });
          vlist.setTotal(rows.length);
          return;
        }
      } catch (err) {
        console.warn(`${NS} VirtualList unavailable; using plain rows`, err && err.message);
        clear(listBox);
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const el2 = rowEl();
      // Plain rows are not virtualised, so they must not be pinned to
      // --pl-row-h; a long preview would be clipped.
      el2.style.height = "auto";
      el2.style.minHeight = "72px";
      paintRow(el2, rows[i], i);
      listBox.appendChild(el2);
    }
  }

  function onListClick(e) {
    let node = e.target;
    while (node && node !== listBox && !(node.dataset && node.dataset.idx != null)) node = node.parentNode;
    if (!node || node === listBox) return;
    const i = Number(node.dataset.idx);
    if (Number.isFinite(i)) select(i);
  }

  function repaintSelection() {
    if (vlist && typeof vlist.repaint === "function") {
      vlist.repaint();
      return;
    }
    const kids = listBox.querySelectorAll ? listBox.querySelectorAll(".pl-row") : [];
    for (const kid of kids) {
      const i = Number(kid.dataset ? kid.dataset.idx : NaN);
      const on = i === selected;
      kid.setAttribute("aria-selected", on ? "true" : "false");
      cls(kid, "is-sel", on);
    }
  }


  let diffHandle = null;

  function paintPane() {
    if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
    diffHandle = null;
    clear(paneActs);
    const item = rows[selected] || null;

    paneTitle.textContent = item ? item.label : "";
    paneMeta.textContent = item ? item.meta : "";

    const isCurrent = !item || item.isCurrent;
    const haveBody = !!(paneVersion && paneVersion.body != null);

    paneActs.appendChild(
      btn("Restore", {
        key: "restore",
        kind: "primary",
        disabled: isCurrent || paneState !== "ready",
        title: isCurrent
          ? "this is already the current version"
          : "snapshots the current body first, then restores this one",
        onClick: () => doRestore(item),
      })
    );
    paneActs.appendChild(
      btn("Load into node", {
        key: "load",
        disabled: !isCurrent && !haveBody,
        title: "sends this version to the node WITHOUT saving it — the stored prompt is untouched",
        onClick: () => doLoad(item),
      })
    );
    paneActs.appendChild(
      btn("Copy", {
        key: "copy",
        disabled: !isCurrent && !haveBody,
        title: "copy this version's text to the clipboard",
        onClick: () => doCopy(item),
      })
    );

    clear(paneBody);
    if (!item) return;
    if (item.isCurrent) {
      paneBody.appendChild(
        h("div", { className: "pl-list-empty" }, "this is the current body — pick a snapshot to see what changed")
      );
      const col = h("div", { className: "pl-diff-col", style: { maxHeight: "40vh" } }, currentBody);
      paneBody.appendChild(col);
      return;
    }
    if (paneState === "loading") {
      paneBody.appendChild(h("div", { className: "pl-diff" }, skeleton(3), skeleton(3)));
      return;
    }
    if (paneState === "error") {
      paneBody.appendChild(errorRow(paneError, () => select(selected, { force: true })));
      return;
    }
    if (paneState !== "ready") return;

    const labels = h(
      "div",
      { className: "pl-diff" },
      h("div", { className: "pl-lbl" }, item.label),
      h("div", { className: "pl-lbl" }, "current")
    );
    const box = h("div", { style: { minHeight: "0" } });
    paneBody.appendChild(labels);
    paneBody.appendChild(box);
    const mode = narrow() ? "unified" : "split";
    // Use inline display: .pl-diff grid styles override the browser's hidden rule.
    labels.style.display = mode === "unified" ? "none" : "";
    diffHandle = renderDiff(box, {
      opcodes: paneOpcodes,
      a: paneVersion ? str(paneVersion.body) : "",
      b: currentBody,
      mode,
    });
  }

  function narrow() {
    try {
      const root = ctx && ctx.root;
      return !!(root && root.dataset && root.dataset.w === "narrow");
    } catch (_) {
      return false;
    }
  }


  async function select(index, opts2 = {}) {
    if (disposed) return;
    const i = Math.max(0, Math.min(rows.length - 1, Number(index) || 0));
    const changed = i !== selected;
    selected = i;
    repaintSelection();
    if (vlist && typeof vlist.scrollToIndex === "function") vlist.scrollToIndex(i);
    const item = rows[i];
    if (!item) return;
    if (item.isCurrent) {
      paneState = "idle";
      paneVersion = null;
      paneOpcodes = null;
      paintPane();
      return;
    }
    if (!changed && !opts2.force && paneState === "ready" && paneVersion && paneVersion.index === item.index) {
      paintPane();
      return;
    }

    const mine = ++seq;
    paneState = "loading";
    paneError = "";
    paneVersion = null;
    paneOpcodes = null;
    paintPane();

    // Fetch body and diff in one lane run so superseded selections cannot half-land.
    const work = async (signal) => {
      const vres = await ctx.API.version(id, item.index, signal);
      const version = (vres && (vres.version || vres.prompt)) || null;
      const vbody = version ? str(version.body) : "";
      const cres = await ctx.API.compare({ a_text: vbody, b_text: currentBody }, signal);
      return { version, vbody, cres };
    };

    let res;
    try {
      res =
        ctx.lanes && typeof ctx.lanes.versions === "function"
          ? await ctx.lanes.versions(work)
          : await work();
    } catch (err) {
      if (disposed || mine !== seq) return;
      paneState = "error";
      paneError = "could not load this version: " + errMsg(err);
      paintPane();
      return;
    }
    if (isAborted(ctx, res)) return; // a newer selection is already in flight
    if (disposed || mine !== seq) return; // …and the same guard, locally

    paneVersion = Object.assign({}, res.version || {}, { index: item.index, body: res.vbody });
    paneOpcodes = (res.cres && Array.isArray(res.cres.diff) && res.cres.diff) || [];
    paneState = "ready";
    paintPane();
  }


  async function doRestore(item) {
    if (!item || item.isCurrent) return;
    const ok = await confirmWith(ctx, {
      title: "restore this version?",
      message: RESTORE_CONFIRM,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      const rec = unwrapRecord(await ctx.API.restoreVersion(id, item.index));
      toast(ctx, "restored — the previous body is now a version", "success");
      if (rec) {
        currentBody = str(rec.body);
        record.label = rec.label != null ? rec.label : record.label;
        record.updated = rec.updated != null ? rec.updated : record.updated;
        record.body = currentBody;
      }
      if (typeof o.onRestored === "function") o.onRestored(rec);
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      await reload();
    } catch (err) {
      toast(ctx, "restore failed: " + errMsg(err), "error");
    }
  }

  function bodyFor(item) {
    if (!item) return "";
    if (item.isCurrent) return currentBody;
    return paneVersion && paneVersion.index === item.index ? str(paneVersion.body) : "";
  }

  function doLoad(item) {
    const text = bodyFor(item);
    if (!item || (!item.isCurrent && !text)) return;
    if (typeof ctx.loadIntoNode !== "function") {
      toast(ctx, "no node to load into", "error");
      return;
    }
    const res = ctx.loadIntoNode(Object.assign({}, record, { id: record.id || id, body: text }));
    if (res && res.ok === false) {
      toast(ctx, res.reason === "stale_target" ? "that node is gone — pick another" : "could not load into the node", "error");
      return;
    }
    if (res && res.unchanged) toast(ctx, "the node already holds this text", "info");
    else toast(ctx, "sent to the node (not saved)", "success");
  }

  async function doCopy(item) {
    const text = bodyFor(item);
    if (!item || (!item.isCurrent && !text)) return;
    const ok = await copyText(text);
    toast(ctx, ok ? "copied" : "could not copy — select the text and copy manually", ok ? "success" : "error");
  }


  async function reload() {
    if (disposed) return;
    listLoading = true;
    listError = "";
    await paintList();

    if (!currentBody && id && typeof ctx.API.get === "function") {
      try {
        const rec = unwrapRecord(await ctx.API.get(id));
        if (rec) {
          currentBody = str(rec.body);
          record.label = record.label || rec.label;
          record.updated = record.updated || rec.updated;
        }
      } catch (_) {
        /* the previews still work without it */
      }
    }

    let res;
    try {
      const call = (signal) => ctx.API.versions(id, signal);
      res =
        ctx.lanes && typeof ctx.lanes.versions === "function"
          ? await ctx.lanes.versions(call)
          : await call();
    } catch (err) {
      if (disposed) return;
      listLoading = false;
      listError = "could not load versions: " + errMsg(err);
      await paintList();
      return;
    }
    if (isAborted(ctx, res)) return;
    if (disposed) return;

    listLoading = false;
    rows = buildRows((res && res.versions) || []);
    selected = rows.length > 1 ? 1 : 0;
    await paintList();
    await select(selected, { force: true });
  }


  /** Move the highlight immediately; debounce body/diff requests until navigation pauses.
   */
  const scheduleSelect = debounce((i) => select(i), 110);
  const debounces = [scheduleSelect];
  try {
    if (ctx && Array.isArray(ctx.debounces)) ctx.debounces.push(scheduleSelect);
  } catch (_) {
  }

  function moveSelection(next) {
    if (next === selected || !rows.length) return;
    selected = Math.max(0, Math.min(rows.length - 1, next));
    repaintSelection();
    if (vlist && typeof vlist.scrollToIndex === "function") vlist.scrollToIndex(selected);
    scheduleSelect(selected);
  }

  const unbind = [];
  unbind.push(
    bindKey(ctx, el, "keydown", (e) => {
      if (!e || isTextEntry(e.target)) return;
      const k = e.key;
      let next = null;
      if (k === "ArrowDown") next = Math.min(rows.length - 1, selected + 1);
      else if (k === "ArrowUp") next = Math.max(0, selected - 1);
      else if (k === "Home") next = 0;
      else if (k === "End") next = rows.length - 1;
      else return;
      if (typeof e.preventDefault === "function") e.preventDefault();
      moveSelection(next);
    })
  );


  const layer = openLayer(ctx, el, {
    closeOnOutside: false,
    onClose: () => {
      disposed = true;
      seq++; // any response still in flight is now superseded
      for (const d of debounces.splice(0)) {
        try {
          if (d && typeof d.cancel === "function") d.cancel();
        } catch (_) {
        }
      }
      for (const fn of unbind.splice(0)) {
        try {
          fn();
        } catch (_) {
        }
      }
      if (diffHandle && typeof diffHandle.dispose === "function") diffHandle.dispose();
      diffHandle = null;
      if (vlist && typeof vlist.destroy === "function") {
        try {
          vlist.destroy();
        } catch (_) {
        }
      }
      vlist = null;
      try {
        listBox.removeEventListener("click", onListClick);
      } catch (_) {
      }
      if (ctx.lanes && ctx.lanes.versions && typeof ctx.lanes.versions.cancel === "function") {
        try {
          ctx.lanes.versions.cancel();
        } catch (_) {
        }
      }
      if (typeof o.onClose === "function") o.onClose();
    },
  });

  // Delegate clicks so recycled rows do not need listener rebinding.
  listBox.addEventListener("click", onListClick);

  paintPane();
  reload();
  focusFirst(el);

  return {
    el,
    close: () => layer.close(),
    reload,
    select,
    get selectedIndex() {
      return selected;
    },
    get rows() {
      return rows;
    },
  };
}

export const openVersionsDialog = openVersions;
export const versionsDialog = openVersions;
