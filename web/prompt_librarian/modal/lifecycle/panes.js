/* Each optional pane imports independently; a failure cannot block its sibling. */
import { clear, h } from "../../shared/dom.js";
import { warnOnce } from "../../shared/singleton.js";
import { ctx } from "../context.js";
import { inst } from "../state.js";

const PANES = [
  { key: "list", element: "rail", load: () => import("../../browse/index.js"), mount: "mountList",
    message: "the browser rail is unavailable" },
  { key: "inspector", element: "inspect", load: () => import("../../inspector/index.js"), mount: "mountInspector",
    message: "the prompt inspector is not available yet" },
];

/** @param {() => boolean} isActive opening session guard, checked after imports */
export async function mountPanes(isActive = () => inst().open) {
  const it = inst();
  await Promise.all(PANES.map(async (pane) => {
    if (!isActive() || it.mounted[pane.key]) return;
    try {
      // A reopen can reuse a module import still pending from the previous session.
      const pending = it.paneLoads[pane.key] ||= pane.load();
      let mod;
      try { mod = await pending; }
      finally { if (it.paneLoads[pane.key] === pending) delete it.paneLoads[pane.key]; }
      if (!isActive() || it.mounted[pane.key]) return;
      if (typeof mod[pane.mount] !== "function") throw new Error(`${pane.mount} missing`);
      mod[pane.mount](it.els[pane.element], ctx());
      it.mounted[pane.key] = true;
    } catch (err) {
      if (!isActive()) return;
      warnOnce(`${pane.key}-missing`, `${pane.key} pane failed to mount`, err);
      const el = it.els[pane.element];
      clear(el);
      el.appendChild(h("div", { className: "pl-list-empty" }, pane.message));
    }
  }));
}
