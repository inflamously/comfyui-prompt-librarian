/* The rail's sort tabs. A click is an intent, so it applies without debounce. */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";

const NDASH = String.fromCharCode(0x2013); // "–", as in "a–z"

const SORTS = [
  { key: "relevance", label: "relevance" },
  { key: "recent", label: "recent" },
  { key: "most_used", label: "most used" },
  { key: "az", label: "a" + NDASH + "z" },
];

/** deps: slice (browse), setQuery(patch). */
export class SortTabs extends Component {
  render() {
    const { slice, setQuery } = this.deps;
    const tabs = SORTS.map((sort) => h("button", {
      className: "pl-tab",
      type: "button",
      role: "tab",
      dataset: { sort: sort.key },
      onclick: () => setQuery({ sort: sort.key }),
    }, sort.label));
    const paint = () => {
      const current = slice.get("query").sort;
      for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.sort === current));
    };
    this.watch(slice, "query", paint);
    paint();
    return h("div", { className: "pl-tabs", role: "tablist", "aria-label": "Sort" }, tabs);
  }
}
