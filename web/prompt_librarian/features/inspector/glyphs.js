/* Glyphs from code points, so a wrong response charset cannot mangle them. */

export const MUL = String.fromCharCode(0x00d7); // ×, as in "used 41×"
export const MDASH = String.fromCharCode(0x2014); // —
export const MIDDOT = String.fromCharCode(0x00b7); // ·
export const LDQUO = String.fromCharCode(0x201c); // “
export const RDQUO = String.fromCharCode(0x201d); // ”
export const quoted = (s) => LDQUO + s + RDQUO;

export const CAP_TITLE = "not supported by the installed backend";
