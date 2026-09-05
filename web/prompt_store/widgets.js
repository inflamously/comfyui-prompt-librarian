import { EMPTY_LABEL } from "./labels.js";

/** Support legacy option arrays and Vue options.values; reassign for reactivity.
 */
export function setComboValues(widget, values) {
    if (!widget) return;
    const list = values && values.length ? values : [EMPTY_LABEL];
    if (Array.isArray(widget.options)) {
        widget.options.splice(0, Infinity, ...list);
    } else {
        if (!widget.options) widget.options = {};
        // Direct assignment (not splice) to trigger Vue reactivity if present
        widget.options.values = list.slice();
    }
    if (!list.includes(widget.value)) widget.value = list[0];
}
