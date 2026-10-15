/* The rail's filter chips: one per tag in the query (× clears it), "+ tag",
 * and the "dupes only" toggle. Every click applies at once; only typed search
 * text is debounced (see browse-pane.js).
 */

import { Component } from "../../shared/component.js";
import { clear, h } from "../../shared/dom.js";

const TIMES = String.fromCharCode(0x00d7); // "×"

/** deps: slice (browse), tags (the tags service), setQuery(patch). */
export class FilterChips extends Component {
  render() {
    this.box = h("div", { className: "pl-chips" });
    this.watch(this.deps.slice, "query", () => this.paint());
    this.paint();
    return this.box;
  }

  paint() {
    const { slice, setQuery } = this.deps;
    const q = slice.get("query");
    clear(this.box);
    for (const tag of q.tags) {
      this.box.append(h(
        "span",
        { className: "pl-chip is-on" },
        h("span", null, tag),
        h("button", {
          className: "pl-chip-x",
          type: "button",
          "aria-label": `Clear tag ${tag}`,
          onclick: () => setQuery({ tags: q.tags.filter((t) => t !== tag) }),
        }, TIMES),
      ));
    }
    this.box.append(
      h("button", { className: "pl-chip pl-chip-add", type: "button", onclick: () => this.pickTags() },
        h("span", null, "+ tag")),
      h("button", {
        className: "pl-chip pl-chip-toggle" + (q.dupesOnly ? " is-on" : ""),
        type: "button",
        "aria-pressed": q.dupesOnly ? "true" : "false",
        onclick: () => setQuery({ dupesOnly: !q.dupesOnly }),
      }, h("span", null, "dupes only")),
    );
  }

  /** Multi-select over the library's tags; each pick or un-pick filters at once. */
  pickTags() {
    const { slice, tags, setQuery } = this.deps;
    const current = () => slice.get("query").tags;
    tags.openPicker({
      // Every pick repaints the chips, so the button is looked up afresh each time.
      anchor: () => this.box.querySelector(".pl-chip-add"),
      placement: "bottom-start",
      selected: current(),
      allowNew: false,
      onPick: (tag) => setQuery({ tags: current().concat([tag]) }),
      onRemove: (tag) => setQuery({ tags: current().filter((t) => t !== tag) }),
    });
  }
}
