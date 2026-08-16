/* ==========================================================================
   Prompt Librarian — the inspector's markup
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Built once; every later update is a value/textContent write. Handlers are
   late-bound through `pane`, so this file never has to know the order the
   feature modules were wired in.

   Never innerHTML. Prompt bodies and tags are user data — h() and
   textContent only.
   ========================================================================== */

import { CAP_TITLE, CARET, MIDDOT, MUL } from "./constants.js";

/**
 * @param {object} pane
 * @returns {{els: object, applyCaps: () => void}}
 */
export function buildView(pane) {
  const { el, D } = pane;
  const h = D.h;

  D.clearEl(el);

  // There is no name field, because there is no name. This is a *readout*:
  // the handle the rest of the panel prints for this record, derived from the
  // body against the rest of the library and recomputed whenever either
  // changes. It is here so the user can see what a row of theirs will say, not
  // so they can set it — the way to make a prompt findable is to write what it
  // is about in the prompt, and to search for that.
  const labelEl = h("div", {
    className: "pl-label",
    title: "Derived from the prompt text — search finds prompts, names do not",
  });

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
    // `~` because estimateTokens() is a heuristic, not a tokenizer. Never
    // render this number bare; that would be dishonest precision.
    h("span", null, tokensEl, " tokens"),
    editedEl
  );

  const textHead = h(
    "div",
    { className: "pl-ta-foot" },
    h("span", { className: "pl-lbl" }, "// PROMPT TEXT"),
    h("span", { className: "pl-spacer" }),
    countsEl
  );

  // The mirror stays empty: pickers/mirror.js owns highlighting and adds
  // `.is-mirrored` to the wrap when its self-check passes. The CSS only makes
  // the textarea transparent under that class, so leaving it inert is safe.
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
  const dupesHead = h("div", { className: "pl-dupes-head" }, dupesTitle, threshBtn);
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

  // No `Load into node` button: the box and the node's `text` widget are two
  // views of one value (modal/binding.js), so every keystroke is already there.
  const saveBtn = h("button", { className: "pl-btn pl-btn-primary", type: "button", onclick: () => pane.save(false) }, "Save");
  const saveNewBtn = h("button", { className: "pl-btn", type: "button", onclick: () => pane.save(true) }, "Save as new");
  const delBtn = h("button", { className: "pl-btn pl-btn-danger", type: "button", onclick: () => pane.remove() }, "Delete");
  const actionsEl = h(
    "div",
    { className: "pl-actions" },
    saveBtn,
    saveNewBtn,
    h("span", { className: "pl-spacer" }),
    delBtn
  );

  el.appendChild(h("div", { className: "pl-lbl" }, "// SELECTED"));
  el.appendChild(h("div", { className: "pl-idrow" }, labelEl));
  el.appendChild(tagsRow);
  el.appendChild(draftBar);
  el.appendChild(textHead);
  el.appendChild(taWrap);
  el.appendChild(taFoot);
  el.appendChild(dupesPanel);
  el.appendChild(statsEl);
  el.appendChild(actionsEl);

  const els = {
    labelEl, tagsRow,
    draftText, draftBar,
    charsEl, tokensEl, editedEl,
    mirror, ta, taWrap,
    diffLink, wildLink, snipLink, versLink,
    dupesTitle, threshBtn, dupesHead, dupesBody, dupesPanel,
    usedV, lastV, versV, starsEl,
    saveBtn, saveNewBtn, delBtn,
  };

  /* ------------------------------------------------------------------ *
   * Capability gating — a missing backend feature disables its control  *
   * with an explanation instead of throwing when it is clicked.         *
   * ------------------------------------------------------------------ */
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
