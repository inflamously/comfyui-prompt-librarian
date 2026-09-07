import { h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { MIDDOT } from "./glyphs.js";
import { inst, subscribe } from "../state.js";
import { createLinkButton, createTargetButton } from "../target/controls.js";
import { createStorageButton } from "../storage/controls.js";
import { createCloseButton } from "./dismissal.js";
import { createPaneTabs } from "./navigation.js";

export function createHeader() {
  const sub = h("div", { className: "pl-sub" }, "");
  const link = createLinkButton();
  const storageBtn = createStorageButton();
  const target = createTargetButton();
  const close = createCloseButton();
  const seg = createPaneTabs();
  const head = h(
    "div",
    { className: "pl-head" },
    h("div", { className: "pl-dot" }),
    h("div", { className: "pl-title" }, "Prompt Library"),
    sub,
    h("div", { className: "pl-spacer" }),
    link,
    storageBtn,
    target,
    close,
    seg
  );
  return { head, sub, link, storageBtn, target, close, seg };
}

export function paintHeader(st) {
  const it = inst();
  if (!it.built) return;
  const prompts = `${fmtInt(st.total)} prompt${st.total === 1 ? "" : "s"}`;
  const tags = `${fmtInt(st.tagCount)} tag${st.tagCount === 1 ? "" : "s"}`;
  it.els.sub.textContent = `// ${prompts} ${MIDDOT} ${tags}`;
}


export function wireHeader() {
  subscribe("total", paintHeader);
  subscribe("tagCount", paintHeader);
  paintHeader(inst().state);
}
