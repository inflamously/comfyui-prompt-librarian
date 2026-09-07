/** Support legacy option arrays and Vue options.values; reassign for reactivity.
 * Keep this helper local so either node domain can be removed independently.
 *
 * @param {object} widget
 * @param {string[]} values
 * @param {string} [emptyLabel="<empty>"]
 */
export function setComboValues(widget, values, emptyLabel = "<empty>") {
  if (!widget) return;
  const list = values && values.length ? values : [emptyLabel];
  if (Array.isArray(widget.options)) {
    widget.options.splice(0, Infinity, ...list);
  } else {
    if (!widget.options) widget.options = {};
    // Direct assignment (not splice) to trigger Vue reactivity if present
    widget.options.values = list.slice();
  }
  if (!list.includes(widget.value)) widget.value = list[0];
}
