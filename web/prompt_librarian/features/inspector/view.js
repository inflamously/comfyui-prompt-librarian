/* The inspector's DOM. Every handler comes in through `on`; prompt bodies and
 * tags are rendered as text, never HTML. The root is `display: contents`: the
 * .pl-inspect column lays these parts out as its own flex items.
 */

import { h } from "../../shared/dom.js";
import { MIDDOT, MUL } from "./glyphs.js";

/**
 * Build the editor. `on` holds the handlers: newPrompt, restoreDraft,
 * discardDraft, input(value), diff, versions, starClick(e), starKey(e), save(asNew), remove.
 * @returns {{root: HTMLElement, els: object}}
 */
export function buildView(on) {
  // Labels are derived readouts, not editable record names.
  const labelEl = h("div", {
    className: "pl-label",
    title: "Derived from the prompt text — search finds prompts, names do not",
  });

  const newBtn = h(
    "button",
    {
      className: "pl-btn pl-btn-m pl-new",
      type: "button",
      title: "Start a new prompt (clears the editor)",
      onclick: () => on.newPrompt(),
    },
    "New prompt"
  );

  const tagsRow = h("div", { className: "pl-tags" });

  const draftText = h("span", { className: "pl-edited" }, "unsaved draft found");
  const draftBar = h(
    "div",
    { className: "pl-ta-foot", hidden: true },
    draftText,
    h("button", { className: "pl-link", type: "button", onclick: () => on.restoreDraft() }, "restore draft"),
    h("span", { className: "pl-sep" }, MIDDOT),
    h("button", { className: "pl-link", type: "button", onclick: () => on.discardDraft() }, "discard")
  );

  const charsEl = h("b", null, "0");
  const tokensEl = h("b", null, "~0");
  const editedEl = h("span", { className: "pl-edited", hidden: true }, "edited");
  const countsEl = h(
    "span",
    { className: "pl-counts" },
    h("span", null, charsEl, " chars"),
    h("span", { className: "pl-sep" }, MIDDOT),
    // Display ~ because estimateTokens is a heuristic.
    h("span", null, tokensEl, " tokens"),
    editedEl
  );

  const textLabel = h("span", { className: "pl-lbl" }, "// PROMPT TEXT");
  const textHead = h(
    "div",
    { className: "pl-ta-foot" },
    textLabel,
    h("span", { className: "pl-spacer" }),
    countsEl
  );

  const ta = h("textarea", {
    className: "pl-ta",
    spellcheck: "false",
    "aria-label": "Prompt text",
    placeholder: "prompt text…",
    oninput: () => on.input(ta.value),
  });
  const taWrap = h("div", { className: "pl-ta-wrap" }, ta);

  const diffLink = h("button", { className: "pl-link", type: "button", onclick: () => on.diff() }, "diff vs saved");
  const versLink = h("button", { className: "pl-link", type: "button", onclick: () => on.versions() }, "versions");

  const taFoot = h(
    "div",
    { className: "pl-ta-foot" },
    diffLink,
    h("span", { className: "pl-spacer" }),
    versLink
  );

  // The dupes panel (features/dupes) mounts here. `display: contents` keeps a
  // hidden panel from leaving an empty flex item, and so an extra gap, behind.
  const dupesSlot = h("div", { className: "pl-dupes-slot", style: { display: "contents" } });

  const usedV = h("div", { className: "pl-stat-v" }, "0" + MUL);
  const lastV = h("div", { className: "pl-stat-v" }, "—");
  const versV = h("button", { className: "pl-stat-v pl-link", type: "button", onclick: () => on.versions() }, "0");
  const starsEl = h("span", {
    className: "pl-stars",
    role: "group",
    tabIndex: 0,
    "aria-label": "Rating",
    onclick: (e) => on.starClick(e),
    onkeydown: (e) => on.starKey(e),
  });
  const statsEl = h(
    "div",
    { className: "pl-stats" },
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "USED"), usedV),
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "LAST RUN"), lastV),
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "VERSIONS"), versV),
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "RATING"), h("div", { className: "pl-stat-v" }, starsEl))
  );

  // The bound node already receives edits. Save creates; Update overwrites.
  const saveNewBtn = h("button", { className: "pl-btn pl-btn-primary", type: "button", title: "Save as new (Ctrl+S)", onclick: () => on.save(true) }, "Save as new");
  const saveBtn = h("button", { className: "pl-btn", type: "button", title: "Overwrite the selected prompt", onclick: () => on.save(false) }, "Update");
  const delBtn = h("button", { className: "pl-btn pl-btn-danger", type: "button", onclick: () => on.remove() }, "Delete");
  const actionsEl = h(
    "div",
    { className: "pl-actions" },
    saveNewBtn,
    saveBtn,
    h("span", { className: "pl-spacer" }),
    delBtn
  );

  const root = h("div", { className: "pl-inspector", style: { display: "contents" } },
    h("div", { className: "pl-lbl" }, "// SELECTED"),
    h("div", { className: "pl-idrow" }, labelEl, newBtn),
    tagsRow, draftBar, textHead, taWrap, taFoot, dupesSlot, statsEl, actionsEl);

  const els = {
    labelEl, newBtn, tagsRow,
    draftText, draftBar,
    charsEl, tokensEl, editedEl,
    textLabel, textHead, ta, taWrap,
    diffLink, versLink,
    dupesSlot,
    usedV, lastV, versV, starsEl,
    saveBtn, saveNewBtn, delBtn,
  };
  return { root, els };
}
