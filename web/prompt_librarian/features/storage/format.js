/* Formatting and downloading for the storage dialog. */

import { h } from "../../shared/dom.js";

/** A byte count as B, KB, MB, GB or TB. */
export function bytes(value) {
  let n = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

/** Save `blob` as prompt-library-<date>.json. */
export function downloadJson(blob) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: `prompt-library-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
