import { h } from "../shared/dom.js";
import { API } from "../api/routes.js";
import { refreshAll, reportError } from "./data.js";
import { choiceDialog, popLayer, pushLayer, toast } from "./layers.js";
import { inst, setState } from "./state.js";

function bytes(value) {
  let n = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

function unwrapStorage(payload) {
  return (payload && payload.storage) || payload || null;
}

async function reloadStorage() {
  const payload = await API.storage();
  const storage = unwrapStorage(payload);
  setState({ storage });
  return storage;
}

function downloadJson(blob) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `prompt-library-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function optimizeStorage() {
  const it = inst();
  if (it.storageBusy) return null;
  it.storageBusy = true;
  try {
    const result = await API.compactStorage();
    setState({ storage: unwrapStorage(result) });
    toast(`storage optimized — reclaimed ${bytes((result.before || 0) - (result.after || 0))}`, {
      kind: "success",
    });
    return result;
  } catch (err) {
    reportError(err, "optimize storage");
    return null;
  } finally {
    it.storageBusy = false;
  }
}

export async function openStorage() {
  const it = inst();
  let storage = it.state.storage;
  try {
    storage = await reloadStorage();
  } catch (err) {
    reportError(err, "storage status");
  }

  const status = h("div", { className: "pl-storage-status" });
  const actions = h("div", { className: "pl-dialog-acts" });
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });

  function paint(next) {
    storage = next || storage || {};
    const index = storage.index || {};
    const legacy = storage.legacy || {};
    status.textContent = "";
    status.appendChild(h("div", null, `database: ${bytes(storage.database_bytes)} · ${storage.records || 0} prompts`));
    status.appendChild(h("div", null, `search index: ${index.state || "unknown"}${index.fts5 ? " · FTS5" : ""}`));
    status.appendChild(h("div", null, `reclaimable: ${bytes(storage.reclaimable_bytes)}`));
    migrate.hidden = !legacy.available;
    optimize.hidden = !storage.should_compact;
  }

  async function busy(button, work) {
    if (it.storageBusy) return;
    it.storageBusy = true;
    const old = button.textContent;
    button.disabled = true;
    button.textContent = "working…";
    try {
      await work();
    } finally {
      it.storageBusy = false;
      button.disabled = false;
      button.textContent = old;
    }
  }

  const migrate = h(
    "button",
    {
      className: "pl-btn pl-btn-sm",
      type: "button",
      onclick: () => busy(migrate, async () => {
        const ok = await choiceDialog({
          title: "Import legacy library?",
          message: `This merges ${(legacy.sources || ["the legacy library"]).join(" and ")} into SQLite. The source file is kept unchanged.`,
          choices: [{ value: true, label: "Merge library", primary: true }],
          cancelValue: false,
        });
        if (!ok) return;
        const result = await API.migrateLegacy();
        paint(unwrapStorage(result));
        setState({ storage: unwrapStorage(result) });
        await refreshAll();
        toast(`imported ${result.imported || 0} prompts`, { kind: "success" });
      }).catch((err) => reportError(err, "legacy migration")),
    },
    "Import legacy data"
  );

  const exportBtn = h(
    "button",
    {
      className: "pl-btn pl-btn-sm",
      type: "button",
      onclick: () => busy(exportBtn, async () => {
        downloadJson(await API.exportFile());
        toast("JSON backup downloaded", { kind: "success" });
      }).catch((err) => reportError(err, "export")),
    },
    "Export JSON"
  );

  const importBtn = h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => file.click() }, "Import JSON");
  file.onchange = async () => {
    const selected = file.files && file.files[0];
    file.value = "";
    if (!selected) return;
    try {
      const mode = await choiceDialog({
        title: "Import JSON backup",
        message: `Choose how to import ${selected.name}. Merge keeps current prompts; replace removes them.`,
        cancelValue: null,
        choices: [
          { value: "merge", label: "Merge", primary: true },
          { value: "replace", label: "Replace", danger: true },
        ],
      });
      if (!mode) return;
      await API.importFile(selected, mode);
      paint(await reloadStorage());
      await refreshAll();
      toast("JSON backup imported", { kind: "success" });
    } catch (err) {
      reportError(err, "import");
    }
  };

  const optimize = h(
    "button",
    {
      className: "pl-btn pl-btn-sm pl-btn-primary",
      type: "button",
      onclick: () => busy(optimize, async () => {
        const result = await API.compactStorage();
        paint(unwrapStorage(result));
        setState({ storage: unwrapStorage(result) });
        toast(`storage optimized — reclaimed ${bytes((result.before || 0) - (result.after || 0))}`, { kind: "success" });
      }).catch((err) => reportError(err, "optimize storage")),
    },
    "Optimize storage"
  );

  let handle = null;
  const close = h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => popLayer(handle) }, "Close");
  actions.append(migrate, exportBtn, importBtn, optimize, close, file);
  const dialog = h(
    "div",
    { className: "pl-dialog pl-storage-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Storage" },
    h("div", { className: "pl-dialog-title" }, "Storage and backups"),
    status,
    actions
  );
  handle = pushLayer({ el: dialog, closeOnOutside: false });
  paint(storage);
  return handle;
}
