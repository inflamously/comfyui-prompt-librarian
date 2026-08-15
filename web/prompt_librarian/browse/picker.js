/* ==========================================================================
   Prompt Librarian — the rail's one-of picker
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Uses pickers/ when it exposes a generic `openPicker`, and otherwise falls
   back to a self-contained popover, so the rail is fully usable even if that
   feature failed to load.
   ========================================================================== */

import { NO_AUTOFILL, h } from "../shared/dom.js";

/**
 * @param {object} ctx modal ctx
 * @param {string} title
 * @param {string[]} options
 * @param {{allowNew?: boolean}} [opts]
 * @returns {Promise<string|null>}
 */
export async function pickOne(ctx, title, options, opts = {}) {
  try {
    const mod = await import("../pickers/index.js");
    if (typeof mod.openPicker === "function") {
      return await mod.openPicker({ title, options, ...opts, ctx });
    }
  } catch (_) {
    /* unavailable — fall through to the built-in */
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      ctx.popLayer(handle);
      resolve(val);
    };
    const pop = h("div", { className: "pl-popover", role: "listbox", "aria-label": title });
    if (opts.allowNew) {
      const field = h("input", {
        className: "pl-name",
        type: "text",
        spellcheck: "false",
        ...NO_AUTOFILL,
        placeholder: "new " + title.toLowerCase(),
        "aria-label": title,
      });
      ctx.onKey(field, "keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const v = String(field.value || "").trim();
          if (v) finish(v);
        }
      });
      pop.appendChild(field);
    }
    if (!options.length) pop.appendChild(h("div", { className: "pl-opt" }, "(none yet)"));
    for (const opt of options) {
      pop.appendChild(
        h("button", { className: "pl-opt", type: "button", role: "option", onclick: () => finish(opt) }, opt)
      );
    }
    pop.style.left = "50%";
    pop.style.top = "20%";
    const handle = ctx.pushLayer({ el: pop, closeOnOutside: true, onClose: () => finish(null) });
    if (!handle) resolve(null);
  });
}
