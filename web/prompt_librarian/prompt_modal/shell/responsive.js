import { warnOnce } from "../../shared/singleton.js";
import { inst } from "../state.js";

import { setPane } from "./navigation.js";

const NARROW_AT = 900;

/** Install on each open: closing disconnects the observer and window listener. */
export function installResponsive() {
  const instance = inst();
  const root = instance.root;

  function applyWidth(width) {
    const mode = width < NARROW_AT ? "narrow" : "wide";
    if (root.dataset.w === mode) return;
    root.dataset.w = mode;
    if (instance.els.card) instance.els.card.dataset.w = mode;
    if (mode === "wide") setPane("browse");
  }

  function onResize() {
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
    applyWidth(root.clientWidth || viewportWidth);
  }

  // Observe the root; card dimensions change with narrow-mode padding and can
  // otherwise cause oscillation around the breakpoint.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = (entry.contentRect && entry.contentRect.width) || root.clientWidth || 0;
        applyWidth(width);
      }
    });
    try {
      observer.observe(root);
      instance.ro = observer;
    } catch (error) {
      warnOnce("resize-observer", "ResizeObserver.observe failed; falling back to window resize", error);
      instance.ro = null;
    }
  }

  if (instance.ro) {
    applyWidth(root.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1200));
    return;
  }

  if (typeof window !== "undefined") window.addEventListener("resize", onResize);
  instance.teardown.push(() => {
    if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
  });
  onResize();
}
