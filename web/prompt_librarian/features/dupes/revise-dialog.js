/* The revise dialog: every near match, with what each action keeps and throws
 * away spelled out before it is offered. Nothing is written until a button is
 * picked; picking one hands it to the panel and closes this dialog.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { pct } from "../../shared/matches.js";

const MDASH = String.fromCharCode(0x2014);
const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);
const quoted = (s) => LDQUO + s + RDQUO;

/**
 * deps: matches (normalized, closest first), threshold (0–1), mine ({id, label}
 * or null for an unsaved draft), onAct(action, match) with action one of
 * "compare", "merge", "overwrite", "unmute", and onClose().
 */
export class ReviseDialog extends Component {
  render() {
    const { matches, threshold, onClose } = this.deps;
    const n = matches.length;
    const body = h("div", { className: "pl-dialog-body" }, h("p", null,
      `${fmtInt(n)} prompt${n === 1 ? " is" : "s are"} at least ${Math.round(threshold * 100)}% similar ` +
      "to this text. Nothing here is written until you pick something."));
    matches.forEach((m, i) => body.append(this.row(m, i === 0 && !m.ignored)));
    return h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Near matches" },
      h("div", { className: "pl-dialog-title" }, "Near matches"),
      body,
      h("div", { className: "pl-dialog-acts" },
        h("button", { className: "pl-btn", type: "button", onclick: () => onClose() }, "close")));
  }

  row(m, top) {
    const { mine, onAct } = this.deps;
    const mineLabel = mine ? quoted(mine.label || mine.id) : "this draft";
    const act = (action, label, extra = {}) =>
      h("button", { className: "pl-btn pl-btn-sm", type: "button", ...extra, onclick: () => onAct(action, m) }, label);
    const acts = h("div", { className: "pl-dupe-acts" },
      act("compare", "compare"),
      act("merge", "merge", {
        className: "pl-btn pl-btn-sm pl-btn-accent",
        title: `Keep ${m.label}, give it this text, and drop ${mineLabel}`,
      }),
      act("overwrite", "overwrite", { title: `Replace the text of ${m.label} and keep both records` }),
      m.ignored ? act("unmute", "un-mute", { title: "flag this pair again when saving" }) : null);
    return h("div", { className: "pl-dupe" + (top ? " is-top" : "") + (m.ignored ? " is-muted" : "") },
      h("div", { className: "pl-score" }, pct(m.score)),
      h("div", { className: "pl-dupe-name" }, m.label, m.ignored ? h("span", { className: "pl-dupe-muted" }, "muted") : null),
      // The backend's `summary` is just the change list; the "differs: " prefix is ours.
      h("div", { className: "pl-dupe-why" }, m.summary ? "differs: " + m.summary : ""),
      h("div", { className: "pl-dupe-why" },
        `merge keeps ${quoted(m.label)} (id, usage, history) with this text ${MDASH} ` +
        (mine ? "throws away " + mineLabel : "nothing else is created")),
      h("div", { className: "pl-dupe-why" },
        `overwrite keeps both records ${MDASH} throws away the current text of ${quoted(m.label)} ` +
        "(kept in its version history)"),
      acts);
  }
}
