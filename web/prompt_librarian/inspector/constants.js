/* Use code points so glyphs survive an incorrect response charset.
 */

export const MUL = String.fromCharCode(0x00d7); // ×  (used 41×)
export const CARET = String.fromCharCode(0x25be); // ▾
export const MDASH = String.fromCharCode(0x2014); // —
export const MIDDOT = String.fromCharCode(0x00b7); // ·
export const LDQUO = String.fromCharCode(0x201c);
export const RDQUO = String.fromCharCode(0x201d);

export const NOT_YET = "not available yet";
export const CAP_TITLE = "not supported by the installed backend";
