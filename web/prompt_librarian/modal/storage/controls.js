import { h } from "../../shared/dom.js";
import { inst, subscribe } from "../state.js";

export function createStorageButton() {
  return h(
    "button",
    {
      className: "pl-link pl-storage-open",
      type: "button",
      onclick: () => runAction("openStorage"),
    },
    "storage"
  );
}

export function createStorageHint() {
  return h(
    "div",
    { className: "pl-storage-hint", hidden: true },
    h("span", null, "storage can be optimized"),
    h(
      "button",
      {
        className: "pl-link",
        type: "button",
        onclick: () => runAction("optimizeStorage"),
      },
      "Optimize"
    )
  );
}

export function wireStorageControls() {
  const instance = inst();
  // This subscription belongs to the retained shell, which is wired once.
  subscribe("storage", paintStorage);
  subscribe("caps", paintStorage);
  subscribe("storageBusy", paintStorage);
  paintStorage(instance.state);
}

function paintStorage(state) {
  const { storageBtn, storageHint } = inst().els;
  const storage = state.storage || {};
  const available = !state.caps || state.caps.storage !== false;

  if (storageBtn) {
    storageBtn.hidden = !available;
    storageBtn.textContent = "storage";
    storageBtn.title = "Storage, migration, import and export";
  }
  if (storageHint) {
    storageHint.hidden = !available || !storage.should_compact;
    storageHint.querySelector("button").disabled = !!state.storageBusy;
  }
}

async function runAction(name) {
  const it = inst();
  const session = it.session;
  const actions = await import("./actions.js");
  if (it.open && it.session === session) return actions[name]();
}
