/* Keyboard movement in the prompt list, as a pure function of the key. */

/**
 * The row a navigation key moves to, or null when `key` does not move.
 * `page` is how many rows a PageUp/PageDown jumps.
 */
export function targetIndex(key, active, total, page) {
  if (!total) return null;
  const at = Math.max(0, active);
  switch (key) {
    case "ArrowDown":
      return Math.min(total - 1, (active < 0 ? -1 : active) + 1);
    case "ArrowUp":
      return Math.max(0, (active < 0 ? 1 : active) - 1);
    case "Home":
      return 0;
    case "End":
      return total - 1;
    case "PageDown":
      return Math.min(total - 1, at + page);
    case "PageUp":
      return Math.max(0, at - page);
    default:
      return null;
  }
}
