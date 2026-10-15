/* The widget gallery: every shared/ui widget built from the pack's own modules,
 * on a bare .pl-root with only the shared sheets linked. No modal, no feature
 * and no backend are involved, so what shows here is the widget alone.
 */

const root = document.getElementById("wg-root");
const base = window.__DEV__.mount + "/prompt_librarian/shared/";
const [
  { h },
  { ensureStyles },
  { installKeyGuards, onKey },
  { STAR_EMPTY, STAR_FULL },
  { LayerStack },
  { Toaster },
  { choose, confirm },
  { openPopover },
  { buildMenu, matches },
  { VirtualList },
] = await Promise.all([
  "dom.js", "styles.js", "keys.js", "text.js",
  "ui/layer-stack.js", "ui/toast.js", "ui/dialog.js", "ui/popover.js", "ui/menu.js", "ui/virtual-list.js",
].map((rel) => import(base + rel)));

ensureStyles();
installKeyGuards(root);

const layersHost = h("div", { className: "pl-layers" });
const toastsHost = h("div", { className: "pl-toasts" });
const layers = new LayerStack(layersHost, { root });
// In the modal, Escape popping the top layer is the shell's job (modal/input/shortcuts.js).
onKey(root, "keydown", (e) => {
  if ((e.key === "Escape" || e.key === "Esc") && layers.size) {
    e.preventDefault();
    layers.pop();
  }
});
const toaster = new Toaster(toastsHost);
const out = h("div", { className: "wg-out", "aria-live": "polite" }, "results of the overlay buttons land here");
const report = (text) => { out.textContent = text; };

const card = (title, ...kids) => h("section", { className: "wg-card" }, h("h2", null, title), ...kids);
const row = (...kids) => h("div", { className: "wg-row" }, ...kids);
const button = (label, className = "", extra = {}) =>
  h("button", { className: `pl-btn ${className}`.trim(), type: "button", ...extra }, label);

function buttons() {
  return card("button.css",
    row(button("default"), button("primary", "pl-btn-primary"), button("accent", "pl-btn-accent"),
      button("danger", "pl-btn-danger"), button("ghost", "pl-btn-ghost")),
    row(button("small", "pl-btn-sm"), button("small primary", "pl-btn-sm pl-btn-primary"),
      button("disabled", "", { disabled: true }), button("aria-disabled", "pl-btn-primary", { "aria-disabled": "true" })));
}

function links() {
  const toggle = h("button", { className: "pl-link is-on", type: "button", "aria-pressed": "true" }, "linked");
  toggle.onclick = () => {
    const on = !toggle.classList.toggle("is-on");
    toggle.setAttribute("aria-pressed", String(!on));
    toggle.textContent = on ? "unlinked" : "linked";
  };
  return card("link.css",
    row(toggle, h("button", { className: "pl-link", type: "button" }, "show versions"),
      h("button", { className: "pl-link", type: "button", disabled: true }, "disabled")));
}

function chips() {
  const chip = (label, on = false) => {
    const el = h("button", { className: `pl-chip${on ? " is-on" : ""}`, type: "button" }, h("span", null, label));
    el.onclick = () => el.classList.toggle("is-on");
    return el;
  };
  const removable = h("span", { className: "pl-chip" }, h("span", null, "portrait"),
    h("button", { className: "pl-chip-x", type: "button", "aria-label": "remove portrait", onclick: () => removable.remove() }, "×"));
  return card("chip.css",
    h("div", { className: "pl-chips" }, chip("landscape"), chip("noir", true), chip("dupes", false), removable,
      h("button", { className: "pl-chip pl-chip-add", type: "button" }, "+ tag")));
}

function tabs() {
  const names = ["relevance", "recent", "rating"];
  const list = h("div", { className: "pl-tabs", role: "tablist", "aria-label": "Sort" });
  const paint = (picked) => {
    for (const tab of list.children) tab.setAttribute("aria-selected", String(tab.textContent === picked));
  };
  for (const name of names) list.append(h("button", { type: "button", role: "tab", onclick: () => paint(name) }, name));
  paint(names[0]);
  return card("tabs.css", list);
}

function search() {
  const input = h("input", { className: "pl-search-in", type: "search", placeholder: "search prompts and tags", "aria-label": "search" });
  return card("search.css", h("div", { className: "pl-search" }, input));
}

function stars() {
  const el = h("div", { className: "pl-stars", role: "slider", "aria-label": "rating", tabIndex: 0 });
  const paint = (n) => {
    el.replaceChildren(...[1, 2, 3, 4, 5].map((i) => h("span", { onclick: () => paint(i === n ? 0 : i) }, i <= n ? STAR_FULL : STAR_EMPTY)));
    el.setAttribute("aria-valuenow", String(n));
  };
  paint(3);
  return card("stars.css", el,
    h("div", { className: "pl-stars", "aria-disabled": "true" }, `${STAR_FULL.repeat(2)}${STAR_EMPTY.repeat(3)}`));
}

