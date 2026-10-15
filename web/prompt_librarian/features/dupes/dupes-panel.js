/* The live duplicate check under the editor. It is advisory: the save gate
 * repeats the check before writing. The panel is a heading (count, muted
 * count, threshold) and nothing else; the matches themselves are listed in the
 * revise dialog. A panel whose matches are all muted drops its warning colours:
 * the user has already chosen to keep both.
 */

import { ABORTED, ensureOk } from "../../api/request.js";
import { Component } from "../../shared/component.js";
import { clear, h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { matchesOf } from "../../shared/matches.js";
import { charCount } from "../../shared/text.js";
import { useStyles } from "../../shared/styles.js";
import { debounce } from "../../shared/timing.js";
import { ReviseDialog } from "./revise-dialog.js";
import { openThresholdPicker } from "./threshold-picker.js";

const MDASH = String.fromCharCode(0x2014);
const CARET = String.fromCharCode(0x25be); // ▾
const MIN_CHARS = 8; // below this a check is noise
const MAX_CHARS = 8000; // above this it is too slow per keystroke; "check now" instead
const DEBOUNCE_MS = 400;

/**
 * deps: api ({dupes, ignorePair, settings}), slice (dupes), lane(run) for the
 * cancellable request, layers() -> LayerStack, toast(message, opts),
 * subject() -> {body, id, label} (id null for an unsaved draft),
 * onCompare(match), onMerge(match), onOverwrite(match), onThreshold(t).
 */
export class DupesPanel extends Component {
  constructor(deps) {
    super(deps);
    this.seq = 0; // a response for an older seq lost the race and is dropped
    this.paused = false; // the body is over MAX_CHARS
    this.scheduled = debounce(() => this.check(), DEBOUNCE_MS);
  }

  render() {
    useStyles(new URL("./dupes.css", import.meta.url));
    this.title = h("span", null, "Duplicate check");
    this.reviseBtn = h("button", {
      className: "pl-btn pl-btn-sm", type: "button", hidden: true,
      title: "Work through every near match", onclick: () => this.openRevise(),
    }, "revise");
    this.threshBtn = h("button", {
      className: "pl-thresh", type: "button", "aria-haspopup": "listbox", onclick: () => this.openThreshold(),
    }, h("span", null, "threshold 90%"), h("span", { "aria-hidden": "true" }, CARET));
    this.head = h("div", { className: "pl-dupes-head" }, this.title, this.reviseBtn, this.threshBtn);
    this.body = h("div");
    this.panel = h("section", { className: "pl-dupes", hidden: true, "aria-label": "Duplicate check" },
      this.head, this.body);
    this.watch(this.deps.slice, "*", () => this.paint());
    this.own(() => { this.destroyed = true; this.cancel(); });
    this.paint();
    return this.panel;
  }

  /** The similarity cut-off as a 0–1 fraction. */
  threshold() {
    const t = Number(this.deps.slice.get("threshold"));
    if (!Number.isFinite(t) || t <= 0) return 0.9;
    return t > 1 ? t / 100 : t;
  }

  /** The text changed: check again once typing pauses. */
  schedule() {
    this.paused = false;
    this.scheduled();
  }

  /** Drop the pending check and any answer still in flight. */
  cancel() {
    this.seq++;
    this.scheduled.cancel();
  }

  /** Forget the matches, e.g. when the editor is emptied or deselected. */
  clear() {
    this.seq++;
    this.publish([], false);
  }

  /** Check now; `force` checks a body over the length limit too. */
  async check(force = false) {
    this.scheduled.cancel();
    if (this.destroyed) return; // the slice outlives this panel; leave it alone
    const { body, id } = this.deps.subject();
    const n = charCount(body);
    if (n < MIN_CHARS || (n > MAX_CHARS && !force)) {
      this.paused = n >= MIN_CHARS;
      this.seq++;
      this.publish([], false);
      return;
    }
    this.paused = false;
    const seq = ++this.seq;
    this.publish(this.deps.slice.get("matches"), true);
    let res;
    try {
      res = await this.deps.lane((signal) => this.deps.api.dupes({
        body, id, exclude_id: id, threshold: this.threshold(),
        limit: 10, // enough for revise, not just the closest match
        summaries: true,
      }, signal));
    } catch (_) {
      if (seq === this.seq) this.publish([], false);
      return;
    }
    if (res === ABORTED || seq !== this.seq) return; // cancelled, or a fresher answer won
    let list;
    try { list = matchesOf(ensureOk(res)); } catch (_) { list = []; }
    this.publish(list, false);
  }

  publish(matches, loading) {
    this.deps.slice.set({ matches, loading });
    this.paint(); // `paused` is not in the slice, so a set alone may not repaint
  }

  paint() {
    if (!this.panel) return;
    const list = matchesOf(this.deps.slice.get("matches"));
    this.threshBtn.firstChild.textContent = `threshold ${Math.round(this.threshold() * 100)}%`;
    this.reviseBtn.hidden = !list.length;
    clear(this.body);
    this.panel.hidden = false;
    if (this.paused) {
      this.paintHeading(`paused (long prompt)`, true);
      this.body.append(h("div", { className: "pl-ta-foot" },
        h("span", null, `over ${fmtInt(MAX_CHARS)} chars — checking on every keystroke would be slow`),
        h("span", { className: "pl-spacer" }),
        h("button", { className: "pl-link", type: "button", onclick: () => this.check(true) }, "check now")));
    } else if (this.deps.slice.get("loading")) {
      this.paintHeading("checking…", false);
    } else if (!list.length) {
      // The panel stays up with no matches, so the threshold remains reachable.
      this.panel.hidden = charCount(this.deps.subject().body) < MIN_CHARS;
      this.paintHeading("no near matches", false);
    } else {
      const muted = list.filter((m) => m.ignored).length;
      this.paintHeading(`${fmtInt(list.length)} near match${list.length === 1 ? "" : "es"}` +
        (muted ? ` (${fmtInt(muted)} muted)` : ""), muted < list.length);
    }
  }

  paintHeading(text, warn) {
    this.title.textContent = `Duplicate check ${MDASH} ${text}`;
    this.panel.style.background = warn ? "" : "transparent";
    this.panel.style.borderColor = warn ? "" : "var(--pl-border-soft)";
    this.head.style.color = warn ? "" : "var(--pl-text-mute)";
  }

  openRevise() {
    const matches = matchesOf(this.deps.slice.get("matches"));
    if (!matches.length) return null;
    const { id, label } = this.deps.subject();
    const layers = this.deps.layers();
    // Acting takes over the screen (compare, merge, a confirm), so close first.
    const layer = layers.push({
      closeOnOutside: true,
      component: new ReviseDialog({
        matches,
        threshold: this.threshold(),
        mine: id ? { id: String(id), label } : null,
        onClose: () => layers.pop(layer),
        onAct: (action, m) => { layers.pop(layer); this.act(action, m); },
      }),
    });
    return layer;
  }

  act(action, m) {
    const { onCompare, onMerge, onOverwrite } = this.deps;
    if (action === "compare") onCompare(m);
    else if (action === "merge") onMerge(m);
    else if (action === "overwrite") onOverwrite(m);
    else if (action === "unmute") this.unmute(m);
  }

  /** Make the pair advisory again, and eligible for the exact-copy check on save. */
  async unmute(m) {
    const { api, toast, subject } = this.deps;
    const mine = subject().id;
    if (!mine || !m?.id) return;
    try {
      ensureOk(await api.ignorePair(String(mine), m.id, true));
    } catch (_) {
      toast("could not un-mute this pair", { kind: "error" });
      return;
    }
    toast(`un-muted ${MDASH} this pair will be flagged again when you save`, { kind: "info" });
    this.check(this.paused);
  }

  openThreshold() {
    openThresholdPicker({
      anchor: this.threshBtn,
      value: this.threshold(),
      layers: this.deps.layers(),
      onPick: (t) => this.setThreshold(t),
    });
  }

  /** Use `t` at once, persist it, and let the list re-ask with it too. */
  setThreshold(t) {
    const { api, toast, slice, onThreshold } = this.deps;
    slice.set({ threshold: t });
    this.check(this.paused);
    // A failed write must not undo the choice just made.
    Promise.resolve()
      .then(() => api.settings({ dupe_threshold: t }))
      .catch(() => toast("threshold not saved (using it for this session)", { kind: "error" }));
    onThreshold(t);
  }
}
