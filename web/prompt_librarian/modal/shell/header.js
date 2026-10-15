import { h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { MIDDOT } from "./glyphs.js";
import { inst, slice } from "../instance.js";
import { createLinkButton, createTargetButton } from "../target/controls.js";
import { openGallery, storageControls } from "../app.js";
import { createCloseButton } from "./dismissal.js";
import { createPaneTabs } from "./navigation.js";

export function createHeader() {
  const sub = h("div", { className: "pl-sub" }, "");
  const gallery = h("button", {
    className: "pl-link pl-gallery-open", type: "button",
    title: "Word gallery: pictures, plain definitions and A/B renders of the words you use",
    onclick: () => openGallery(),
  }, "gallery");
  const link = createLinkButton();
  const { button: storageBtn, hint: storageHint } = storageControls();
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
    gallery,
    link,
    storageBtn,
    target,
    close,
    seg
  );
  return { head, sub, gallery, link, storageBtn, storageHint, target, close, seg };
}

export function paintHeader() {
  const it = inst();
  if (!it.built) return;
  const st = slice("library").get();
  const prompts = `${fmtInt(st.total)} prompt${st.total === 1 ? "" : "s"}`;
  const tags = `${fmtInt(st.tagCount)} tag${st.tagCount === 1 ? "" : "s"}`;
  it.els.sub.textContent = `// ${prompts} ${MIDDOT} ${tags}`;
}


export function wireHeader() {
  const library = slice("library");
  library.subscribe("total", paintHeader);
  library.subscribe("tagCount", paintHeader);
  paintHeader();
}
