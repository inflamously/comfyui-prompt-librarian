/* ==========================================================================
   Prompt Librarian — inspector fallbacks
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Used only when shared/ is unavailable or partially loaded, so a half-broken
   helper module degrades instead of taking the pane with it.
   ========================================================================== */

export function fallbackH(tag, props, ...children) {
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

export function fallbackRafThrottle(fn) {
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

export function fallbackDebounce(fn, ms) {
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
