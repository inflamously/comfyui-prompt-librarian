import { h } from "../../shared/dom.js";
import { inst } from "../state.js";

export function createPaneTabs() {
  return h(
    "div",
    {
      className: "pl-seg",
      role: "tablist",
      "aria-label": "Pane",
      style: { flex: "1 1 100%", order: "6" },
    },
    createTab("browse", "Browse"),
    createTab("edit", "Edit")
  );
}

function createTab(pane, label) {
  return h(
    "button",
    {
      className: "pl-seg-tab",
      type: "button",
      role: "tab",
      "aria-selected": String(pane === "browse"),
      onclick: () => setPane(pane),
    },
    label
  );
}

export function setPane(pane) {
  const instance = inst();
  if (!instance.built) return;

  instance.els.body.dataset.pane = pane;
  const tabs = instance.els.seg.querySelectorAll('[role="tab"]');
  if (tabs[0]) tabs[0].setAttribute("aria-selected", String(pane === "browse"));
  if (tabs[1]) tabs[1].setAttribute("aria-selected", String(pane === "edit"));
}
