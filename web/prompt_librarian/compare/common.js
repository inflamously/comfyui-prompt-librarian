/* ==========================================================================
   Prompt Librarian — dialog plumbing shared by compare / merge / versions
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only — no listeners, no fetches,
   no DOM writes at module scope.

   ----------------------------------------------------------------------
   KEYBOARD: read the KEY ISOLATION block at the top of modal/keys.js first.
   The modal installs a window-CAPTURE guard that calls
   stopImmediatePropagation() on every keydown/keyup/keypress originating
   inside `.pl-root`. A plain `el.addEventListener("keydown", …)` in these
   files would therefore NEVER fire. Every key handler in this directory goes
   through `bindKey()` below, which uses `ctx.onKey(el, type, fn)` (the modal's
   key bus) and falls back to the namespaced `pl:keydown` mirror. Do not
   "simplify" it back to a plain listener.
   ----------------------------------------------------------------------

   Never innerHTML: prompt bodies, names and version text are user data that
   round-trips through JSON. h() + textContent only.
   ========================================================================== */

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

/** Word tokens, the same `\S+` split the backend's differ uses. */
export function tokensOf(text) {
  const s = str(text).trim();
  if (!s) return [];
  return s.split(/\s+/);
}

/** `{prompt: rec}` / `{record: rec}` / `rec` -> rec. */
export function unwrapRecord(res) {
  if (!res || typeof res !== "object") return null;
  if (res.prompt && typeof res.prompt === "object") return res.prompt;
  if (res.record && typeof res.record === "object") return res.record;
  if (res.id) return res;
  return null;
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

/**
 * Bind a key handler that survives the modal's window-capture guard.
 *
 * `ctx.onKey(el, type, fn)` is the supported bus. The `pl:<type>` CustomEvent
 * mirror is the documented fallback (the modal dispatches it on the same
 * target with `detail.event` pointing at the original), used when ctx has no
 * onKey — a plain "keydown" listener would be silently dead.
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

/* --------------------------------------------------------------------------
   Clipboard
   -------------------------------------------------------------------------- */

/** Feature-detected clipboard write with the hidden-textarea fallback. */
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
      /* ignore */
    }
  }
}

/* --------------------------------------------------------------------------
   Layers and small widgets
   -------------------------------------------------------------------------- */

/**
 * Push `el` as a modal layer. Falls back to appending into the root when the
 * modal shell is not built (tests, or this directory loaded standalone), so a
 * dialog is never a silent no-op.
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
        /* ignore */
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
      /* ignore */
    }
  }
}

/** `.pl-btn` with the pack's modifier vocabulary. */
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

/** Three shimmering bars, reusing the list's skeleton rules. */
export function skeleton(lines = 3) {
  const box = h("div", { className: "pl-row-skel", "aria-hidden": "true" });
  for (let i = 0; i < lines; i++) {
    box.appendChild(h("div", { className: "pl-row-body", style: { marginBottom: "8px" } }, " "));
  }
  return box;
}

/** An error row with a retry button — never a bare throw into the console. */
export function errorRow(message, onRetry) {
  const box = h("div", { className: "pl-list-empty", role: "alert" }, str(message));
  if (typeof onRetry === "function") {
    box.appendChild(h("div", { style: { height: "8px" } }));
    box.appendChild(btn("retry", { onClick: onRetry, key: "retry" }));
  }
  return box;
}