function textArea() {
  const ta = h("textarea", { className: "pl-ta", rows: 5, "aria-label": "prompt" });
  ta.value = "a lighthouse keeper's cat on the gallery rail, storm light, 35mm";
  return card("text-area.css",
    h("div", { className: "pl-lbl" }, "prompt"),
    h("div", { className: "pl-ta-wrap" }, ta),
    h("div", { className: "pl-ta-foot" }, h("span", null, "64 chars"), h("span", { className: "pl-sep" }, "·"),
      h("button", { className: "pl-link", type: "button" }, "diff vs saved")));
}

function list() {
  const viewport = h("div", { className: "pl-list wg-list", tabIndex: 0, role: "listbox", "aria-label": "rows" });
  const spacer = h("div", { className: "pl-list-spacer" });
  const win = h("div", { className: "pl-list-win" });
  viewport.append(spacer, win);
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    name: `synthetic prompt ${i + 1}`,
    body: `fixture body ${i + 1}: soft window light, wet street, long exposure`,
    meta: `${(i * 7) % 40} uses · ${(i % 5) + 1}★`,
    dupe: i % 9 === 0,
  }));
  let selected = 0;
  const vl = new VirtualList({
    viewport, spacer, win,
    // Like the rail's rows: absolute, so the list can place and recycle them.
    createRow: () => h("div", { className: "pl-row", role: "option", style: { position: "absolute", left: "0", right: "0", top: "0" } },
      h("span", { className: "pl-row-bar" }), h("div", { className: "pl-row-name" }),
      h("div", { className: "pl-badge-dupe" }, "dupe"), h("div", { className: "pl-row-body" }), h("div", { className: "pl-row-meta" })),
    updateRow: (el, item, i) => {
      el.setAttribute("aria-selected", String(i === selected));
      el.querySelector(".pl-row-name").textContent = item.name;
      el.querySelector(".pl-badge-dupe").hidden = !item.dupe;
      el.querySelector(".pl-row-body").textContent = item.body;
      el.querySelector(".pl-row-meta").textContent = item.meta;
    },
    onActivate: (i) => { selected = i; vl.repaint(); },
    source: { get: (i) => rows[i], peek: (i) => rows[i] },
  });
  queueMicrotask(() => vl.setTotal(rows.length));
  const skeleton = h("div", { className: "pl-row pl-row-skel" },
    h("div", { className: "pl-row-name" }), h("div", { className: "pl-row-body" }), h("div", { className: "pl-row-meta" }));
  return card("list.css + virtual-list.js (1000 rows)", viewport,
    h("div", { className: "pl-list", style: { height: "auto" } }, skeleton),
    h("div", { className: "pl-list-empty" }, "no prompts match"));
}

function overlays() {
  const pick = button("choose()", "pl-btn-sm", {
    onclick: async () => report(`choose → ${await choose(layers, {
      title: "Keep which version?", message: "Two edits disagree.",
      choices: [{ value: "mine", label: "keep mine", primary: true }, { value: "theirs", label: "take theirs" }],
    })}`),
  });
  const ask = button("confirm() danger", "pl-btn-sm", {
    onclick: async () => report(`confirm → ${await confirm(layers, {
      title: "Delete prompt?", message: "This cannot be undone.", confirmLabel: "Delete", danger: true,
    })}`),
  });
  const menu = button("popover + menu", "pl-btn-sm");
  menu.onclick = () => openMenu(menu);
  const kinds = ["info", "success", "warn", "error"].map((kind) =>
    button(`toast ${kind}`, "pl-btn-sm", { onclick: () => toaster.show(`${kind} toast`, { kind }) }));
  return card("dialog / popover / menu / toast / layer-stack", row(pick, ask, menu), row(...kinds), out);
}

function openMenu(anchor) {
  const words = ["amber", "brutalist", "cinematic", "dusk", "ektachrome", "fog", "grain", "halation", "infrared"];
  let menu = null;
  const pop = openPopover({
    anchor, layers, ariaLabel: "Words",
    render: (el, handle) => {
      menu = buildMenu(el, {
        placeholder: "filter…", ariaLabel: "Words",
        onQuery: () => { paint(); handle.reposition(); },
      });
      const paint = () => menu.setItems(words.filter((w) => matches(w, menu.query()))
        .map((w) => ({ label: w, run: () => { report(`menu → ${w}`); handle.close(); } })));
      paint();
      return null;
    },
  });
  if (pop?.isOpen() && menu) pop.own(onKey(pop.el, "keydown", (e) => menu.onKey(e)));
}

root.append(
  h("h1", null, "shared/ui widgets"),
  h("p", { className: "wg-intro" }, "Each widget on its own, styled only by the shared sheets."),
  h("div", { className: "wg-grid" }, buttons(), links(), chips(), tabs(), search(), stars(), textArea(), list(), overlays()),
  layersHost, toastsHost,
);
