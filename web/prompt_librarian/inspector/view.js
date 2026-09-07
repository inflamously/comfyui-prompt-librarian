/* Handlers resolve through pane at event time, after feature wiring.
 * Render prompt bodies and tags as text, never HTML.
 */

import { CAP_TITLE, CARET, MIDDOT, MUL } from "./constants.js";

/**
 * @param {object} pane
 * @returns {{els: object, applyCaps: () => void}}
 */
export function buildView(pane) {
  const { el, D } = pane;
  const h = D.h;

  D.clearEl(el);

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
      onclick: () => pane.newPrompt(),
    },
    "New prompt"
  );

  const tagsRow = h("div", { className: "pl-tags" });

  const draftText = h("span", { className: "pl-edited" }, "unsaved draft found");
  const draftBar = h(
    "div",
    { className: "pl-ta-foot", hidden: true },
    draftText,
    h("button", { className: "pl-link", type: "button", onclick: () => pane.restoreDraft() }, "restore draft"),
    h("span", { className: "pl-sep" }, MIDDOT),
    h("button", { className: "pl-link", type: "button", onclick: () => pane.discardDraft() }, "discard")
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

  // Only activate textarea transparency after the mirror passes its layout check.
  const mirror = h("div", { className: "pl-ta-mirror", "aria-hidden": "true" });
  const ta = h("textarea", {
    className: "pl-ta",
    spellcheck: "false",
    "aria-label": "Prompt text",
    placeholder: "prompt text…",
    oninput: () => { pane.buf.body = ta.value; pane.afterEdit(true); },
  });
  const taWrap = h("div", { className: "pl-ta-wrap" }, mirror, ta);

  const diffLink = h("button", { className: "pl-link", type: "button", onclick: () => pane.openDiffVsSaved() }, "diff vs saved");
  const wildLink = h("button", { className: "pl-link", type: "button", onclick: (e) => pane.openPicker("wildcards", e) }, "wildcards");
  const snipLink = h("button", { className: "pl-link", type: "button", onclick: (e) => pane.openPicker("snippets", e) }, "insert snippet");
  const versLink = h("button", { className: "pl-link", type: "button", onclick: () => pane.openVersions() }, "versions");

  const taFoot = h(
    "div",
    { className: "pl-ta-foot" },
    diffLink,
    h("span", { className: "pl-sep" }, MIDDOT),
    wildLink,
    h("span", { className: "pl-sep" }, MIDDOT),
    snipLink,
    h("span", { className: "pl-spacer" }),
    versLink
  );

  const dupesTitle = h("span", null, "Duplicate check");
  const threshBtn = h(
    "button",
    { className: "pl-thresh", type: "button", "aria-haspopup": "listbox", onclick: () => pane.openThreshold() },
    h("span", null, "threshold 90%"),
    h("span", { "aria-hidden": "true" }, CARET)
  );
  const reviseBtn = h(
    "button",
    {
      className: "pl-btn pl-btn-sm",
      type: "button",
      hidden: true,
      title: "Work through every near match",
      onclick: () => pane.openRevise(),
    },
    "revise"
  );
  const dupesHead = h("div", { className: "pl-dupes-head" }, dupesTitle, reviseBtn, threshBtn);
  const dupesBody = h("div");
  const dupesPanel = h("section", { className: "pl-dupes", hidden: true, "aria-label": "Duplicate check" }, dupesHead, dupesBody);

  const usedV = h("div", { className: "pl-stat-v" }, "0" + MUL);
  const lastV = h("div", { className: "pl-stat-v" }, "—");
  const versV = h("button", { className: "pl-stat-v pl-link", type: "button", onclick: () => pane.openVersions() }, "0");
  const starsEl = h("span", {
    className: "pl-stars",
    role: "group",
    tabIndex: 0,
    "aria-label": "Rating",
    onclick: (e) => pane.onStarClick(e),
    onkeydown: (e) => pane.onStarKey(e),
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
  const saveNewBtn = h("button", { className: "pl-btn pl-btn-primary", type: "button", title: "Save as new (Ctrl+S)", onclick: () => pane.save(true) }, "Save as new");
  const saveBtn = h("button", { className: "pl-btn", type: "button", title: "Overwrite the selected prompt", onclick: () => pane.save(false) }, "Update");
  const delBtn = h("button", { className: "pl-btn pl-btn-danger", type: "button", onclick: () => pane.remove() }, "Delete");
  const actionsEl = h(
    "div",
    { className: "pl-actions" },
    saveNewBtn,
    saveBtn,
    h("span", { className: "pl-spacer" }),
    delBtn
  );

  el.appendChild(h("div", { className: "pl-lbl" }, "// SELECTED"));
  el.appendChild(h("div", { className: "pl-idrow" }, labelEl, newBtn));
  el.appendChild(tagsRow);
  el.appendChild(draftBar);
  el.appendChild(textHead);
  el.appendChild(taWrap);
  el.appendChild(taFoot);
  el.appendChild(dupesPanel);
  el.appendChild(statsEl);
  el.appendChild(actionsEl);

  const els = {
    labelEl, newBtn, tagsRow,
    draftText, draftBar,
    charsEl, tokensEl, editedEl,
    textLabel, textHead, mirror, ta, taWrap,
    diffLink, wildLink, snipLink, versLink,
    dupesTitle, threshBtn, reviseBtn, dupesHead, dupesBody, dupesPanel,
    usedV, lastV, versV, starsEl,
    saveBtn, saveNewBtn, delBtn,
  };

  function applyCaps() {
    const pairs = [
      [diffLink, "__diff"],
      [wildLink, "wildcards"],
      [snipLink, "snippets"],
      [versLink, "versions"],
      [versV, "versions"],
    ];
    for (const [node, cap] of pairs) {
      const ok = cap === "__diff" ? pane.diffOk() : pane.capOk(cap);
      node.disabled = !ok;
      if (!ok) node.setAttribute("title", CAP_TITLE);
      else node.removeAttribute("title");
    }
  }

  return { els, applyCaps };
}
