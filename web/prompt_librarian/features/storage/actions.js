/* Storage operations: status, compaction, the legacy migration, and JSON
 * export and import. Writes are serialized through the slice's `busy` flag, so
 * the footer hint and the dialog can never run two at once, and every failure
 * goes through one error path.
 */

import { bytes, downloadJson } from "./format.js";

const unwrap = (payload) => (payload && payload.storage) || payload || null;

/**
 * The operations over deps: api, slice (storage), choose(opts), toast,
 * reportError(err, what), onLibraryChanged().
 */
export function storageActions(deps) {
  const { api, slice, choose, toast, reportError, onLibraryChanged } = deps;

  async function run(what, work) {
    if (slice.get("busy")) return null;
    slice.set({ busy: true });
    try { return await work(); }
    catch (err) { reportError(err, what); return null; }
    finally { slice.set({ busy: false }); }
  }

  /** Fetch the current status into the slice. */
  async function reload() {
    const storage = unwrap(await api.storage());
    slice.set({ storage });
    return storage;
  }

  const optimize = () => run("optimize storage", async () => {
    const result = await api.compactStorage();
    slice.set({ storage: unwrap(result) });
    toast(`storage optimized — reclaimed ${bytes((result.before || 0) - (result.after || 0))}`, { kind: "success" });
    return result;
  });

  const importLegacy = () => run("legacy migration", async () => {
    // Read now: the open dialog may have received a newer snapshot.
    const legacy = slice.get("storage")?.legacy || {};
    const ok = await choose({
      title: "Import legacy library?",
      message: `This merges ${(legacy.sources || ["the legacy library"]).join(" and ")} into SQLite. The source file is kept unchanged.`,
      choices: [{ value: true, label: "Merge library", primary: true }],
      cancelValue: false,
    });
    if (!ok) return null;
    const result = await api.migrateLegacy();
    slice.set({ storage: unwrap(result) });
    await onLibraryChanged();
    toast(`imported ${result.imported || 0} prompts`, { kind: "success" });
    return result;
  });

  const exportJson = () => run("export", async () => {
    downloadJson(await api.exportFile());
    toast("JSON backup downloaded", { kind: "success" });
  });

  const importJson = (file) => {
    if (!file) return Promise.resolve(null);
    return run("import", async () => {
      const mode = await choose({
        title: "Import JSON backup",
        message: `Choose how to import ${file.name}. Merge keeps current prompts; replace removes them.`,
        cancelValue: null,
        choices: [
          { value: "merge", label: "Merge", primary: true },
          { value: "replace", label: "Replace", danger: true },
        ],
      });
      if (!mode) return null;
      const result = await api.importFile(file, mode);
      await reload();
      await onLibraryChanged();
      toast("JSON backup imported", { kind: "success" });
      return result;
    });
  };

  return { reload, optimize, importLegacy, exportJson, importJson };
}
