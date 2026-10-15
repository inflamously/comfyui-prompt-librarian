/* Copying text, with the old execCommand route where the async clipboard is
 * missing or refused (an insecure context, a denied permission). */

import { h } from "../../shared/dom.js";

/** Copy `text`; resolves to whether it worked. */
export async function copyText(text) {
  const s = String(text ?? "");
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch (_) {
    return execCopy(s);
  }
}

function execCopy(s) {
  const ta = h("textarea", {
    value: s,
    "aria-hidden": "true",
    style: { position: "fixed", top: "-1000px", left: "-1000px", opacity: "0" },
  });
  document.body.append(ta);
  try {
    ta.select();
    return !!document.execCommand("copy");
  } catch (_) {
    return false;
  } finally {
    ta.remove();
  }
}
