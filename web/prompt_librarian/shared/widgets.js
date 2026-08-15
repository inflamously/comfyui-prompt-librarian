/* ==========================================================================
   Prompt Librarian — LiteGraph widget helpers
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.
   ========================================================================== */

/**
 * Update a combo widget's option list. Handles both LiteGraph (options IS the
 * array) and the newer ComfyUI Vue frontend (options.values, needs
 * reassignment not splice for reactivity).
 *
 * Copied in behaviour from web/prompt_store/widgets.js on purpose — it is NOT
 * imported from there. The two node domains must stay independently deletable:
 * a user removing the old node's directory must not break the Librarian, and
 * vice versa. The only difference is that the empty-list sentinel is a
 * parameter here instead of a module constant.
 *
 * @param {object} widget
 * @param {string[]} values
 * @param {string} [emptyLabel="<empty>"]
 */
export function setComboValues(widget, values, emptyLabel = "<empty>") {
  if (!widget) return;
  const list = values && values.length ? values : [emptyLabel];
  if (Array.isArray(widget.options)) {
    // LiteGraph legacy: options is the values array directly
    widget.options.splice(0, Infinity, ...list);
  } else {
    if (!widget.options) widget.options = {};
    // Direct assignment (not splice) to trigger Vue reactivity if present
    widget.options.values = list.slice();
  }
  if (!list.includes(widget.value)) widget.value = list[0];
}
