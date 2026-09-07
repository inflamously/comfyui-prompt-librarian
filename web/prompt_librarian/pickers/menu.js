import { NO_AUTOFILL, clear, cls, h } from "../shared/dom.js";
import { isFn } from "./common.js";

/** items are {label, meta, selected, disabled, className, run}.
 * Returning false from run keeps the popover open.
 *
 * @returns {{input: HTMLInputElement, list: HTMLElement, setItems: Function,
 *            query: () => string, onKey: (e: KeyboardEvent) => void}}
 */
export function buildMenu(el, opts = {}) {
  const { placeholder, ariaLabel, onQuery, autoFocus = true } = opts;

  const input = h("input", {
    className: "pl-search-in",
    type: "text",
    placeholder: placeholder || "filter…",
    spellcheck: "false",
    ...NO_AUTOFILL,
    "aria-label": ariaLabel || placeholder || "filter",
    oninput: () => {
      if (isFn(onQuery)) onQuery(String(input.value || ""));
    },
  });
  // `.pl-search` carries the rail's own 14px margins; inside a popover they
  // would push the field off the padding box.
  const search = h("div", { className: "pl-search", style: { margin: "0 0 6px" } }, input);

  const list = h("div", { role: "listbox", "aria-label": ariaLabel || "options" });
  el.appendChild(search);
  el.appendChild(list);

  let rows = [];
  let active = -1;

  function paintActive() {
    for (let i = 0; i < rows.length; i++) cls(rows[i], "is-active", i === active);
    const row = rows[active];
    if (row && isFn(row.scrollIntoView)) {
      try {
        row.scrollIntoView({ block: "nearest" });
      } catch (_) {
        /* older engines: the option is simply not scrolled to */
      }
    }
  }

  function setActive(i) {
    if (!rows.length) {
      active = -1;
      return;
    }
    active = Math.max(0, Math.min(i, rows.length - 1));
    paintActive();
  }

  function setItems(items) {
    clear(list);
    rows = [];
    const list_ = Array.isArray(items) ? items : [];
    if (!list_.length) {
      list.appendChild(
        h(
          "div",
          { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } },
          opts.emptyLabel || "nothing to pick"
        )
      );
    }
    for (const item of list_) {
      if (!item) continue;
      if (item.disabled) {
        list.appendChild(
          h(
            "div",
            { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } },
            String(item.label == null ? "" : item.label)
          )
        );
        continue;
      }
      const btn = h(
        "button",
        {
          className: "pl-opt" + (item.className ? " " + item.className : ""),
          type: "button",
          role: "option",
          "aria-selected": item.selected ? "true" : "false",
          // Pass the activating event so consumers can inspect modifiers.
          onclick: (ev) => {
            if (isFn(item.run)) item.run(ev);
          },
        },
        item.mark != null
          ? h("span", { "aria-hidden": "true", style: { width: "1em", flex: "0 0 auto" } }, item.mark)
          : null,
        // textContent only — names, tags and bodies are user data.
        h("span", { style: { flex: "1 1 auto", minWidth: "0" } }, String(item.label == null ? "" : item.label)),
        item.meta != null
          ? h("span", { style: { flex: "0 0 auto", opacity: "0.6" } }, String(item.meta))
          : null
      );
      btn.__plItem = item;
      rows.push(btn);
      list.appendChild(btn);
    }
    active = rows.length ? 0 : -1;
    paintActive();
  }

  /** ↑/↓/Home/End/Enter. Wired by the caller through bindKeys(). */
  function onKey(e) {
    if (!e || !rows.length) return;
    const key = e.key;
    if (key === "ArrowDown") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(active + 1);
    } else if (key === "ArrowUp") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(active - 1);
    } else if (key === "Home") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(0);
    } else if (key === "End") {
      if (isFn(e.preventDefault)) e.preventDefault();
      setActive(rows.length - 1);
    } else if (key === "Enter") {
      const row = rows[active];
      if (!row) return;
      if (isFn(e.preventDefault)) e.preventDefault();
      // Pass the key event directly: a synthetic click loses Shift state.
      if (row.__plItem && isFn(row.__plItem.run)) row.__plItem.run(e);
      else row.click();
    }
  }

  if (autoFocus) {
    // The layer push focuses the first focusable, which is this input; the
    // timeout covers the standalone (no-ctx) path.
    setTimeout(() => {
      try {
        input.focus();
      } catch (_) {
      }
    }, 0);
  }

  return {
    input,
    list,
    setItems,
    setActive,
    onKey,
    query: () => String(input.value || ""),
    rows: () => rows.slice(),
  };
}

export function matches(label, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return String(label == null ? "" : label).toLowerCase().indexOf(q) >= 0;
}

/** Normalize `[{name,count}]` / `["name"]` taxonomy shapes to `[{name,count}]`. */
export function taxonomyRows(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === "object") {
      const name = item.name != null ? String(item.name) : "";
      if (!name) continue;
      out.push({ name, count: Number(item.count) || 0 });
    } else {
      const name = String(item);
      if (name) out.push({ name, count: 0 });
    }
  }
  return out;
}
