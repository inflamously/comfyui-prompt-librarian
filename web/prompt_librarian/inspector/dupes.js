/* This panel is advisory. save.js repeats the duplicate check before saving.
 */

import { LDQUO, MDASH, RDQUO } from "./constants.js";
import { ensureOk, matchesOf, pct } from "./records.js";

const THRESHOLDS = [0.8, 0.85, 0.9, 0.95, 0.99];

/** Live dupe check is skipped below this many characters (noise). */
const DUPE_MIN_CHARS = 8;

/** ...and above this many (cost). A `check now` button appears instead. */
const DUPE_MAX_CHARS = 8000;

const DUPE_DEBOUNCE_MS = 400;

/**
 * @param {object} pane
 * @returns {{scheduleDupes: Function}} everything else is attached to `pane`
 */
export function createDupes(pane) {
  const { ctx, D } = pane;
  const h = D.h;
  const els = pane.els;

  function threshold() {
    const t = Number((pane.S().dupes || {}).threshold);
    if (!Number.isFinite(t) || t <= 0) return 0.9;
    return t > 1 ? t / 100 : t;
  }

  /** Use warning colors for unmuted matches; clean/all-muted results stay quiet.
   */
  function renderDupes() {
    const st = pane.S().dupes || {};
    const list = matchesOf(st.matches || []);
    const loading = !!st.loading;
    const t = threshold();
    els.threshBtn.firstChild.textContent = "threshold " + Math.round(t * 100) + "%";
    if (els.reviseBtn) els.reviseBtn.hidden = !list.length;

    D.clearEl(els.dupesBody);

    if (pane.dupePaused) {
      els.dupesPanel.hidden = false;
      setPanelTone(true);
      els.dupesTitle.textContent = "Duplicate check " + MDASH + " paused (long prompt)";
      els.dupesBody.appendChild(
        h(
          "div",
          { className: "pl-ta-foot" },
          h("span", null, "over " + D.fmtInt(DUPE_MAX_CHARS) + " chars — checking on every keystroke would be slow"),
          h("span", { className: "pl-spacer" }),
          h("button", { className: "pl-link", type: "button", onclick: () => runDupes(true) }, "check now")
        )
      );
      return;
    }

    if (loading) {
      els.dupesPanel.hidden = false;
      setPanelTone(false);
      els.dupesTitle.textContent = "Duplicate check " + MDASH + " checking…";
      return;
    }

    if (!list.length) {
      // Keep the threshold reachable even with no matches.
      els.dupesPanel.hidden = !pane.buf.body || D.charCount(pane.buf.body) < DUPE_MIN_CHARS;
      setPanelTone(false);
      els.dupesTitle.textContent = "Duplicate check " + MDASH + " no near matches";
      return;
    }

    els.dupesPanel.hidden = false;
    const muted = list.filter((m) => m.ignored).length;
    // All-muted results are informational; the user has already chosen keep-both.
    setPanelTone(muted < list.length);
    els.dupesTitle.textContent =
      "Duplicate check " + MDASH + " " + D.fmtInt(list.length) + " near match" +
      (list.length === 1 ? "" : "es") +
      (muted ? " (" + D.fmtInt(muted) + " muted)" : "");

    // List matches in the revise dialog, where each action can explain its outcome.
  }

  function openRevise() {
    const list = matchesOf((pane.S().dupes || {}).matches || []);
    if (!list.length) return null;
    const dlg = h("div", {
      className: "pl-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Near matches",
    });
    let layer = null;
    const close = () => { if (layer) layer.close(); };

    const body = h("div", { className: "pl-dialog-body" });
    body.appendChild(
      h(
        "p",
        null,
        D.fmtInt(list.length) + " prompt" + (list.length === 1 ? " is" : "s are") + " at least " +
          Math.round(threshold() * 100) + "% similar to this text. Nothing here is written until you pick something."
      )
    );
    list.forEach((m, i) => {
      const row = reviseRow(m, i === 0 && !m.ignored);
      // Acting on a match takes over the screen (compare, merge, a confirm);
      // leaving this dialog stacked underneath would strand it.
      for (const b of row.querySelectorAll("button")) {
        b.addEventListener("click", () => close());
      }
      body.appendChild(row);
    });

    dlg.appendChild(h("div", { className: "pl-dialog-title" }, "Near matches"));
    dlg.appendChild(body);
    dlg.appendChild(
      h(
        "div",
        { className: "pl-dialog-acts" },
        h("button", { className: "pl-btn", type: "button", onclick: () => close() }, "close")
      )
    );
    layer = pane.openLayer(dlg, { closeOnOutside: true });
    return layer;
  }

  function setPanelTone(warn) {
    if (warn) {
      els.dupesPanel.style.background = "";
      els.dupesPanel.style.borderColor = "";
      els.dupesHead.style.color = "";
    } else {
      els.dupesPanel.style.background = "transparent";
      els.dupesPanel.style.borderColor = "var(--pl-border-soft)";
      els.dupesHead.style.color = "var(--pl-text-mute)";
    }
  }

  /** Unmute the pair so it is advisory again and eligible for exact-copy checks.
   */
  async function unmute(m) {
    const mine = pane.current && pane.current.id ? String(pane.current.id) : null;
    if (!mine || !m || !m.id) return;
    try {
      ensureOk(await ctx.API.ignorePair(mine, m.id, true));
    } catch (err) {
      pane.toast("could not un-mute this pair", "error");
      return;
    }
    pane.toast("un-muted " + MDASH + " this pair will be flagged again when you save");
    pane.scheduleDupes.cancel();
    runDupes(pane.dupePaused);
  }

  /** Describe what each destructive action keeps before offering it.
   */
  function reviseRow(m, top) {
    const mine = pane.current && pane.current.id ? String(pane.current.id) : null;
    const mineLabel = mine ? LDQUO + (D.labelOf(pane.current) || mine) + RDQUO : "this draft";

    const acts = h(
      "div",
      { className: "pl-dupe-acts" },
      h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => pane.compareWith(m) }, "compare"),
      h(
        "button",
        {
          className: "pl-btn pl-btn-sm pl-btn-accent",
          type: "button",
          title: "Keep " + m.label + ", give it this text, and drop " + mineLabel,
          onclick: () => pane.mergeInto(m),
        },
        "merge"
      ),
      h(
        "button",
        {
          className: "pl-btn pl-btn-sm",
          type: "button",
          title: "Replace the text of " + m.label + " and keep both records",
          onclick: () => pane.overwriteMatch(m),
        },
        "overwrite"
      )
    );
    if (m.ignored) {
      acts.appendChild(
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm",
            type: "button",
            title: "flag this pair again when saving",
            onclick: () => unmute(m),
          },
          "un-mute"
        )
      );
    }
    return h(
      "div",
      { className: "pl-dupe" + (top ? " is-top" : "") + (m.ignored ? " is-muted" : "") },
      h("div", { className: "pl-score" }, pct(m.score)),
      h(
        "div",
        { className: "pl-dupe-name" },
        m.label,
        m.ignored ? h("span", { className: "pl-dupe-muted" }, "muted") : null
      ),
      // The `differs: ` prefix belongs to the UI. The backend's `summary` is
      // just the change list, so do not expect it in the payload.
      h("div", { className: "pl-dupe-why" }, m.summary ? "differs: " + m.summary : ""),
      h(
        "div",
        { className: "pl-dupe-why" },
        "merge keeps " + LDQUO + m.label + RDQUO + " (id, usage, history) with this text " + MDASH + " " +
          (mine ? "throws away " + mineLabel : "nothing else is created")
      ),
      h(
        "div",
        { className: "pl-dupe-why" },
        "overwrite keeps both records " + MDASH + " throws away the current text of " + LDQUO + m.label + RDQUO +
          " (kept in its version history)"
      ),
      acts
    );
  }

  async function runDupes(force) {
    if (pane.disposed) return;
    const body = pane.buf.body;
    const n = D.charCount(body);
    if (n < DUPE_MIN_CHARS) {
      pane.dupePaused = false;
      pane.dupeSeq++; // invalidate anything in flight
      publishDupes([], false);
      return;
    }
    if (n > DUPE_MAX_CHARS && !force) {
      pane.dupePaused = true;
      pane.dupeSeq++;
      publishDupes([], false);
      return;
    }
    pane.dupePaused = false;
    const seq = ++pane.dupeSeq;
    publishDupes((pane.S().dupes || {}).matches || [], true);

    let r;
    try {
      r = await pane.lane("dupe", (signal) =>
        ctx.API.dupes(
          {
            body,
            id: pane.current && pane.current.id ? pane.current.id : null,
            exclude_id: pane.current && pane.current.id ? pane.current.id : null,
            threshold: threshold(),
            // Fetch enough matches for revise, not just the closest-match summary.
            limit: 10,
            summaries: true,
          },
          signal
        )
      );
    } catch (err) {
      if (pane.disposed || seq !== pane.dupeSeq) return;
      publishDupes([], false);
      return;
    }
    // Cancellation is a sentinel, never a throw.
    if (r === ctx.ABORTED) return;
    if (pane.disposed || seq !== pane.dupeSeq) return; // a fresher response already won
    let list;
    try { list = matchesOf(ensureOk(r)); } catch (_) { list = []; }
    publishDupes(list, false);
  }

  function publishDupes(matches, loading) {
    const st = pane.S().dupes || {};
    try {
      if (typeof ctx.setState === "function") {
        ctx.setState({ dupes: Object.assign({}, st, { matches, loading: !!loading }) });
      }
    } catch (_) {}
    renderDupes();
  }

  function openThreshold() {
    const cur = threshold();
    const opts = THRESHOLDS.map((t) => ({ value: t, label: Math.round(t * 100) + "%" }));
    pane.openLocalPopover(
      els.threshBtn,
      opts,
      (t) => {
        const st = pane.S().dupes || {};
        try {
          if (typeof ctx.setState === "function") ctx.setState({ dupes: Object.assign({}, st, { threshold: t }) });
        } catch (_) {}
        renderDupes();
        pane.scheduleDupes.cancel();
        runDupes(pane.dupePaused);
        // Persist the threshold and refresh the list so both use the same value.
        try {
          if (ctx.API && typeof ctx.API.settings === "function") {
            Promise.resolve()
              .then(() => ctx.API.settings({ dupe_threshold: t }))
              .catch(() => pane.toast("threshold not saved (using it for this session)", "error"));
          }
        } catch (_) {}
        try {
          if (ctx.list && typeof ctx.list.refresh === "function") ctx.list.refresh({ reset: true });
          else if (typeof ctx.refreshAll === "function") ctx.refreshAll();
        } catch (_) {}
      },
      { selected: cur }
    );
  }

  const scheduleDupes = D.debounce(() => runDupes(false), DUPE_DEBOUNCE_MS);

  pane.threshold = threshold;
  pane.renderDupes = renderDupes;
  pane.runDupes = runDupes;
  pane.publishDupes = publishDupes;
  pane.openThreshold = openThreshold;
  pane.openRevise = openRevise;
  pane.scheduleDupes = scheduleDupes;

  return { scheduleDupes };
}
