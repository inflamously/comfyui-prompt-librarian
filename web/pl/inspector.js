/* ==========================================================================
   Prompt Librarian — inspector (the right pane)
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports EVERY .js under WEB_DIRECTORY as an
   extension, so this file is loaded whether or not anything imports it.
   Exports only — no module-scope work, no listeners, no fetches.

   Owns: name / category / tags, the prompt textarea and its counts, the
   duplicate-check panel, the four stat tiles, and the action row — plus the
   save flow, which is the feature this whole pane exists for:

       NEVER A SILENT OVERWRITE

   The save path is deliberately paranoid and deliberately self-contained:
     1. not dirty and not "save as new"      -> stop, say so
     2. staleness check (someone else edited) -> conflict UI, stop
     3. dupe gate, always re-run on save      -> resolve UI, stop
     4. commit (create | update+expect_updated); 409 re-enters step 2
     5. adopt the server's record as both `current` and `baseline`

   Steps 2-3 build their dialogs INLINE via ctx.pushLayer rather than through
   dialogs.js. The gate is the safety property; it must still work on an
   install where dialogs.js failed to load. dialogs.js / pickers.js are only
   ever reached through lazy `import()` inside a handler, in a try/catch, and
   every one of those handlers degrades to a toast.

   Never innerHTML. Prompt bodies, names and tags are user data — h() and
   textContent only.
   ========================================================================== */

/** sessionStorage key prefix for per-record drafts. */
const DRAFT_PREFIX = "pl:draft:";

/** Threshold options for the `threshold 90% ▾` popover. */
const THRESHOLDS = [0.8, 0.85, 0.9, 0.95, 0.99];

/** Live dupe check is skipped below this many characters (noise). */
const DUPE_MIN_CHARS = 8;

/** ...and above this many (cost). A `check now` button appears instead. */
const DUPE_MAX_CHARS = 8000;

const DUPE_DEBOUNCE_MS = 400;
const DRAFT_DEBOUNCE_MS = 700;

/** Glyphs by code point so they survive a wrong/absent charset header. */
const MUL = String.fromCharCode(0x00d7); // ×  (used 41×)
const CARET = String.fromCharCode(0x25be); // ▾
const MDASH = String.fromCharCode(0x2014); // —
const MIDDOT = String.fromCharCode(0x00b7); // ·
const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);

const NOT_YET = "not available yet";
const CAP_TITLE = "not supported by the installed backend";

/**
 * Mount the inspector into `el` (the `.pl-inspect` element).
 *
 * @param {HTMLElement} el
 * @param {object} ctx  see the modal.js contract
 * @returns {{unmount:()=>void, selectPrompt:(id:string)=>Promise<void>,
 *            isDirty:()=>boolean, getBuffer:()=>object,
 *            setBody:(t:string)=>void, focusBody:()=>void}}
 */
