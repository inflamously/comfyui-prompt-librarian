/* ==========================================================================
   Prompt Librarian — wildcard preview / resolve
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { clear, cls, h } from "../shared/dom.js";
import { truncate } from "../shared/text.js";
import { bindKeys, isFn, toast } from "./common.js";
import { dispatchInput } from "./caret.js";
import { openPopover } from "./popover.js";

const SAMPLE_CHARS = 260; // wildcard preview truncation

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * `POST /resolve {text, seed, n:5}` → `{text, samples[], picks, missing, warnings}`.
 *
 * Five sampled resolutions, each with `re-roll` (a fresh seed for that row) and
 * `use this` (replaces the body through `onReplace`, pushed onto a LOCAL undo
 * stack so Ctrl+Z is not the only way back). `resolve into body` bakes the
 * first sample in permanently. `missing` wildcard names surface as a warning.
 *
 * @param {object} ctx
 * @param {{anchor: HTMLElement, textarea?: HTMLTextAreaElement, body?: string,
 *          onReplace?: (text: string) => void, seed?: number}} opts
 */
export function openWildcards(ctx, { anchor, textarea, body, onReplace, seed } = {}) {
  const source =
    body != null ? String(body) : textarea && textarea.value != null ? String(textarea.value) : "";
  let baseSeed = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : randomSeed();
  const undo = []; // local undo stack of previous bodies

  const currentBody = () =>
    textarea && textarea.value != null ? String(textarea.value) : source;

  const applyBody = (text) => {
    undo.push(currentBody());
    if (isFn(onReplace)) onReplace(text);
    else if (textarea) {
      textarea.value = text;
      dispatchInput(textarea);
    }
  };

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Wildcards",
    className: "pl-pick-wild",
    placement: "bottom-start",
    render: (el, handle) => {
      const head = h(
        "div",
        { className: "pl-lbl", style: { padding: "2px 9px 6px" } },
        "// WILDCARD PREVIEW"
      );
      const warnBox = h("div", { hidden: true });
      const rowsBox = h("div", { role: "list" });
      const undoBtn = h(
        "button",
        {
          className: "pl-btn pl-btn-sm",
          type: "button",
          hidden: true,
          onclick: () => {
            const prev = undo.pop();
            if (prev == null) return;
            if (isFn(onReplace)) onReplace(prev);
            else if (textarea) {
              textarea.value = prev;
              dispatchInput(textarea);
            }
            undoBtn.hidden = !undo.length;
            toast(ctx, "reverted");
          },
        },
        "undo"
      );
      const bakeBtn = h(
        "button",
        {
          className: "pl-btn pl-btn-sm pl-btn-primary",
          type: "button",
          onclick: () => {
            const first = samples[0];
            if (first == null) return;
            applyBody(first);
            undoBtn.hidden = false;
            handle.close();
            toast(ctx, "resolved into the body — wildcard syntax replaced (undo in the popover)");
          },
        },
        "resolve into body"
      );
      const rerollAll = h(
        "button",
        {
          className: "pl-btn pl-btn-sm",
          type: "button",
          onclick: () => {
            baseSeed = randomSeed();
            load();
          },
        },
        "re-roll all"
      );
      const acts = h(
        "div",
        { className: "pl-dupe-acts", style: { display: "flex", gap: "6px", padding: "6px 3px 0" } },
        rerollAll,
        bakeBtn,
        undoBtn
      );

      el.appendChild(head);
      el.appendChild(warnBox);
      el.appendChild(rowsBox);
      el.appendChild(acts);
      el.style.minWidth = "320px";

      let samples = [];
      let active = 0;
      const rowEls = [];

      function paintActive() {
        for (let i = 0; i < rowEls.length; i++) cls(rowEls[i], "is-active", i === active);
      }

      function renderWarnings(missing, warnings) {
        clear(warnBox);
        const miss = Array.isArray(missing) ? missing.filter(Boolean) : [];
        const warn = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
        if (!miss.length && !warn.length) {
          warnBox.hidden = true;
          return;
        }
        warnBox.hidden = false;
        if (miss.length) {
          warnBox.appendChild(
            h(
              "div",
              {
                className: "pl-opt",
                style: { color: "var(--pl-warn)", cursor: "default", whiteSpace: "normal" },
              },
              `missing wildcard ${miss.length === 1 ? "file" : "files"}: ${miss.join(", ")}`
            )
          );
        }
        for (const w of warn) {
          warnBox.appendChild(
            h(
              "div",
              {
                className: "pl-opt",
                style: { color: "var(--pl-warn)", cursor: "default", whiteSpace: "normal" },
              },
              String(w)
            )
          );
        }
      }

      function renderRows() {
        clear(rowsBox);
        rowEls.length = 0;
        if (!samples.length) {
          rowsBox.appendChild(
            h("div", { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } }, "no resolutions")
          );
          return;
        }
        samples.forEach((text, i) => {
          const textEl = h(
            "div",
            { style: { flex: "1 1 auto", minWidth: "0", whiteSpace: "normal" } },
            truncate(String(text == null ? "" : text), SAMPLE_CHARS)
          );
          const row = h(
            "div",
            {
              className: "pl-opt",
              role: "listitem",
              style: { alignItems: "flex-start", cursor: "default", gap: "8px" },
              onpointerdown: () => {
                active = i;
                paintActive();
              },
            },
            h("span", { style: { flex: "0 0 auto", opacity: "0.6" } }, String(i + 1)),
            textEl,
            h(
              "span",
              { style: { flex: "0 0 auto", display: "flex", gap: "8px" } },
              h(
                "button",
                {
                  className: "pl-link",
                  type: "button",
                  onclick: () => reroll(i, textEl),
                },
                "re-roll"
              ),
              h(
                "button",
                {
                  className: "pl-link",
                  type: "button",
                  onclick: () => {
                    applyBody(samples[i]);
                    undoBtn.hidden = false;
                    handle.close();
                  },
                },
                "use this"
              )
            )
          );
          rowEls.push(row);
          rowsBox.appendChild(row);
        });
        paintActive();
      }

      function reroll(i, textEl) {
        if (!(ctx && ctx.API && isFn(ctx.API.resolve))) return;
        const rollSeed = randomSeed();
        Promise.resolve(ctx.API.resolve({ text: source, seed: rollSeed, n: 1 }))
          .then((data) => {
            if (!handle.isOpen() || !data) return;
            const next = Array.isArray(data.samples) && data.samples.length ? data.samples[0] : data.text;
            samples[i] = String(next == null ? "" : next);
            textEl.textContent = truncate(samples[i], SAMPLE_CHARS);
            handle.reposition();
          })
          .catch((err) => console.error(`${NS} re-roll failed`, err));
      }

      function load() {
        clear(rowsBox);
        rowsBox.appendChild(
          h("div", { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } }, "resolving…")
        );
        if (!(ctx && ctx.API && isFn(ctx.API.resolve))) {
          samples = [];
          renderRows();
          return;
        }
        Promise.resolve(ctx.API.resolve({ text: source, seed: baseSeed, n: 5 }))
          .then((data) => {
            if (!handle.isOpen()) return;
            const list = data && Array.isArray(data.samples) ? data.samples : data ? [data.text] : [];
            samples = list.map((s) => String(s == null ? "" : s));
            renderWarnings(data && data.missing, data && data.warnings);
            renderRows();
            handle.reposition();
          })
          .catch((err) => {
            if (!handle.isOpen()) return;
            samples = [];
            clear(rowsBox);
            rowsBox.appendChild(
              h("div", { className: "pl-opt", "aria-disabled": "true", style: { cursor: "default" } }, "resolve failed")
            );
            console.error(`${NS} resolve failed`, err);
          });
      }

      bindKeys(ctx, el, (e) => {
        if (!e || !rowEls.length) return;
        if (e.key === "ArrowDown") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.min(rowEls.length - 1, active + 1);
          paintActive();
        } else if (e.key === "ArrowUp") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.max(0, active - 1);
          paintActive();
        } else if (e.key === "Enter") {
          if (isFn(e.preventDefault)) e.preventDefault();
          if (samples[active] == null) return;
          applyBody(samples[active]);
          undoBtn.hidden = false;
          handle.close();
        }
      });

      load();
      return null;
    },
  });

  return pop;
}
