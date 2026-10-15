/* The progress card shown while words render: a count, the word rendering now,
 * a bar, and Stop (Close once the run is over). It sits on the page, outside
 * the Librarian modal, because a run continues with the modal closed.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { useStyles } from "../../shared/styles.js";

/** deps: onStop(). update(state) repaints it from the runner's state. */
export class ProgressPanel extends Component {
  render() {
    useStyles(new URL("./progress-panel.css", import.meta.url));
    this.finished = false;
    this.title = h("div", { className: "pl-wordgen-title" });
    this.line = h("div", { className: "pl-wordgen-line" });
    this.fill = h("div");
    this.button = h("button", { type: "button" });
    this.listen(this.button, "click", () => (this.finished ? this.destroy() : this.deps.onStop()));
    return h("div", { className: "pl-wordgen", role: "status" },
      this.title, this.line,
      h("div", { className: "pl-wordgen-bar" }, this.fill),
      h("div", { className: "pl-wordgen-actions" }, this.button));
  }

  /** Repaint from `{total, done, failed, current, running, stopped, error}`. */
  update(state) {
    if (!this.el) return;
    const settled = state.done + state.failed;
    this.finished = !state.running;
    this.fill.style.width = `${state.total ? (100 * settled) / state.total : 100}%`;
    if (this.finished) {
      this.title.textContent = `Word pictures: ${state.done} made`;
      this.line.textContent = state.error || (state.failed ? `${state.failed} words gave no image` : "all done");
      this.button.textContent = "Close";
      this.button.disabled = false;
      return;
    }
    this.title.textContent = `Word pictures: ${settled} / ${state.total}`;
    this.line.textContent = state.stopped ? "stopping after this word…" : `rendering “${state.current}”`;
    this.button.textContent = "Stop";
    this.button.disabled = state.stopped;
  }
}