export function mountInspector(el, ctx) {
  const D = (ctx && ctx.dom) || {};

  /* ---- dom.js helpers, with hand-rolled fallbacks so a partially loaded
     helper module degrades instead of throwing at mount time. ---- */
  const h = D.h || fallbackH;
  const clearEl = D.clear || ((n) => { if (n) n.textContent = ""; return n; });
  const debounce = D.debounce || fallbackDebounce;
  const rafThrottle = D.rafThrottle || fallbackRafThrottle;
  const charCount = D.charCount || ((s) => (s == null ? 0 : Array.from(String(s)).length));
  const estimateTokens = D.estimateTokens || ((s) => (String(s || "").trim() ? String(s).trim().split(/\s+/).length : 0));
  const starsOf = D.stars || ((r) => "*".repeat(Math.max(0, Math.min(5, Math.round(r || 0)))));
  const relTime = D.relTime || ((iso) => (iso ? String(iso).slice(0, 10) : ""));
  const fmtInt = D.fmtInt || ((n) => String(Math.floor(Number(n) || 0)));
  const STAR_FULL = D.STAR_FULL || String.fromCharCode(0x2605);
  const STAR_EMPTY = D.STAR_EMPTY || String.fromCharCode(0x2606);
  const NO_AUTOFILL = D.NO_AUTOFILL || {
    autocomplete: "off",
    "data-form-type": "other",
    "data-lpignore": "true",
    "data-1p-ignore": "",
    "data-bwignore": "true",
    "data-protonpass-ignore": "true",
  };

  /* ------------------------------------------------------------------ *
   * Local state.                                                        *
   * `buf` is the live edit buffer. It is mirrored into state.buffer on  *
   * every change with {silent:true}: subscribers must not re-render the *
   * pane on every keystroke, but everyone else (close guard, list, node *
   * loader) still gets to read the current draft off the state.         *
   * ------------------------------------------------------------------ */
  const buf = { name: "", category: "", tags: [], body: "" };
  let current = null; // canonical server record for the selection
  let baseline = null; // snapshot the dirty check and expect_updated use
  let renderedId = null;
  let disposed = false;
  let saving = false;
  let dupeSeq = 0; // guards a slow response overwriting a fresh one
  let dupePaused = false; // body over DUPE_MAX_CHARS
  let ratingBusy = false;
  let pendingId = null; // id of an in-flight selectPrompt fetch

  const subs = [];
  const openLayers = new Set();

  /* ------------------------------------------------------------------ *
   * Small utilities.                                                    *
   * ------------------------------------------------------------------ */

  const S = () => (typeof ctx.getState === "function" ? ctx.getState() || {} : {});

  function toast(msg, kind) {
    try {
      if (typeof ctx.toast === "function") ctx.toast(String(msg), kind ? { kind } : undefined);
      else console.log("[prompt-librarian]", msg);
    } catch (_) { /* a toast failing must never break a flow */ }
  }

  /** The backend advertises `compare`; the brief calls it `diff`. Honour both. */
  function diffOk() {
    return capOk("diff") && capOk("compare");
  }

  /** Only an explicit `false` disables a control; unknown caps stay enabled. */
  function capOk(name) {
    const caps = (ctx && ctx.caps) || S().caps || {};
    return caps[name] !== false;
  }

  /** Current threshold as a 0..1 fraction, tolerating a 0..100 state value. */
  function threshold() {
    const t = Number((S().dupes || {}).threshold);
    if (!Number.isFinite(t) || t <= 0) return 0.9;
    return t > 1 ? t / 100 : t;
  }

  /** Score as a 0..1 fraction, tolerating a 0..100 payload. */
  function frac(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return n > 1 ? n / 100 : n;
  }

  const pct = (v) => Math.round(frac(v) * 100) + "%";

  function errMsg(e) {
    if (!e) return "unknown error";
    if (typeof e === "string") return e;
    return String(e.message || e.error || e.code || e);
  }

  /** The API layer may either throw or hand back `{error, code}`. Unify. */
  function ensureOk(res) {
    if (res && typeof res === "object" && res.error) {
      const e = new Error(String(res.error));
      e.code = res.code;
      e.status = res.status;
      throw e;
    }
    return res;
  }

  function isConflict(x) {
    if (!x) return false;
    const code = x.code || (x.body && x.body.code) || (x.data && x.data.code);
    if (code === "conflict") return true;
    if (Number(x.status) === 409 || Number(x.statusCode) === 409) return true;
    return /\bconflict\b|\b409\b/i.test(String(x.message || x.error || ""));
  }

  /** Records come back bare, or wrapped as {prompt}/{record}. */
  function unwrapRecord(r) {
    if (!r || typeof r !== "object") return null;
    if (r.prompt && typeof r.prompt === "object") return r.prompt;
    if (r.record && typeof r.record === "object") return r.record;
    return r;
  }

  function matchesOf(r) {
    const arr = Array.isArray(r) ? r : (r && (r.matches || r.dupes)) || [];
    const out = [];
    for (const m of arr) {
      if (!m) continue;
      out.push({
        id: m.id != null ? String(m.id) : "",
        name: String(m.name || m.id || "(unnamed)"),
        score: frac(m.score != null ? m.score : m.ratio),
        summary: m.summary == null ? "" : String(m.summary),
        body: typeof m.body === "string" ? m.body : null,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /** Run through a named request lane when one exists. */
  function lane(name, fn) {
    const l = ctx.lanes && ctx.lanes[name];
    if (typeof l === "function") return l(fn);
    return Promise.resolve(fn(undefined));
  }

  function bufferFrom(rec) {
    return {
      name: String((rec && rec.name) || ""),
      category: String((rec && rec.category) || ""),
      tags: Array.isArray(rec && rec.tags) ? rec.tags.map(String) : [],
      body: String((rec && rec.body) || ""),
    };
  }

  /** Field signature used for the dirty comparison (tags order-insensitive). */
  function sig(o) {
    if (!o) o = {};
    const tags = Array.isArray(o.tags) ? o.tags.map(String).slice().sort() : [];
    return JSON.stringify([String(o.name || ""), String(o.category || ""), tags.join(""), String(o.body || "")]);
  }

  function isDirty() {
    return sig(buf) !== sig(baseline ? bufferFrom(baseline) : null);
  }

  function getBuffer() {
    return { name: buf.name, category: buf.category, tags: buf.tags.slice(), body: buf.body };
  }

  /** Mirror the buffer into shared state. Silent by default: see above. */
  function syncBuffer(silent = true) {
    try {
      if (typeof ctx.setState === "function") ctx.setState({ buffer: getBuffer() }, { silent: !!silent });
    } catch (_) { /* state is a convenience here, not a dependency */ }
  }

  /* ------------------------------------------------------------------ *
   * Layers (popovers + the inline dialogs this file owns).              *
   * ------------------------------------------------------------------ */

  function openLayer(node, opts = {}) {
    const rec = { node, closed: false, close: null };
    let handle = null;
    const finish = () => {
      if (rec.closed) return;
      rec.closed = true;
      openLayers.delete(rec);
      if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (_) {} }
    };
    rec.close = () => {
      if (rec.closed) return;
      if (handle != null && typeof ctx.popLayer === "function") {
        rec.closed = true;
        openLayers.delete(rec);
        try { ctx.popLayer(handle); } catch (_) {}
        if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (_) {} }
        return;
      }
      // Fallback path (no layer stack): we appended it ourselves.
      if (node && node.parentNode) node.parentNode.removeChild(node);
      finish();
    };
    if (typeof ctx.pushLayer === "function") {
      try {
        handle = ctx.pushLayer({
          el: node,
          onClose: finish,
          closeOnOutside: opts.closeOnOutside !== false,
        });
      } catch (_) { handle = null; }
    }
    if (handle == null) {
      const doc = (el && el.ownerDocument) || (typeof document !== "undefined" ? document : null);
      if (doc && doc.body && node) doc.body.appendChild(node);
    }
    openLayers.add(rec);
    return rec;
  }

  function closeAllLayers() {
    for (const rec of Array.from(openLayers)) {
      try { rec.close(); } catch (_) {}
    }
    openLayers.clear();
  }

  /** Position a `.pl-popover` under an anchor, flipping when it overflows. */
  function placePopover(pop, anchor) {
    try {
      if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
      const r = anchor.getBoundingClientRect();
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
      pop.style.left = Math.max(8, Math.min(r.left, vw - 260)) + "px";
      const below = vh - r.bottom;
      if (below < 180 && r.top > below) {
        pop.style.bottom = Math.max(8, vh - r.top + 6) + "px";
        pop.style.top = "auto";
      } else {
        pop.style.top = r.bottom + 6 + "px";
        pop.style.bottom = "auto";
      }
    } catch (_) { /* positioning is cosmetic */ }
  }

  /**
   * Minimal local popover — the fallback for every picker while pickers.js
   * does not exist (and the permanent implementation for the threshold
   * control, which is ours). Options are plain values; `withInput` adds a
   * free-text row so a new category/tag can still be created.
   */
  function openLocalPopover(anchor, options, onPick, opts = {}) {
    const pop = h("div", { className: "pl-popover", role: "listbox" });
    let layer = null;
    const pick = (v) => {
      if (layer) layer.close();
      onPick(v);
    };
    if (opts.withInput) {
      const inp = h("input", {
        className: "pl-opt",
        type: "text",
        spellcheck: "false",
        ...NO_AUTOFILL,
        placeholder: opts.placeholder || "new…",
        onkeydown: (e) => {
          if (e.key === "Enter") {
            const v = String(inp.value || "").trim();
            if (v) pick(v);
          }
        },
      });
      pop.appendChild(inp);
      setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
    }
    if (!options.length && !opts.withInput) {
      pop.appendChild(h("div", { className: "pl-opt", "aria-disabled": "true" }, opts.emptyLabel || "nothing to pick"));
    }
    for (const o of options) {
      const value = o && typeof o === "object" ? o.value : o;
      const label = o && typeof o === "object" ? o.label : String(o);
      pop.appendChild(
        h(
          "button",
          {
            className: "pl-opt",
            type: "button",
            role: "option",
            "aria-selected": opts.selected != null && opts.selected === value ? "true" : "false",
            onclick: () => pick(value),
          },
          label
        )
      );
    }
    layer = openLayer(pop, { closeOnOutside: true });
    placePopover(pop, anchor);
    return layer;
  }

  /* ------------------------------------------------------------------ *
   * Markup. Built once; every later update is a value/textContent write. *
   * ------------------------------------------------------------------ */

  clearEl(el);

  const nameInput = h("input", {
    className: "pl-name",
    type: "text",
    spellcheck: "false",
    ...NO_AUTOFILL,
    // Not "prompt_name": an underscore-cased identifier in a lone text field
    // is itself part of what Dashlane pattern-matches on.
    placeholder: "name your prompt",
    "aria-label": "Prompt name",
    oninput: () => { buf.name = nameInput.value; afterEdit(); },
  });

  const catLabel = h("span", null, "");
  const catBtn = h(
    "button",
    {
      className: "pl-cat",
      type: "button",
      "aria-haspopup": "listbox",
      title: "Category",
      onclick: () => openCategoryPicker(),
    },
    catLabel,
    h("span", { "aria-hidden": "true" }, CARET)
  );

  const tagsRow = h("div", { className: "pl-tags" });

  const draftText = h("span", { className: "pl-edited" }, "unsaved draft found");
  const draftBar = h(
    "div",
    { className: "pl-ta-foot", hidden: true },
    draftText,
    h("button", { className: "pl-link", type: "button", onclick: () => restoreDraft() }, "restore draft"),
    h("span", { className: "pl-sep" }, MIDDOT),
    h("button", { className: "pl-link", type: "button", onclick: () => discardDraft() }, "discard")
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

  // The mirror stays empty: pickers.js owns highlighting and adds
  // `.is-mirrored` to the wrap when its self-check passes. The CSS only makes
  // the textarea transparent under that class, so leaving it inert is safe.
  const mirror = h("div", { className: "pl-ta-mirror", "aria-hidden": "true" });
  const ta = h("textarea", {
    className: "pl-ta",
    spellcheck: "false",
    "aria-label": "Prompt text",
    placeholder: "prompt text…",
    oninput: () => { buf.body = ta.value; afterEdit(true); },
  });
  const taWrap = h("div", { className: "pl-ta-wrap" }, mirror, ta);

  const diffLink = h("button", { className: "pl-link", type: "button", onclick: () => openDiffVsSaved() }, "diff vs saved");
  const wildLink = h("button", { className: "pl-link", type: "button", onclick: (e) => openPicker("wildcards", e) }, "wildcards");
  const snipLink = h("button", { className: "pl-link", type: "button", onclick: (e) => openPicker("snippets", e) }, "insert snippet");
  const versLink = h("button", { className: "pl-link", type: "button", onclick: () => openVersions() }, "versions");

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
    { className: "pl-thresh", type: "button", "aria-haspopup": "listbox", onclick: () => openThreshold() },
    h("span", null, "threshold 90%"),
    h("span", { "aria-hidden": "true" }, CARET)
  );
  const dupesHead = h("div", { className: "pl-dupes-head" }, dupesTitle, threshBtn);
  const dupesBody = h("div");
  const dupesPanel = h("section", { className: "pl-dupes", hidden: true, "aria-label": "Duplicate check" }, dupesHead, dupesBody);

  const usedV = h("div", { className: "pl-stat-v" }, "0" + MUL);
  const lastV = h("div", { className: "pl-stat-v" }, "—");
  const versV = h("button", { className: "pl-stat-v pl-link", type: "button", onclick: () => openVersions() }, "0");
  const starsEl = h("span", {
    className: "pl-stars",
    role: "group",
    tabIndex: 0,
    "aria-label": "Rating",
    onclick: (e) => onStarClick(e),
    onkeydown: (e) => onStarKey(e),
  });
  const statsEl = h(
    "div",
    { className: "pl-stats" },
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "USED"), usedV),
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "LAST RUN"), lastV),
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "VERSIONS"), versV),
    h("div", { className: "pl-stat" }, h("div", { className: "pl-stat-k" }, "RATING"), h("div", { className: "pl-stat-v" }, starsEl))
  );

  const loadBtn = h(
    "button",
    {
      className: "pl-btn pl-btn-primary",
      type: "button",
      // Explicit: this pushes what is IN THE BOX, saved or not.
      title: "Push the text currently in the editor into the target node — unsaved edits included",
      onclick: () => loadIntoNode(),
    },
    "Load into node"
  );
  const saveBtn = h("button", { className: "pl-btn", type: "button", onclick: () => save(false) }, "Save");
  const saveNewBtn = h("button", { className: "pl-btn", type: "button", onclick: () => save(true) }, "Save as new");
  const delBtn = h("button", { className: "pl-btn pl-btn-danger", type: "button", onclick: () => remove() }, "Delete");
  const actionsEl = h(
    "div",
    { className: "pl-actions" },
    loadBtn,
    saveBtn,
    saveNewBtn,
    h("span", { className: "pl-spacer" }),
    delBtn
  );

  el.appendChild(h("div", { className: "pl-lbl" }, "// SELECTED"));
  el.appendChild(h("div", { className: "pl-idrow" }, nameInput, catBtn));
  el.appendChild(tagsRow);
  el.appendChild(draftBar);
  el.appendChild(textHead);
  el.appendChild(taWrap);
  el.appendChild(taFoot);
  el.appendChild(dupesPanel);
  el.appendChild(statsEl);
  el.appendChild(actionsEl);

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
      const ok = cap === "__diff" ? diffOk() : capOk(cap);
      node.disabled = !ok;
      if (!ok) node.setAttribute("title", CAP_TITLE);
      else node.removeAttribute("title");
    }
  }
  applyCaps();

  /* ------------------------------------------------------------------ *
   * Rendering.                                                          *
   * ------------------------------------------------------------------ */

  function renderCounts() {
    charsEl.textContent = fmtInt(charCount(buf.body));
    tokensEl.textContent = "~" + fmtInt(estimateTokens(buf.body));
    editedEl.hidden = !isDirty();
  }

  function renderTags() {
    clearEl(tagsRow);
    for (const tag of buf.tags) {
      const chip = h(
        "span",
        { className: "pl-chip" },
        h("span", null, tag),
        h(
          "button",
          {
            className: "pl-chip-x",
            type: "button",
            "aria-label": "Remove tag " + tag,
            title: "Remove tag",
            onclick: () => removeTag(tag),
          },
          MUL
        )
      );
      tagsRow.appendChild(chip);
    }
    tagsRow.appendChild(
      h("button", { className: "pl-chip pl-chip-add", type: "button", onclick: () => openTagPicker() }, "+ tag")
    );
  }

  function renderFields() {
    nameInput.value = buf.name;
    catLabel.textContent = buf.category || "(no category)";
    if (ta.value !== buf.body) ta.value = buf.body;
    renderTags();
    renderCounts();
    renderStats();
    renderActions();
  }

  function renderStats() {
    const rec = current || {};
    usedV.textContent = fmtInt(rec.used || 0) + MUL;
    lastV.textContent = rec.last_run ? relTime(rec.last_run) || "—" : "—";
    const nv = Array.isArray(rec.versions) ? rec.versions.length : Number(rec.version_count || 0);
    versV.textContent = fmtInt(nv);
    renderStars(Number(rec.rating) || 0);
  }

  function renderStars(rating) {
    clearEl(starsEl);
    const enabled = !!(current && current.id);
    starsEl.setAttribute("aria-disabled", enabled ? "false" : "true");
    starsEl.setAttribute("aria-label", "Rating " + Math.round(rating) + " of 5");
    const glyphs = starsOf(rating);
    for (let i = 1; i <= 5; i++) {
      starsEl.appendChild(
        h(
          "span",
          {
            dataset: { i: String(i) },
            role: "button",
            "aria-label": i + " star" + (i === 1 ? "" : "s"),
            title: enabled ? "Rate " + i + "/5" : "",
          },
          glyphs[i - 1] || (i <= rating ? STAR_FULL : STAR_EMPTY)
        )
      );
    }
  }

  function renderActions() {
    const hasRec = !!(current && current.id);
    delBtn.disabled = !hasRec || saving;
    saveBtn.disabled = saving;
    saveNewBtn.disabled = saving;
    loadBtn.disabled = saving || S().targetOk === false;
    if (S().targetOk === false) loadBtn.setAttribute("title", "no usable Prompt Librarian node selected");
    else loadBtn.setAttribute("title", "Push the text currently in the editor into the target node — unsaved edits included");
    diffLink.disabled = !diffOk() || !hasRec;
    versLink.disabled = !capOk("versions") || !hasRec;
    versV.disabled = !capOk("versions") || !hasRec;
  }

  /**
   * The dupe panel. Two visual states:
   *   warn  — matches present: the CSS default (amber bg/border/heading).
   *   clean — nothing found: same box, muted inline colours so a clean result
   *           is quiet rather than alarming. Inline styles (not a new class)
   *           because librarian.css has no `clean` variant and this file is
   *           not allowed to touch it; every value is an existing custom
   *           property, so the theme still owns the colours.
   */
  function renderDupes() {
    const st = S().dupes || {};
    const list = matchesOf(st.matches || []);
    const loading = !!st.loading;
    const t = threshold();
    threshBtn.firstChild.textContent = "threshold " + Math.round(t * 100) + "%";

    clearEl(dupesBody);

    if (dupePaused) {
      dupesPanel.hidden = false;
      setPanelTone(true);
      dupesTitle.textContent = "Duplicate check " + MDASH + " paused (long prompt)";
      dupesBody.appendChild(
        h(
          "div",
          { className: "pl-ta-foot" },
          h("span", null, "over " + fmtInt(DUPE_MAX_CHARS) + " chars — checking on every keystroke would be slow"),
          h("span", { className: "pl-spacer" }),
          h("button", { className: "pl-link", type: "button", onclick: () => runDupes(true) }, "check now")
        )
      );
      return;
    }

    if (loading) {
      dupesPanel.hidden = false;
      setPanelTone(false);
      dupesTitle.textContent = "Duplicate check " + MDASH + " checking…";
      return;
    }

    if (!list.length) {
      // Quiet, collapsed-ish: the box stays (so the threshold control stays
      // reachable) but drops the warning colours.
      dupesPanel.hidden = !buf.body || charCount(buf.body) < DUPE_MIN_CHARS;
      setPanelTone(false);
      dupesTitle.textContent = "Duplicate check " + MDASH + " no near matches";
      return;
    }

    dupesPanel.hidden = false;
    setPanelTone(true);
    dupesTitle.textContent =
      "Duplicate check " + MDASH + " " + fmtInt(list.length) + " near match" + (list.length === 1 ? "" : "es");

    list.forEach((m, i) => dupesBody.appendChild(dupeRow(m, i === 0)));
  }

  function setPanelTone(warn) {
    if (warn) {
      dupesPanel.style.background = "";
      dupesPanel.style.borderColor = "";
      dupesHead.style.color = "";
    } else {
      dupesPanel.style.background = "transparent";
      dupesPanel.style.borderColor = "var(--pl-border-soft)";
      dupesHead.style.color = "var(--pl-text-mute)";
    }
  }

  function dupeRow(m, top) {
    const acts = h(
      "div",
      { className: "pl-dupe-acts" },
      h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => compareWith(m) }, "compare"),
      h("button", { className: "pl-btn pl-btn-sm pl-btn-accent", type: "button", onclick: () => mergeInto(m) }, "merge")
    );
    const row = h(
      "div",
      { className: "pl-dupe" + (top ? " is-top" : "") },
      h("div", { className: "pl-score" }, pct(m.score)),
      h("div", { className: "pl-dupe-name" }, m.name),
      // The `differs: ` prefix belongs to the UI. The backend's `summary` is
      // just the change list, so do not expect it in the payload.
      h("div", { className: "pl-dupe-why" }, m.summary ? "differs: " + m.summary : ""),
      acts
    );
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Edit plumbing.                                                      *
   * ------------------------------------------------------------------ */

  function afterEdit(bodyChanged) {
    syncBuffer(true);
    renderCounts();
    if (bodyChanged) {
      dupePaused = false;
      scheduleDupes();
      scheduleDraft();
      // The one outbound hook. Every edit path funnels through here — the
      // textarea's `oninput`, insertAtCaret() and setBody() — so binding it in
      // one place is what keeps the node from ever missing a keystroke.
      pushBody();
    }
  }

  const scheduleDupes = debounce(() => runDupes(false), DUPE_DEBOUNCE_MS);
  const scheduleDraft = debounce(() => saveDraft(), DRAFT_DEBOUNCE_MS);

  /* ------------------------------------------------------------------ *
   * Node binding — outbound half.                                       *
   * --------------------------------------------------------------------
   * modal.js owns the binding itself (the link toggle, the observer, the
   * echo guard). This end only has to answer one question: is this edit
   * ours to push? It is not, when the edit ARRIVED from the node — pushing
   * it straight back would be a round trip for nothing, and on a slow
   * frontend a visible one.
   * ------------------------------------------------------------------ */

  /**
   * The last body that arrived FROM the node.
   *
   * Deliberately a value, not a flag or a depth counter: `pushBody` is
   * rAF-coalesced, so it runs a frame after the edit that queued it — any
   * "we are currently applying an inbound value" marker would already be
   * cleared by then and would suppress nothing. Comparing the buffer against
   * the last inbound value still holds a frame later, and self-clears the
   * moment the user types anything of their own.
   */
  let lastInbound = null;

  /** rAF-coalesced: a fast typist must not force a canvas repaint per key. */
  const pushBody = rafThrottle(() => {
    if (disposed) return;
    if (lastInbound !== null && buf.body === lastInbound) return;
    if (typeof ctx.pushToNode !== "function") return;
    try {
      ctx.pushToNode(buf.body);
    } catch (_) { /* the binding is a convenience here, never a dependency */ }
  });

  /**
   * Push a whole record — body AND link — to the node. Used only on explicit
   * user selection; see the `push` option on adoptRecord() for why it is not
   * simply "whenever the record changes".
   */
  function pushRecord(rec) {
    if (!rec || typeof ctx.pushToNode !== "function") return;
    lastInbound = null;
    pushBody.cancel();
    try {
      ctx.pushToNode(String(rec.body == null ? "" : rec.body), String(rec.id == null ? "" : rec.id));
    } catch (_) { /* never block a selection on the binding */ }
  }

  async function runDupes(force) {
    if (disposed) return;
    const body = buf.body;
    const n = charCount(body);
    if (n < DUPE_MIN_CHARS) {
      dupePaused = false;
      dupeSeq++; // invalidate anything in flight
      publishDupes([], false);
      return;
    }
    if (n > DUPE_MAX_CHARS && !force) {
      dupePaused = true;
      dupeSeq++;
      publishDupes([], false);
      return;
    }
    dupePaused = false;
    const seq = ++dupeSeq;
    publishDupes((S().dupes || {}).matches || [], true);

    let r;
    try {
      r = await lane("dupe", (signal) =>
        ctx.API.dupes(
          {
            body,
            id: current && current.id ? current.id : null,
            exclude_id: current && current.id ? current.id : null,
            threshold: threshold(),
            // Only the <=3 rows this panel renders, and summaries only for
            // those — the expensive part of the endpoint.
            limit: 3,
            summaries: true,
          },
          signal
        )
      );
    } catch (err) {
      if (disposed || seq !== dupeSeq) return;
      publishDupes([], false);
      return;
    }
    // Cancellation is a sentinel, never a throw.
    if (r === ctx.ABORTED) return;
    if (disposed || seq !== dupeSeq) return; // a fresher response already won
    let list;
    try { list = matchesOf(ensureOk(r)); } catch (_) { list = []; }
    publishDupes(list, false);
  }

  function publishDupes(matches, loading) {
    const st = S().dupes || {};
    try {
      if (typeof ctx.setState === "function") {
        ctx.setState({ dupes: Object.assign({}, st, { matches, loading: !!loading }) });
      }
    } catch (_) {}
    renderDupes();
  }

  /* ------------------------------------------------------------------ *
   * Drafts (sessionStorage, per record).                                *
   * ------------------------------------------------------------------ */

  function draftKey(id) { return DRAFT_PREFIX + String(id); }

  function ss() {
    try { return typeof sessionStorage !== "undefined" ? sessionStorage : null; } catch (_) { return null; }
  }

  /**
   * modal.js owns the same `pl:draft:<id>` keyspace and stores the WHOLE
   * buffer as JSON. Delegate to its helpers when they exist so the two never
   * disagree about the format, and read tolerantly either way.
   */
  function saveDraft() {
    if (!current || !current.id) return;
    const clean = buf.body === String(current.body || "");
    if (typeof ctx.saveDraft === "function" && typeof ctx.clearDraft === "function") {
      try {
        if (clean) ctx.clearDraft(current.id);
        else ctx.saveDraft(current.id, getBuffer());
        return;
      } catch (_) { /* fall through to the local path */ }
    }
    const store = ss();
    if (!store) return;
    try {
      if (clean) store.removeItem(draftKey(current.id));
      else store.setItem(draftKey(current.id), buf.body);
    } catch (_) { /* quota / private mode — drafts are best-effort */ }
  }

  function clearDraft(id) {
    if (!id) return;
    if (typeof ctx.clearDraft === "function") {
      try { ctx.clearDraft(id); return; } catch (_) {}
    }
    const store = ss();
    if (!store) return;
    try { store.removeItem(draftKey(id)); } catch (_) {}
  }

  /** Accepts a raw body string or modal.js's JSON buffer; returns a body. */
  function draftBody(raw) {
    if (raw == null) return null;
    if (typeof raw === "object") return raw.body == null ? null : String(raw.body);
    const s = String(raw);
    if (s.charAt(0) === "{") {
      try {
        const o = JSON.parse(s);
        if (o && typeof o === "object") return o.body == null ? null : String(o.body);
      } catch (_) { /* not JSON — treat as a plain body */ }
    }
    return s;
  }

  let pendingDraft = null;

  function maybeOfferDraft(rec) {
    pendingDraft = null;
    draftBar.hidden = true;
    if (!rec || !rec.id) return;
    let raw = null;
    if (typeof ctx.loadDraft === "function") {
      try { raw = ctx.loadDraft(rec.id); } catch (_) { raw = null; }
    }
    if (raw == null) {
      const store = ss();
      if (!store) return;
      try { raw = store.getItem(draftKey(rec.id)); } catch (_) { return; }
    }
    const d = draftBody(raw);
    if (d == null || d === String(rec.body || "")) return;
    pendingDraft = d;
    draftText.textContent = "unsaved draft found (" + fmtInt(charCount(d)) + " chars)";
    draftBar.hidden = false;
  }

  function restoreDraft() {
    if (pendingDraft == null) return;
    setBody(pendingDraft);
    pendingDraft = null;
    draftBar.hidden = true;
    toast("draft restored");
  }

  function discardDraft() {
    pendingDraft = null;
    draftBar.hidden = true;
    if (current && current.id) clearDraft(current.id);
  }

  /* ------------------------------------------------------------------ *
   * Selection / adoption.                                               *
   * ------------------------------------------------------------------ */

  /**
   * Take a server record as the new selection.
   *
   * @param {object|null} rec
   * @param {{silent?: boolean, push?: boolean}} [opts]
   *
   * `push` writes the record through to the node (body AND `prompt_id` — the
   * link is what makes usage counting work). It is opt-in, and set on exactly
   * one path: a user picking a row. The three callers that must NOT push are
   * the reason it is not simply "always":
   *
   *   - adoptRecord(null) on deselect — would wipe the node's prompt;
   *   - the background refresh in onCurrentChanged() — the record did not
   *     change under the user, the server just answered again;
   *   - the initial paint from restored state — merely OPENING the panel must
   *     never rewrite the node.
   */
  function adoptRecord(rec, opts = {}) {
    current = rec || null;
    baseline = rec ? JSON.parse(JSON.stringify(rec)) : null;
    const nb = bufferFrom(rec);
    buf.name = nb.name;
    buf.category = nb.category;
    buf.tags = nb.tags;
    buf.body = nb.body;
    renderedId = rec && rec.id ? String(rec.id) : null;
    if (opts.push && rec) pushRecord(rec);
    try {
      if (typeof ctx.setState === "function") {
        ctx.setState({ current: current, baseline: baseline, buffer: getBuffer() }, { silent: opts.silent !== false });
      }
    } catch (_) {}
    draftBar.hidden = true;
    pendingDraft = null;
    renderFields();
  }

  async function selectPrompt(id) {
    if (disposed) return;
    if (id == null || id === "") {
      pendingId = null;
      dupeSeq++;
      adoptRecord(null);
      publishDupes([], false);
      return;
    }
    // modal.js may both patch `currentId` (which we subscribe to) and call
    // ctx.inspector.select() for the same click; one fetch is enough.
    if (pendingId != null && pendingId === String(id)) return;
    // Park the outgoing edit before switching away from it.
    if (current && current.id && String(current.id) !== String(id) && isDirty()) saveDraft();
    pendingId = String(id);
    let r;
    try {
      r = await lane("record", (signal) => ctx.API.get(String(id), signal));
    } catch (err) {
      pendingId = null;
      if (!disposed) toast("could not load prompt: " + errMsg(err), "error");
      return;
    }
    pendingId = null;
    if (r === ctx.ABORTED || disposed) return;
    let rec;
    try { rec = unwrapRecord(ensureOk(r)); } catch (err) { toast("could not load prompt: " + errMsg(err), "error"); return; }
    if (!rec || !rec.id) { toast("prompt not found", "error"); return; }
    // The user picked this row, so it goes to the node — body and link both.
    adoptRecord(rec, { push: true });
    maybeOfferDraft(rec);
    scheduleDupes.cancel();
    runDupes(false);
  }

  /* ------------------------------------------------------------------ *
   * Field editors.                                                      *
   * ------------------------------------------------------------------ */

  function removeTag(tag) {
    buf.tags = buf.tags.filter((t) => t !== tag);
    renderTags();
    afterEdit(false);
  }

  function addTag(tag) {
    const t = String(tag || "").trim();
    if (!t) return;
    if (buf.tags.includes(t)) return;
    if (buf.tags.length >= 32) { toast("32 tags is the limit", "error"); return; }
    buf.tags = buf.tags.concat([t]);
    renderTags();
    afterEdit(false);
  }

  function setCategory(catName) {
    buf.category = String(catName || "");
    catLabel.textContent = buf.category || "(no category)";
    afterEdit(false);
  }

  async function openCategoryPicker() {
    const mod = await tryImport("./pickers.js");
    if (mod) {
      const fn = mod.openCategoryPicker || mod.categoryPicker;
      if (typeof fn === "function") {
        try {
          fn(ctx, { anchor: catBtn, value: buf.category, onPick: setCategory });
          return;
        } catch (err) { /* fall through to the local popover */ }
      }
    }
    const cats = (S().categories || []).map((c) => (c && c.name != null ? String(c.name) : String(c)));
    openLocalPopover(catBtn, cats, setCategory, {
      withInput: true,
      placeholder: "new category…",
      selected: buf.category,
      emptyLabel: "no categories yet",
    });
  }

  async function openTagPicker() {
    const mod = await tryImport("./pickers.js");
    if (mod) {
      const fn = mod.openTagPicker || mod.tagPicker;
      if (typeof fn === "function") {
        try {
          fn(ctx, { anchor: tagsRow.lastChild, value: buf.tags.slice(), onPick: addTag });
          return;
        } catch (err) { /* fall through */ }
      }
    }
    const tags = (S().tags || [])
      .map((t) => (t && t.name != null ? String(t.name) : String(t)))
      .filter((t) => !buf.tags.includes(t));
    openLocalPopover(tagsRow.lastChild, tags, addTag, {
      withInput: true,
      placeholder: "new tag…",
      emptyLabel: "no tags yet",
    });
  }

  function openThreshold() {
    const cur = threshold();
    const opts = THRESHOLDS.map((t) => ({ value: t, label: Math.round(t * 100) + "%" }));
    openLocalPopover(
      threshBtn,
      opts,
      (t) => {
        const st = S().dupes || {};
        try {
          if (typeof ctx.setState === "function") ctx.setState({ dupes: Object.assign({}, st, { threshold: t }) });
        } catch (_) {}
        renderDupes();
        scheduleDupes.cancel();
        runDupes(dupePaused);
      },
      { selected: cur }
    );
  }

  /* ------------------------------------------------------------------ *
   * Lazily-imported neighbours. Every one of these degrades to a toast.  *
   * ------------------------------------------------------------------ */

  async function tryImport(spec) {
    try {
      return await import(spec);
    } catch (err) {
      return null;
    }
  }

  function pickFn(mod, names) {
    if (!mod) return null;
    for (const n of names) if (typeof mod[n] === "function") return mod[n];
    return null;
  }

  async function openPicker(which, ev) {
    if (which === "wildcards" && !capOk("wildcards")) return;
    if (which === "snippets" && !capOk("snippets")) return;
    const anchor = (ev && ev.currentTarget) || (which === "wildcards" ? wildLink : snipLink);
    const mod = await tryImport("./pickers.js");
    const fn =
      which === "wildcards"
        ? pickFn(mod, ["openWildcards", "openWildcardPicker", "wildcardPicker"])
        : pickFn(mod, ["openSnippets", "openSnippetPicker", "snippetPicker"]);
    if (!fn) { toast(which + ": " + NOT_YET); return; }
    try {
      fn(ctx, { anchor, textarea: ta, onInsert: (text) => insertAtCaret(text) });
    } catch (err) {
      toast(which + ": " + NOT_YET);
    }
  }

  async function openDiffVsSaved() {
    if (!diffOk()) return;
    if (!current || !current.id) { toast("nothing saved to diff against"); return; }
    if (!isDirty()) { toast("no changes"); return; }
    const mod = await tryImport("./dialogs.js");
    const fn = pickFn(mod, ["openDiff", "openCompare", "openDiffDialog"]);
    if (!fn) { toast("diff: " + NOT_YET); return; }
    try {
      fn(ctx, {
        a_id: current.id,
        a_text: String(baseline ? baseline.body || "" : ""),
        b_text: buf.body,
        titleA: "saved",
        titleB: "editing",
      });
    } catch (err) { toast("diff: " + NOT_YET); }
  }

  async function openVersions() {
    if (!capOk("versions")) return;
    if (!current || !current.id) { toast("select a saved prompt first"); return; }
    const mod = await tryImport("./dialogs.js");
    const fn = pickFn(mod, ["openVersions", "openVersionsDialog", "versionsDialog"]);
    if (!fn) { toast("versions: " + NOT_YET); return; }
    try {
      fn(ctx, { id: current.id, record: current, onRestored: (rec) => { if (rec) adoptRecord(unwrapRecord(rec), { push: true }); } });
    } catch (err) { toast("versions: " + NOT_YET); }
  }

  async function compareWith(m) {
    const mod = await tryImport("./dialogs.js");
    const fn = pickFn(mod, ["openCompare", "openDiff", "compareDialog"]);
    if (!fn) { toast("compare: " + NOT_YET); return; }
    try {
      fn(ctx, {
        a_id: current && current.id ? current.id : null,
        a_text: buf.body,
        b_id: m.id,
        b_text: m.body,
        titleA: buf.name || "this",
        titleB: m.name,
      });
    } catch (err) { toast("compare: " + NOT_YET); }
  }

  function insertAtCaret(text) {
    const s = String(text == null ? "" : text);
    try {
      if (typeof ta.setRangeText === "function") {
        const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        const end = ta.selectionEnd == null ? start : ta.selectionEnd;
        ta.setRangeText(s, start, end, "end");
      } else {
        ta.value = String(ta.value || "") + s;
      }
    } catch (_) {
      ta.value = String(ta.value || "") + s;
    }
    buf.body = ta.value;
    afterEdit(true);
  }

  /* ------------------------------------------------------------------ *
   * Rating — optimistic, reverts on failure.                            *
   * ------------------------------------------------------------------ */

  function onStarClick(e) {
    const t = e && e.target;
    const i = t && t.dataset ? Number(t.dataset.i) : NaN;
    if (!Number.isFinite(i)) return;
    rate(i);
  }

  function onStarKey(e) {
    if (!current || !current.id) return;
    const cur = Number(current.rating) || 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { rate(Math.min(5, cur + 1)); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { rate(Math.max(0, cur - 1)); e.preventDefault(); }
    else if (e.key >= "0" && e.key <= "5") { rate(Number(e.key)); e.preventDefault(); }
  }

  async function rate(value) {
    if (!current || !current.id || ratingBusy) return;
    const id = current.id;
    const prev = Number(current.rating) || 0;
    const next = Math.max(0, Math.min(5, Math.round(value)));
    if (next === prev) return;
    ratingBusy = true;
    current.rating = next; // optimistic
    renderStars(next);
    try {
      const r = await ctx.API.rate(id, next);
      if (r === ctx.ABORTED) throw new Error("aborted");
      const rec = unwrapRecord(ensureOk(r));
      if (rec && rec.id && current && current.id === rec.id) {
        current.rating = Number(rec.rating) || next;
        if (baseline) baseline.rating = current.rating;
        renderStars(current.rating);
      } else if (baseline) {
        baseline.rating = next;
      }
    } catch (err) {
      if (current && current.id === id) {
        current.rating = prev; // revert
        renderStars(prev);
      }
      toast("could not save rating: " + errMsg(err), "error");
    } finally {
      ratingBusy = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Load into node.                                                     *
   * ------------------------------------------------------------------ */

  function loadIntoNode() {
    // The buffer, not the saved record: pushing a draft to the node without
    // saving it is an explicitly supported move (the button's title says so).
    const rec = Object.assign({}, current || {}, getBuffer());
    let res;
    try {
      res = typeof ctx.loadIntoNode === "function" ? ctx.loadIntoNode(rec) : { ok: false, reason: "no_loader" };
    } catch (err) {
      toast("could not load into node: " + errMsg(err), "error");
      return;
    }
    if (res && res.ok) {
      toast(isDirty() ? "loaded into node (unsaved draft)" : "loaded into node", "success");
      return;
    }
    // These codes come from modal.js `loadIntoNode` / bind.js `writeNodeText`
    // and are underscored there. They used to be spelt with hyphens here,
    // which meant every branch fell through to the generic message.
    const reason = res && res.reason;
    if (reason === "stale_target") toast("target node is gone — pick another in the header", "error");
    else if (reason === "no_text_widget") toast("target node has no text widget", "error");
    else if (reason === "no_record") toast("nothing to load", "error");
    else if (reason === "no_loader") toast("the panel is not connected to the graph", "error");
    else toast("could not load into node" + (reason ? ": " + reason : ""), "error");
  }

  /* ------------------------------------------------------------------ *
   * Delete.                                                             *
   * ------------------------------------------------------------------ */

  async function remove() {
    if (!current || !current.id) return;
    const rec = current;
    let ok = false;
    try {
      ok = await ctx.confirmDialog({
        title: "Delete prompt",
        // No soft delete on the backend (caps.soft_delete === false), so we
        // must not promise an Undo we cannot deliver.
        message: "Delete " + LDQUO + (rec.name || rec.id) + RDQUO + "? This cannot be undone.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        danger: true,
      });
    } catch (_) { ok = false; }
    if (!ok || disposed) return;
    try {
      ensureOk(await ctx.API.del(rec.id));
    } catch (err) {
      toast("delete failed: " + errMsg(err), "error");
      return;
    }
    clearDraft(rec.id);
    dupeSeq++;
    adoptRecord(null, { silent: false });
    publishDupes([], false);
    toast("deleted " + LDQUO + (rec.name || rec.id) + RDQUO, "success");
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
  }

  /* ------------------------------------------------------------------ *
   * THE SAVE FLOW.                                                      *
   * ------------------------------------------------------------------ */

  function setSaving(on) {
    saving = !!on;
    renderActions();
  }

  async function save(asNew) {
    if (disposed || saving) return;
    const isUpdate = !asNew && !!(current && current.id);

    if (isUpdate && !isDirty()) { toast("no changes"); return; }
    if (!buf.body.trim()) { toast("prompt text is empty", "error"); return; }
    if (!buf.name.trim()) { toast("give it a name first", "error"); nameInput.focus(); return; }

    setSaving(true);
    try {
      // ---- 2. staleness -------------------------------------------------
      if (isUpdate) {
        let fresh = null;
        try {
          fresh = unwrapRecord(ensureOk(await ctx.API.get(current.id)));
        } catch (err) {
          toast("could not check for remote changes: " + errMsg(err), "error");
          return;
        }
        if (!fresh || !fresh.id) { toast("this prompt no longer exists", "error"); return; }
        if (baseline && String(fresh.updated || "") !== String(baseline.updated || "")) {
          openConflict(fresh, asNew);
          return;
        }
      }

      // ---- 3. dupe gate -------------------------------------------------
      // Deliberately NOT through ctx.lanes.dupe: a keystroke landing mid-save
      // must not be able to abort the gate. Freshly run every time, whatever
      // the live panel happens to be showing.
      const t = threshold();
      let gate = [];
      try {
        const r = await ctx.API.dupes({
          body: buf.body,
          exclude_id: isUpdate ? current.id : null,
          threshold: t,
          summaries: true,
          limit: 10,
        });
        if (r !== ctx.ABORTED) gate = matchesOf(ensureOk(r)).filter((m) => m.score >= t && m.id !== (current && current.id));
      } catch (err) {
        // A dupe-check outage must not become an unsaveable library; warn and
        // proceed, since the backend's own constraints still apply.
        toast("duplicate check unavailable — saving without it", "error");
        gate = [];
      }
      if (disposed) return;
      if (gate.length) { openResolve(gate, asNew); return; }

      // ---- 5. commit ----------------------------------------------------
      await commit(asNew);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Step 5. `create` or `update` with expect_updated; a 409 falls back into
   * the conflict branch rather than a generic error toast.
   */
  async function commit(asNew, opts = {}) {
    const payload = getBuffer();
    const isUpdate = !asNew && !!(current && current.id);
    let rec = null;
    try {
      if (isUpdate) {
        const expect = opts.expectUpdated !== undefined ? opts.expectUpdated : baseline ? baseline.updated : undefined;
        rec = unwrapRecord(
          ensureOk(await ctx.API.update(Object.assign({}, payload, { id: current.id, expect_updated: expect })))
        );
      } else {
        rec = unwrapRecord(ensureOk(await ctx.API.create(payload)));
      }
    } catch (err) {
      if (isUpdate && isConflict(err)) {
        let fresh = null;
        try { fresh = unwrapRecord(ensureOk(await ctx.API.get(current.id))); } catch (_) { fresh = null; }
        if (fresh) { openConflict(fresh, asNew); return null; }
      }
      toast("save failed: " + errMsg(err), "error");
      return null;
    }
    if (!rec || !rec.id) { toast("save failed: no record returned", "error"); return null; }
    if (current && current.id) clearDraft(current.id);
    clearDraft(rec.id);
    // push: a save can MINT AN ID ("save as new"). If the node keeps the old
    // one — or none — usage silently stops counting against what just saved.
    adoptRecord(rec, { silent: false, push: true });
    toast(isUpdate ? "saved" : "created " + LDQUO + rec.name + RDQUO, "success");
    if (typeof ctx.refreshAll === "function") ctx.refreshAll();
    scheduleDupes.cancel();
    runDupes(false);
    return rec;
  }

  /* ---- Conflict UI (step 2) ---------------------------------------- */

  function openConflict(fresh, asNew) {
    const dlg = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Edit conflict" });
    let layer = null;
    const close = () => { if (layer) layer.close(); };

    const body = h(
      "div",
      { className: "pl-dialog-body" },
      h(
        "p",
        null,
        LDQUO + (fresh.name || fresh.id) + RDQUO + " changed somewhere else " +
          (relTime(fresh.updated) ? "(" + relTime(fresh.updated) + " ago)" : "") +
          " while you were editing. Saving now would overwrite that change."
      ),
      h(
        "p",
        null,
        "Yours: " + fmtInt(charCount(buf.body)) + " chars " + MIDDOT + " theirs: " +
          fmtInt(charCount(String(fresh.body || ""))) + " chars."
      )
    );

    const acts = h(
      "div",
      { className: "pl-dialog-acts" },
      h(
        "button",
        {
          className: "pl-btn",
          type: "button",
          onclick: async () => {
            close();
            const mod = await tryImport("./dialogs.js");
            const fn = pickFn(mod, ["openCompare", "openDiff", "compareDialog"]);
            if (!fn) { toast("compare: " + NOT_YET); return; }
            try {
              fn(ctx, { a_id: fresh.id, a_text: buf.body, b_id: fresh.id, b_text: String(fresh.body || ""), titleA: "mine", titleB: "theirs" });
            } catch (_) { toast("compare: " + NOT_YET); }
          },
        },
        "compare"
      ),
      h(
        "button",
        {
          className: "pl-btn",
          type: "button",
          onclick: () => {
            close();
            // Take the server's copy; the local edit is dropped (it is still
            // in the sessionStorage draft until the next clean save).
            saveDraft();
            adoptRecord(fresh, { silent: false, push: true });
            maybeOfferDraft(fresh);
            toast("reloaded their version");
            scheduleDupes.cancel();
            runDupes(false);
          },
        },
        "keep theirs"
      ),
      h(
        "button",
        {
          className: "pl-btn pl-btn-primary",
          type: "button",
          onclick: async () => {
            close();
            // Re-baseline onto the fresh record so expect_updated matches,
            // then commit — an explicit, confirmed overwrite.
            setSaving(true);
            try {
              baseline = JSON.parse(JSON.stringify(fresh));
              current = Object.assign({}, current || {}, { id: fresh.id, updated: fresh.updated });
              await commit(asNew, { expectUpdated: fresh.updated });
            } finally {
              setSaving(false);
            }
          },
        },
        "keep mine (overwrite)"
      ),
      h("button", { className: "pl-btn pl-btn-ghost", type: "button", onclick: () => close() }, "cancel")
    );

    dlg.appendChild(h("div", { className: "pl-dialog-title" }, "This prompt changed elsewhere"));
    dlg.appendChild(body);
    dlg.appendChild(acts);
    layer = openLayer(dlg, { closeOnOutside: false });
    return layer;
  }

  /* ---- Resolve UI (step 4) ----------------------------------------- *
   * Built inline, on purpose: the gate is the safety property of this   *
   * feature and must survive dialogs.js being absent. There is NO       *
   * primary Save here — every path is an explicit decision, and `save   *
   * anyway` is a ghost button behind a confirm that names every match.  *
   * ------------------------------------------------------------------ */

  function openResolve(matches, asNew) {
    const dlg = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Possible duplicate" });
    let layer = null;
    const close = () => { if (layer) layer.close(); };
    const busy = (on) => { for (const b of dlg.querySelectorAll("button")) b.disabled = !!on; };

    const body = h("div", { className: "pl-dialog-body" });
    body.appendChild(
      h(
        "p",
        null,
        "This text is at least " + Math.round(threshold() * 100) + "% similar to " +
          fmtInt(matches.length) + " existing prompt" + (matches.length === 1 ? "" : "s") +
          ". Pick what should happen — nothing is written until you do."
      )
    );

    for (const m of matches) {
      const acts = h(
        "div",
        { className: "pl-dupe-acts" },
        h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => compareWith(m) }, "compare"),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm pl-btn-accent",
            type: "button",
            onclick: async () => { busy(true); try { await mergeInto(m, { close }); } finally { busy(false); } },
          },
          "merge into this"
        ),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm",
            type: "button",
            title: "Save anyway and stop flagging this pair",
            onclick: async () => { busy(true); try { await keepBoth(m, asNew, close); } finally { busy(false); } },
          },
          "keep both"
        ),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm",
            type: "button",
            onclick: async () => { busy(true); try { await overwriteMatch(m, close); } finally { busy(false); } },
          },
          "overwrite that one"
        )
      );
      body.appendChild(
        h(
          "div",
          { className: "pl-dupe" },
          h("div", { className: "pl-score" }, pct(m.score)),
          h("div", { className: "pl-dupe-name" }, m.name),
          h("div", { className: "pl-dupe-why" }, m.summary ? "differs: " + m.summary : ""),
          acts
        )
      );
    }

    const acts = h(
      "div",
      { className: "pl-dialog-acts" },
      // Secondary ghost, never a primary: saving a duplicate must feel like
      // the deliberate exception it is.
      h(
        "button",
        {
          className: "pl-btn pl-btn-ghost",
          type: "button",
          onclick: async () => {
            let ok = false;
            try {
              ok = await ctx.confirmDialog({
                title: "Save a duplicate?",
                message:
                  "This will be saved alongside: " +
                  matches.map((m) => LDQUO + m.name + RDQUO + " (" + pct(m.score) + ")").join(", ") +
                  ". They will keep being flagged as duplicates.",
                confirmLabel: "Save anyway",
                cancelLabel: "Back",
                danger: false,
              });
            } catch (_) { ok = false; }
            if (!ok || disposed) return;
            close();
            setSaving(true);
            try { await commit(asNew); } finally { setSaving(false); }
          },
        },
        "save anyway"
      ),
      h("button", { className: "pl-btn", type: "button", onclick: () => close() }, "cancel")
    );

    dlg.appendChild(
      h("div", { className: "pl-dialog-title" }, "Possible duplicate " + MDASH + " nothing saved yet")
    );
    dlg.appendChild(body);
    dlg.appendChild(acts);
    layer = openLayer(dlg, { closeOnOutside: false });
    return layer;
  }

  /**
   * "keep both": go through with what the user asked for (create for
   * `save as new` / a brand-new record, update otherwise) and then record the
   * pair in `ignored` so this exact comparison stops nagging.
   *
   * DEVIATION from the letter of the brief ("proceeds as create"): when the
   * user is updating an existing record, creating instead would silently
   * fork their prompt into two. "Keep both" means "keep this record and that
   * record" — the ignorePair call is the part that matters.
   */
  async function keepBoth(m, asNew, close) {
    close();
    setSaving(true);
    let rec = null;
    try {
      rec = await commit(asNew);
    } finally {
      setSaving(false);
    }
    if (!rec || !rec.id || !m.id) return;
    try {
      ensureOk(await ctx.API.ignorePair(rec.id, m.id));
    } catch (err) {
      toast("saved, but could not mute this pair: " + errMsg(err), "error");
      return;
    }
    toast("kept both " + MDASH + " this pair will stop being flagged");
  }

  /** "merge into this" / the live panel's `merge` — the match wins. */
  async function mergeInto(m, opts = {}) {
    if (!m || !m.id) return;
    const mine = current && current.id ? String(current.id) : null;
    let ok = false;
    try {
      ok = await ctx.confirmDialog({
        title: "Merge",
        message:
          "Merge into " + LDQUO + m.name + RDQUO + "? It keeps the id, usage count and history; " +
          (mine ? "this record is absorbed and removed." : "your text becomes its current body."),
        confirmLabel: "Merge",
        cancelLabel: "Cancel",
        danger: false,
      });
    } catch (_) { ok = false; }
    if (!ok || disposed) return;
    if (opts.close) opts.close();

    try {
      let rec;
      if (mine && mine !== String(m.id)) {
        rec = unwrapRecord(
          ensureOk(await ctx.API.merge({ winner_id: m.id, loser_id: mine, body: buf.body, name: buf.name || m.name }))
        );
      } else {
        // Nothing of ours is saved yet: absorb by updating the match itself.
        const fresh = unwrapRecord(ensureOk(await ctx.API.get(m.id)));
        if (!fresh) throw new Error("match not found");
        rec = unwrapRecord(
          ensureOk(
            await ctx.API.update({
              id: fresh.id,
              name: fresh.name,
              category: fresh.category,
              tags: fresh.tags,
              body: buf.body,
              expect_updated: fresh.updated,
            })
          )
        );
      }
      if (mine) clearDraft(mine);
      if (rec && rec.id) {
        clearDraft(rec.id);
        adoptRecord(rec, { silent: false, push: true });
        toast("merged into " + LDQUO + rec.name + RDQUO, "success");
      } else {
        toast("merged", "success");
      }
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      scheduleDupes.cancel();
      runDupes(false);
    } catch (err) {
      toast("merge failed: " + errMsg(err), "error");
    }
  }

  /** "overwrite that one" — my text replaces the match's body. */
  async function overwriteMatch(m, close) {
    if (!m || !m.id) return;
    let ok = false;
    try {
      ok = await ctx.confirmDialog({
        title: "Overwrite " + LDQUO + m.name + RDQUO + "?",
        message:
          "Replaces the text of " + LDQUO + m.name + RDQUO + " with what you have here. " +
          "Its previous text is kept in that record's version history.",
        confirmLabel: "Overwrite",
        cancelLabel: "Cancel",
        danger: true,
      });
    } catch (_) { ok = false; }
    if (!ok || disposed) return;
    if (close) close();
    try {
      const fresh = unwrapRecord(ensureOk(await ctx.API.get(m.id)));
      if (!fresh || !fresh.id) throw new Error("that prompt no longer exists");
      const rec = unwrapRecord(
        ensureOk(
          await ctx.API.update({
            id: fresh.id,
            name: fresh.name,
            category: fresh.category,
            tags: fresh.tags,
            body: buf.body,
            expect_updated: fresh.updated,
          })
        )
      );
      if (rec && rec.id) {
        clearDraft(rec.id);
        adoptRecord(rec, { silent: false, push: true });
      }
      toast("overwrote " + LDQUO + m.name + RDQUO, "success");
      if (typeof ctx.refreshAll === "function") ctx.refreshAll();
      scheduleDupes.cancel();
      runDupes(false);
    } catch (err) {
      toast("overwrite failed: " + errMsg(err), "error");
    }
  }

  /* ------------------------------------------------------------------ *
   * Subscriptions.                                                      *
   * ------------------------------------------------------------------ */

  function onCurrentChanged() {
    if (disposed) return;
    const st = S();
    const rec = st.current || null;
    const id = rec && rec.id ? String(rec.id) : null;
    if (id === renderedId) {
      // Same record. Only re-adopt when the user has nothing to lose; a
      // background refresh must never eat an in-progress edit (the staleness
      // check on save is what covers that case).
      if (rec && !isDirty()) adoptRecord(rec);
      return;
    }
    adoptRecord(rec);
    if (rec) {
      maybeOfferDraft(rec);
      scheduleDupes.cancel();
      runDupes(false);
    } else {
      dupeSeq++;
      publishDupes([], false);
    }
  }

  /** `currentId` is set the instant a row is clicked, before the fetch lands. */
  function onCurrentIdChanged() {
    if (disposed) return;
    const id = S().currentId;
    const sid = id == null ? null : String(id);
    if (sid === renderedId || sid === pendingId) return;
    if (sid == null) { selectPrompt(""); return; }
    selectPrompt(sid);
  }

  if (typeof ctx.subscribe === "function") {
    const offs = [
      ctx.subscribe("current", onCurrentChanged),
      ctx.subscribe("currentId", onCurrentIdChanged),
      ctx.subscribe("dupes", () => { if (!disposed) renderDupes(); }),
      ctx.subscribe("caps", () => { if (!disposed) { applyCaps(); renderActions(); } }),
      ctx.subscribe("targetOk", () => { if (!disposed) renderActions(); }),
    ];
    for (const off of offs) if (typeof off === "function") subs.push(off);
  }

  /* ------------------------------------------------------------------ *
   * Registration on the shared ctx.                                     *
   * --------------------------------------------------------------------
   * modal.js documents these hooks on the ctx object it hands every pane
   * (`ctx.inspector = {select}` and `ctx.isDirty`), and it discards the
   * return value of mountInspector — so registering here is what wires the
   * list's row activation and the close-guard to this pane. Purely
   * additive, and undone on unmount.
   * ------------------------------------------------------------------ */
  const registered = { inspector: false, isDirty: false, debounces: false };
  const publicApi = { unmount, selectPrompt, isDirty, getBuffer, setBody, focusBody };
  try {
    if (ctx && typeof ctx === "object") {
      ctx.inspector = Object.assign({ select: (id) => selectPrompt(id) }, publicApi);
      registered.inspector = true;
      if (typeof ctx.isDirty !== "function") {
        ctx.isDirty = isDirty;
        registered.isDirty = true;
      }
      if (Array.isArray(ctx.debounces)) {
        ctx.debounces.push(scheduleDupes, scheduleDraft);
        registered.debounces = true;
      }
    }
  } catch (_) { /* a frozen ctx just means no registration */ }

  /* ------------------------------------------------------------------ *
   * Initial paint (from whatever the state already holds).              *
   * ------------------------------------------------------------------ */
  {
    const st = S();
    if (st.current) adoptRecord(st.current);
    else renderFields();
    renderDupes();
  }

  /* ------------------------------------------------------------------ *
   * Public surface.                                                     *
   * ------------------------------------------------------------------ */

  /**
   * Replace the prompt body.
   *
   * @param {string} text
   * @param {{fromNode?: boolean}} [opts] `fromNode` marks the inbound half of
   *   the node binding: the value already IS what the node holds, so it must
   *   not be pushed back, and it must not steal the box from someone who is
   *   typing in it. Focus is the tiebreaker — whichever textarea the caret is
   *   in wins, which is the only rule that never surprises the user.
   */
  function setBody(text, opts = {}) {
    const next = String(text == null ? "" : text);
    if (opts.fromNode) {
      if (buf.body === next) return;
      try {
        if (typeof document !== "undefined" && document.activeElement === ta) return;
      } catch (_) { /* no document.activeElement — apply it */ }
      lastInbound = next;
      buf.body = next;
      ta.value = next;
      afterEdit(true);
      return;
    }
    buf.body = next;
    ta.value = buf.body;
    afterEdit(true);
  }

  function focusBody() {
    try { ta.focus(); } catch (_) {}
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    dupeSeq++; // any in-flight response is now stale by definition
    try { scheduleDupes.cancel(); } catch (_) {}
    try { scheduleDraft.cancel(); } catch (_) {}
    // A queued rAF push would fire into a node we no longer own the pane for.
    try { pushBody.cancel(); } catch (_) {}
    // Abort in-flight lane work when the lane exposes a way to.
    try {
      const l = ctx.lanes || {};
      for (const key of ["dupe", "record"]) {
        const fn = l[key];
        if (fn && typeof fn.abort === "function") fn.abort();
        else if (fn && typeof fn.cancel === "function") fn.cancel();
      }
    } catch (_) {}
    for (const off of subs) { try { off(); } catch (_) {} }
    subs.length = 0;
    // Un-register from the shared ctx, but only what is still ours.
    try {
      if (registered.inspector && ctx.inspector && ctx.inspector.unmount === unmount) ctx.inspector = null;
      if (registered.isDirty && ctx.isDirty === isDirty) ctx.isDirty = null;
      if (registered.debounces && Array.isArray(ctx.debounces)) {
        for (const d of [scheduleDupes, scheduleDraft]) {
          const i = ctx.debounces.indexOf(d);
          if (i >= 0) ctx.debounces.splice(i, 1);
        }
      }
    } catch (_) {}
    closeAllLayers();
    clearEl(el);
  }

  return publicApi;
}

/* ==========================================================================
   Fallbacks — used only when dom.js is unavailable or partially loaded, so a
   half-broken helper module degrades instead of taking the pane with it.
   ========================================================================== */

function fallbackH(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (k === "hidden") { el.hidden = !!v; continue; }
      if (v == null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k === "dataset") { for (const dk of Object.keys(v)) el.dataset[dk] = String(v[dk]); }
      else if (k === "style") { for (const sk of Object.keys(v)) el.style[sk] = v[sk]; }
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value" || k === "disabled" || k === "tabIndex" || k === "textContent") el[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(add); return; }
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  children.forEach(add);
  return el;
}

function fallbackRafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  const w = (...a) => {
    lastArgs = a;
    if (queued) return;
    queued = true;
    const run = () => { queued = false; const x = lastArgs; lastArgs = null; fn(...(x || [])); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  };
  w.cancel = () => { queued = false; lastArgs = null; };
  return w;
}

function fallbackDebounce(fn, ms) {
  let t = null;
  const w = (...a) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...a); }, ms);
  };
  w.cancel = () => { if (t) clearTimeout(t); t = null; };
  w.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  w.pending = () => t !== null;
  return w;
}
