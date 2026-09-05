import { h } from "../../shared/dom.js";
import { inst } from "../state.js";

export function createGalleryButton() {
  return h("button", {
    className: "pl-link pl-gallery-open", type: "button",
    title: "Word gallery: pictures, plain definitions and A/B renders of the words you use",
    onclick: () => void openGallery(),
  }, "gallery");
}

/** Loaded on first use, like the storage dialog. */
async function openGallery() {
  const it = inst();
  const session = it.session;
  const [gallery, context] = await Promise.all([import("../../gallery/index.js"), import("../context.js")]);
  if (it.open && it.session === session) gallery.openGallery(context.ctx());
}
