const MIN_PREFIX_CHARACTERS = 2;
const MAX_COMPLETION_WORDS = 3;
const WORDS = /[\p{L}\p{N}\p{M}_]+/gu;
const WORD_BEFORE_CARET = /[\p{L}\p{N}\p{M}_]+$/u;
const WORD_AFTER_CARET = /^[\p{L}\p{N}\p{M}_]+/u;
const FRAGMENT_AFTER_CARET = /^[^,\r\n]*/;

export function isShortCompletion(text) {
  const wordCount = (text.match(WORDS) || []).length;
  return wordCount >= 1 && wordCount <= MAX_COMPLETION_WORDS;
}

/** Return query prefixes and replacement ranges for an unselected caret.
 * Ranges use UTF-16 offsets, matching textarea selection and setRangeText.
 * Word matching includes combining marks so decomposed Unicode stays intact.
 */
export function completionContext(value, selectionStart, selectionEnd = selectionStart) {
  if (selectionStart !== selectionEnd) return null;

  const word = wordAtCaret(value, selectionStart);
  const phrase = phraseAtCaret(value, selectionStart);
  return {
    word_prefix: word.prefix,
    phrase_prefix: phrase.prefix,
    word: word.range,
    phrase: phrase.range,
  };
}

function wordAtCaret(value, caretOffset) {
  const beforeCaret = value.slice(0, caretOffset).match(WORD_BEFORE_CARET)?.[0] || "";
  const afterCaret = value.slice(caretOffset).match(WORD_AFTER_CARET)?.[0] || "";

  return {
    prefix: queryPrefix(beforeCaret),
    range: [caretOffset - beforeCaret.length, caretOffset + afterCaret.length],
  };
}

function phraseAtCaret(value, caretOffset) {
  const textBeforeCaret = value.slice(0, caretOffset);
  const lastSeparator = Math.max(
    textBeforeCaret.lastIndexOf(","),
    textBeforeCaret.lastIndexOf("\n"),
    textBeforeCaret.lastIndexOf("\r")
  );
  const fragmentStart = lastSeparator + 1;
  const fragment = textBeforeCaret.slice(fragmentStart);
  const phrase = fragment.trim();
  const fragmentAfterCaret = value.slice(caretOffset).match(FRAGMENT_AFTER_CARET)[0];
  const canReplacePhrase = fragmentAfterCaret.trim() === "" && isShortCompletion(phrase);

  // Keep spaces surrounding the phrase outside the replacement range.
  const leadingWhitespace = fragment.length - fragment.trimStart().length;
  const trailingWhitespace = fragment.length - fragment.trimEnd().length;
  return {
    prefix: canReplacePhrase ? queryPrefix(phrase) : "",
    range: [fragmentStart + leadingWhitespace, caretOffset - trailingWhitespace],
  };
}

function queryPrefix(text) {
  // Count Unicode characters for the threshold, independently of replacement offsets.
  return Array.from(text).length >= MIN_PREFIX_CHARACTERS ? text : "";
}
