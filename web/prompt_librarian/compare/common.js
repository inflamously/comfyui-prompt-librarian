/* Use bindKey/ctx.onKey, not native key listeners: prompt_modal/input/keys.js stops
 * native events at window capture. pl:keydown is the fallback mirror.
 * Render prompt and version text through textContent, never innerHTML.
 */

import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";

/* Glyphs by code point so they survive a wrong or absent charset header. */
export const ARROW = String.fromCharCode(0x2192); // →
export const MIDDOT = String.fromCharCode(0x00b7); // ·
export const LDQUO = String.fromCharCode(0x201c);
export const RDQUO = String.fromCharCode(0x201d);
export const SWAP = String.fromCharCode(0x2194); // ↔

export const raf =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);

export function str(v) {
  return v == null ? "" : String(v);
}

export function quote(s) {
  return LDQUO + str(s) + RDQUO;
}

export function tokensOf(text) {
  const s = str(text).trim();
  if (!s) return [];
  return s.split(/\s+/);
}

/** Carry the envelope's derived label onto a view copy, not the stored record.
 */
export function unwrapRecord(res) {
  if (!res || typeof res !== "object") return null;
  let rec = null;
  if (res.prompt && typeof res.prompt === "object") rec = res.prompt;
  else if (res.record && typeof res.record === "object") rec = res.record;
  else if (res.id) return res;
  if (!rec) return null;
  if (typeof res.label === "string" && res.label) rec.label = res.label;
  return rec;
}

export function labelOf(rec, n = 64) {
  if (!rec) return "";
  const given = rec.label == null ? "" : String(rec.label).trim();
  const text = given || String(rec.body == null ? (rec.preview || "") : rec.body);
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  let cut = flat.slice(0, n);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor(n / 2)) cut = cut.slice(0, space);
  return cut.replace(/[ ,;:.\-]+$/, "") + String.fromCharCode(0x2026);
}

export function errMsg(err) {
  if (!err) return "unknown error";
  if (err.code === "not_json") return "the librarian backend is not responding";
  return str(err.message || err) || "request failed";
}

export function isAborted(ctx, value) {
  return ctx && ctx.ABORTED !== undefined && value === ctx.ABORTED;
}

export function toast(ctx, msg, kind) {
  try {
    if (ctx && typeof ctx.toast === "function") ctx.toast(str(msg), kind ? { kind } : undefined);
    else console.info(NS, str(msg));
  } catch (_) {
    /* a toast failing must never break a flow */
  }
}

/** Never window.confirm(). Falls back to "no" when the modal has no confirm. */
export function confirmWith(ctx, opts) {
  if (ctx && typeof ctx.confirmDialog === "function") {
    try {
      return Promise.resolve(ctx.confirmDialog(opts));
    } catch (err) {
      return Promise.resolve(false);
    }
  }
  return Promise.resolve(false);
}

/** Prefer the context key bus; use the namespaced mirror when unavailable.
 *
 * @returns {() => void} unbind
 */
export function bindKey(ctx, el, type, fn) {
  if (ctx && typeof ctx.onKey === "function") {
    try {
      const off = ctx.onKey(el, type, fn);
      if (typeof off === "function") return off;
      return () => {};
    } catch (_) {
      /* fall through to the mirror */
    }
  }
  const mirror = (e) => {
    const orig = (e && e.detail && e.detail.event) || e;
    fn(orig);
  };
  const mtype = "pl:" + type;
  el.addEventListener(mtype, mirror);
  return () => el.removeEventListener(mtype, mirror);
}

export function isTextEntry(node) {
  if (!node || !node.tagName) return false;
  const tag = String(node.tagName).toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true;
}


export function copyText(text) {
  const s = str(text);
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      return Promise.resolve(nav.clipboard.writeText(s)).then(
        () => true,
        () => execCopy(s)
      );
    } catch (_) {
      return Promise.resolve(execCopy(s));
    }
  }
  return Promise.resolve(execCopy(s));
}

function execCopy(s) {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  let ta = null;
  try {
    ta = h("textarea", {
      value: s,
      "aria-hidden": "true",
      style: { position: "fixed", top: "-1000px", left: "-1000px", opacity: "0" },
    });
    (document.body || document.documentElement).appendChild(ta);
    if (typeof ta.select === "function") ta.select();
    return !!document.execCommand("copy");
  } catch (_) {
    return false;
  } finally {
    try {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    } catch (_) {
    }
  }
}


/** Fall back to mounting in the root when no modal layer stack is available.
 */
export function openLayer(ctx, el, opts = {}) {
  let handle = null;
  let closed = false;
  const onClose = typeof opts.onClose === "function" ? opts.onClose : null;
  const fire = () => {
    if (closed) return;
    closed = true;
    if (onClose) {
      try {
        onClose();
      } catch (err) {
        console.error(`${NS} dialog onClose failed`, err);
      }
    }
  };
  try {
    if (ctx && typeof ctx.pushLayer === "function") {
      handle = ctx.pushLayer({
        el,
        closeOnOutside: opts.closeOnOutside !== false,
        onClose: fire,
      });
    }
  } catch (_) {
    handle = null;
  }
  if (!handle) {
    const parent =
      (ctx && ctx.root) || (typeof document !== "undefined" ? document.body : null);
    if (parent && typeof parent.appendChild === "function") parent.appendChild(el);
    handle = { el, local: true };
    focusFirst(el);
  }
  return {
    el,
    isClosed: () => closed,
    close() {
      if (closed) return;
      if (handle.local) {
        if (el.parentNode) el.parentNode.removeChild(el);
        fire();
        return;
      }
      try {
        ctx.popLayer(handle);
      } catch (_) {
      }
      fire(); // no-op when popLayer already ran the handler
    },
  };
}

export function focusFirst(scope) {
  if (!scope || typeof scope.querySelector !== "function") return;
  const el = scope.querySelector(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (el && typeof el.focus === "function") {
    try {
      el.focus();
    } catch (_) {
    }
  }
}

export function btn(label, opts = {}) {
  const kind = opts.kind || "";
  const extra =
    kind === "primary"
      ? " pl-btn-primary"
      : kind === "accent"
      ? " pl-btn-accent"
      : kind === "danger"
      ? " pl-btn-danger"
      : kind === "ghost"
      ? " pl-btn-ghost"
      : "";
  const el = h(
    "button",
    {
      className: "pl-btn" + (opts.small === false ? "" : " pl-btn-sm") + extra,
      type: "button",
      title: opts.title || null,
      disabled: !!opts.disabled,
      dataset: opts.key ? { act: opts.key } : null,
      onclick: opts.onClick || null,
    },
    label
  );
  if (opts.disabled) el.setAttribute("aria-disabled", "true");
  return el;
}

export function skeleton(lines = 3) {
  const box = h("div", { className: "pl-row-skel", "aria-hidden": "true" });
  for (let i = 0; i < lines; i++) {
    box.appendChild(h("div", { className: "pl-row-body", style: { marginBottom: "8px" } }, " "));
  }
  return box;
}

export function errorRow(message, onRetry) {
  const box = h("div", { className: "pl-list-empty", role: "alert" }, str(message));
  if (typeof onRetry === "function") {
    box.appendChild(h("div", { style: { height: "8px" } }));
    box.appendChild(btn("retry", { onClick: onRetry, key: "retry" }));
  }
  return box;
}
