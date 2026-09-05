import { API } from "../../api/routes.js";
import { refreshAll, reportError } from "../library/data.js";
import { choiceDialog } from "../overlays/dialogs.js";
import { toast } from "../overlays/toasts.js";
import { inst, setState, subscribe } from "../state.js";
import { bytes, downloadJson, showStorage } from "./view.js";

function unwrapStorage(payload) {
  return (payload && payload.storage) || payload || null;
}

export async function reloadStorage() {
  const payload = await API.storage();
  const storage = unwrapStorage(payload);
  setState({ storage });
  return storage;
}

/** Serialize storage writes across the footer and dialog, with one error path. */
async function runStorage(what, work) {
  if (inst().state.storageBusy) return null;
  setState({ storageBusy: true });
  try { return await work(); }
  catch (err) { reportError(err, what); return null; }
  finally { setState({ storageBusy: false }); }
}

export function optimizeStorage() {
  return runStorage("optimize storage", async () => {
    const result = await API.compactStorage();
    setState({ storage: unwrapStorage(result) });
    toast(`storage optimized — reclaimed ${bytes((result.before || 0) - (result.after || 0))}`, { kind: "success" });
    return result;
  });
}

export function importLegacy() {
  return runStorage("legacy migration", async () => {
    // Read at invocation: the retained dialog may have received a newer snapshot.
    const legacy = inst().state.storage?.legacy || {};
    const ok = await choiceDialog({
      title: "Import legacy library?",
      message: `This merges ${(legacy.sources || ["the legacy library"]).join(" and ")} into SQLite. The source file is kept unchanged.`,
      choices: [{ value: true, label: "Merge library", primary: true }],
      cancelValue: false,
    });
    if (!ok) return null;
    const result = await API.migrateLegacy();
    setState({ storage: unwrapStorage(result) });
    await refreshAll();
    toast(`imported ${result.imported || 0} prompts`, { kind: "success" });
    return result;
  });
}

export function exportJson() {
  return runStorage("export", async () => {
    downloadJson(await API.exportFile());
    toast("JSON backup downloaded", { kind: "success" });
  });
}

export function importJson(selected) {
  if (!selected) return Promise.resolve(null);
  return runStorage("import", async () => {
    const mode = await choiceDialog({
      title: "Import JSON backup",
      message: `Choose how to import ${selected.name}. Merge keeps current prompts; replace removes them.`,
      cancelValue: null,
      choices: [
        { value: "merge", label: "Merge", primary: true },
        { value: "replace", label: "Replace", danger: true },
      ],
    });
    if (!mode) return null;
    const result = await API.importFile(selected, mode);
    await reloadStorage();
    await refreshAll();
    toast("JSON backup imported", { kind: "success" });
    return result;
  });
}

export async function openStorage() {
  const it = inst();
  const session = it.session;
  try { await reloadStorage(); }
  catch (err) { if (it.open && it.session === session) reportError(err, "storage status"); }
  if (!it.open || it.session !== session) return null;
  let unsubscribe = () => {};
  const view = showStorage(it.state, {
    migrate: importLegacy, exportJson, importJson, optimize: optimizeStorage,
    onClose: () => unsubscribe(),
  });
  const offStorage = subscribe("storage", view.paint);
  const offBusy = subscribe("storageBusy", view.paint);
  unsubscribe = () => { offStorage(); offBusy(); };
  return view.handle;
}
