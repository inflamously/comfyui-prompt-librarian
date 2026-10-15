/* The two storage controls on the modal's frame: the header's "storage" link
 * and the footer's "storage can be optimized" hint. Both hide when the backend
 * has no storage capability; the hint shows only when compaction would help.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { useStyles } from "../../shared/styles.js";

/** deps: slice (storage), caps() -> capability flags, onOpen(). */
export class StorageButton extends Component {
  render() {
    this.watch(this.deps.slice, "*", () => this.paint());
    const el = h("button", {
      className: "pl-link pl-storage-open", type: "button",
      title: "Storage, migration, import and export",
      onclick: () => this.deps.onOpen(),
    }, "storage");
    this.button = el;
    this.paint();
    return el;
  }

  /** Repaint, e.g. after the capabilities changed. */
  paint() {
    this.button.hidden = this.deps.caps().storage === false;
  }
}

/** deps: slice (storage), caps() -> capability flags, onOptimize(). */
export class StorageHint extends Component {
  render() {
    useStyles(new URL("./storage.css", import.meta.url));
    this.watch(this.deps.slice, "*", () => this.paint());
    this.optimize = h("button", { className: "pl-link", type: "button", onclick: () => this.deps.onOptimize() }, "Optimize");
    this.hint = h("div", { className: "pl-storage-hint", hidden: true }, h("span", null, "storage can be optimized"), this.optimize);
    this.paint();
    return this.hint;
  }

  /** Repaint, e.g. after the capabilities changed. */
  paint() {
    const { storage, busy } = this.deps.slice.get();
    this.hint.hidden = this.deps.caps().storage === false || !storage?.should_compact;
    this.optimize.disabled = !!busy;
  }
}
