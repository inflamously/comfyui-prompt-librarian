import { h } from "../../shared/dom.js";
import { popLayer, pushLayer } from "../overlays/layers.js";

export function bytes(value) {
  let n = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function downloadJson(blob) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `prompt-library-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Render snapshots and invoke supplied actions; no API or graph access. */
export function showStorage(state, callbacks) {
  const status = h("div", { className: "pl-storage-status" });
  const actions = h("div", { className: "pl-dialog-acts" });
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });
  const button = (label, onclick, primary = false) => h("button", {
    className: "pl-btn pl-btn-sm" + (primary ? " pl-btn-primary" : ""),
    type: "button", onclick,
  }, label);
  const workButton = (label, work, primary = false) => {
    const btn = button(label, async () => {
      btn.textContent = "working…";
      try { await work(); }
      finally { btn.textContent = label; }
    }, primary);
    return btn;
  };
  const migrate = workButton("Import legacy data", callbacks.migrate);
  const exportBtn = workButton("Export JSON", callbacks.exportJson);
  const importBtn = button("Import JSON", () => file.click());
  const optimize = workButton("Optimize storage", callbacks.optimize, true);
  file.onchange = () => {
    const selected = file.files && file.files[0];
    file.value = "";
    if (selected) callbacks.importJson(selected);
  };
  let handle = null;
  const close = button("Close", () => popLayer(handle));
  actions.append(migrate, exportBtn, importBtn, optimize, close, file);
  const dialog = h("div", {
    className: "pl-dialog pl-storage-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Storage",
  }, h("div", { className: "pl-dialog-title" }, "Storage and backups"), status, actions);
  function paint(next) {
    const storage = next.storage || {};
    const index = storage.index || {};
    status.textContent = "";
    status.appendChild(h("div", null, `database: ${bytes(storage.database_bytes)} · ${storage.records || 0} prompts`));
    status.appendChild(h("div", null, `search index: ${index.state || "unknown"}${index.fts5 ? " · FTS5" : ""}`));
    status.appendChild(h("div", null, `reclaimable: ${bytes(storage.reclaimable_bytes)}`));
    migrate.hidden = !storage.legacy?.available;
    optimize.hidden = !storage.should_compact;
    for (const btn of [migrate, exportBtn, importBtn, optimize]) btn.disabled = !!next.storageBusy;
  }
  paint(state);
  handle = pushLayer({ el: dialog, closeOnOutside: false, onClose: callbacks.onClose });
  return { handle, paint };
}
