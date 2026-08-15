/* ==========================================================================
   Prompt Library (the OLD node) — LiteGraph widget helpers
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.
   ========================================================================== */

import { EMPTY_LABEL } from "./labels.js";

/**
 * Update a combo widget's option list. Handles both LiteGraph (options IS the
 * array) and the newer ComfyUI Vue frontend (options.values, needs reassignment
 * not splice for reactivity).
 */
export function setComboValues(widget, values) {
    if (!widget) return;
    const list = values && values.length ? values : [EMPTY_LABEL];
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
