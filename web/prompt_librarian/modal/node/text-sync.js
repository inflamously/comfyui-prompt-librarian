/* Keeps a PromptLibrarian node's `text` widget in sync with the librarian UI.
 *
 * This is the only module that touches a widget's internals. It has three jobs:
 *
 *   READ   readNodeText(node)          -> {body, id} currently on the node
 *   WRITE  writeNodeText(node, values) -> put a body and/or prompt_id onto the node
 *   WATCH  watchNodeText(node, fn)     -> call fn whenever the body changes on
 *                                         the canvas (typing, paste, other code)
 *          pollNodeText(node)          -> manual check, driven by the modal heartbeat
 *
 * Why watching needs three mechanisms: ComfyUI frontends store the text
 * differently (accessors over inputEl, DOM wrappers, Vue-backed values that
 * recreate their element), and we cannot tell which one we are on. So each
 * mechanism is installed independently and any of them may be unavailable:
 *
 *   1. element events    `input`/`change` listeners on the backing <textarea>
 *   2. value intercept   wrap `widget.value` so programmatic sets are seen too
 *   3. polling           pollNodeText(), which also re-installs 1 and 2 when
 *                        the frontend re-renders the widget
 *
 * All three report through notify(). `lastSeen` (the last body written or
 * observed) drops echoes, so our own writes and repeated observations of the
 * same value never reach the subscribers.
 */

import { warnOnce } from "../../shared/singleton.js";
import { dispatchInput, readNodeText, str, widgetElement } from "./text-access.js";
import { isWatched, pollNodeText, watchNodeText, watchStateOf } from "./text-watch.js";
import { ID_WIDGET, TEXT_WIDGET, findWidget } from "./widgets.js";

export { ID_WIDGET, TEXT_WIDGET, findWidget, isWatched, pollNodeText, readNodeText, watchNodeText, widgetElement };

/** The single write path onto the node; the live link and explicit loads both
 * use it. Assign values before invoking frontend callbacks, which may reset
 * widget state or throw.
 *
 * @param {object} node
 * @param {{body?: string, id?: string}} values `id` is only written when the
 *   property is present — passing {body} alone leaves the link untouched.
 * @param {{canvas?: object}} [opts]
 * @returns {{ok: boolean, reason?: string}}
 */
export function writeNodeText(node, values, opts = {}) {
  if (!node) return { ok: false, reason: "stale_target" };
  const textW = findWidget(node, TEXT_WIDGET);
  if (!textW) return { ok: false, reason: "no_text_widget" };
  const idW = findWidget(node, ID_WIDGET);

  const hasBody = values && Object.prototype.hasOwnProperty.call(values, "body");
  const hasId = values && Object.prototype.hasOwnProperty.call(values, "id");
  const body = hasBody ? str(values.body) : null;
  const id = hasId ? str(values.id) : null;

  // Suppress our own watchers for the duration of the write. `lastSeen` is
  // the real echo guard; this just avoids pointless work in mechanisms 1 and 2.
  const st = watchStateOf(node);
  const prevWriting = st ? st.writing : false;
  if (st) {
    st.writing = true;
    if (hasBody) st.lastSeen = body;
  }

  try {
    const written = [];

    if (hasBody) {
      try {
        textW.value = body;
      } catch (err) {
        warnOnce("write-text-value", "could not set the text widget value", err);
      }
      // The widget value and its element can disagree — assigning one does not
      // always propagate to the other. Set both, then announce it.
      const el = widgetElement(textW);
      if (el && el.value !== body) {
        try {
          el.value = body;
          dispatchInput(el);
        } catch (err) {
          warnOnce("write-text-el", "could not set the text widget element", err);
        }
      }
      written.push([textW, body]);
    }

    if (hasId && idW) {
      try {
        idW.value = id;
      } catch (err) {
        warnOnce("write-id-value", "could not set the prompt_id widget", err);
      }
      written.push([idW, id]);
    }

    const canvas = opts.canvas || null;
    for (const [w, val] of written) {
      if (!w || typeof w.callback !== "function") continue;
      try {
        w.callback(val, canvas, node);
      } catch (err) {
        warnOnce("widget-callback", "a widget callback threw while writing the node", err);
      }
    }

    try {
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    } catch (_) {
    }
  } finally {
    if (st) st.writing = prevWriting;
  }

  return { ok: true };
}
