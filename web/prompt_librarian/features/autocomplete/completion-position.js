const VIEWPORT_MARGIN = 8;
const CARET_GAP = 3;
const MAX_DROPDOWN_HEIGHT = 240;
const MIRROR_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "padding",
  "border",
  "boxSizing",
  "tabSize",
];

/** Place below the caret when possible, otherwise above, within the viewport. */
export function placeDropdown(menu, textarea) {
  const viewport = textarea.ownerDocument.defaultView;
  const caret = measureCaret(textarea);
  const availableWidth = Math.max(0, viewport.innerWidth - VIEWPORT_MARGIN * 2);
  const availableHeight = Math.max(0, viewport.innerHeight - VIEWPORT_MARGIN * 2);

  // Apply size limits before measuring the menu's rendered dimensions.
  menu.style.maxWidth = `${availableWidth}px`;
  menu.style.maxHeight = `${Math.min(MAX_DROPDOWN_HEIGHT, availableHeight)}px`;
  const menuBounds = menu.getBoundingClientRect();

  const belowCaret = caret.top + caret.height + CARET_GAP;
  const aboveCaret = caret.top - menuBounds.height - CARET_GAP;
  const fitsBelow = belowCaret + menuBounds.height <= viewport.innerHeight - VIEWPORT_MARGIN;
  const preferredTop = fitsBelow ? belowCaret : aboveCaret;
  const rightLimit = viewport.innerWidth - menuBounds.width - VIEWPORT_MARGIN;
  const bottomLimit = viewport.innerHeight - menuBounds.height - VIEWPORT_MARGIN;

  menu.style.left = `${clamp(caret.left, VIEWPORT_MARGIN, rightLimit)}px`;
  menu.style.top = `${clamp(preferredTop, VIEWPORT_MARGIN, bottomLimit)}px`;
}

/** Textareas expose selection offsets but no caret rectangle. Measure a hidden
 * copy with the same typography and wrapping, then account for textarea scroll.
 */
function measureCaret(textarea) {
  const document = textarea.ownerDocument;
  const bounds = textarea.getBoundingClientRect();
  const styles = document.defaultView.getComputedStyle(textarea);
  const mirror = createMirror(document, bounds, styles);
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart);

  const marker = document.createElement("span");
  // Keeping the remaining text preserves wrapping at the caret. An empty tail
  // needs a zero-width character to produce a measurable rectangle.
  marker.textContent = textarea.value.slice(textarea.selectionStart) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  try {
    const markerBounds = marker.getClientRects()[0] || marker.getBoundingClientRect();
    const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.2 || 20;
    return {
      left: clamp(markerBounds.left - textarea.scrollLeft, bounds.left, bounds.right),
      top: clamp(markerBounds.top - textarea.scrollTop, bounds.top, bounds.bottom),
      height: lineHeight,
    };
  } finally {
    mirror.remove();
  }
}

function createMirror(document, bounds, styles) {
  const mirror = document.createElement("div");
  for (const property of MIRROR_STYLES) {
    mirror.style[property] = styles[property];
  }
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    width: `${bounds.width}px`,
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
  });
  return mirror;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
