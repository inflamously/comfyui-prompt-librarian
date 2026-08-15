/* ==========================================================================
   Prompt Librarian — mounting the two panes
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   The modal does NOT own the rail (browse/) or the inspector (inspector/).
   Both are imported lazily, inside try/catch, so a missing or broken module
   degrades to a placeholder instead of an empty modal.
   ========================================================================== */

import { clear, h } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { ctx } from "./ctx.js";
import { inst } from "./state.js";

function placeholder(el, text) {
  clear(el);
  el.appendChild(h("div", { className: "pl-list-empty" }, text));
}

export async function mountPanes() {
  const it = inst();

  if (!it.mounted.list) {
    try {
      const mod = await import("../browse/index.js");
      if (typeof mod.mountList !== "function") throw new Error("mountList missing");
      mod.mountList(it.els.rail, ctx());
      it.mounted.list = true;
    } catch (err) {
      warnOnce("list-missing", "web/prompt_librarian/browse/ failed to mount", err);
      placeholder(it.els.rail, "the browser rail is unavailable");
    }
  }

  if (!it.mounted.inspector) {
    try {
      const mod = await import("../inspector/index.js");
      if (typeof mod.mountInspector !== "function") throw new Error("mountInspector missing");
      mod.mountInspector(it.els.inspect, ctx());
      it.mounted.inspector = true;
    } catch (err) {
      warnOnce(
        "inspector-missing",
        "web/prompt_librarian/inspector/ is not available (the editor pane is a placeholder)",
        err && err.message
      );
      placeholder(it.els.inspect, "the prompt inspector is not available yet");
    }
  }
}
