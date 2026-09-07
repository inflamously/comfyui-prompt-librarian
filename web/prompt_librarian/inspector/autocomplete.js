import { createLane } from "../api/lanes.js";
import { dispatchInput } from "../pickers/caret.js";
import { createAutocompleteMenu } from "./autocomplete-menu.js";
import { completionContext, isShortCompletion } from "./completion-context.js";

/** Request completion on input; keep accepted text on the editor's normal input path. */
export function attachAutocomplete(textarea, context, host) {
  const document = textarea.ownerDocument;
  const requestLane = context.lanes?.autocomplete || createLane("autocomplete");
  const menu = createAutocompleteMenu(textarea, host, acceptSuggestion);
  const removeListeners = [];

  let activeRequest = null;
  let isComposing = false;
  let isAccepting = false;
  let isDetached = false;

  function dismiss() {
    activeRequest = null;
    requestLane.cancel();
    menu.hide();
  }

  function isCurrentRequest(request) {
    return request !== null &&
      request === activeRequest &&
      !isComposing &&
      document.activeElement === textarea &&
      textarea.value === request.value &&
      textarea.selectionStart === request.caret &&
      textarea.selectionEnd === request.caret;
  }

  function onInput(event) {
    dismiss();
    if (isDetached || isComposing || event.isComposing || isAccepting) return;
    if (context.caps?.autocomplete === false) return;
    if (typeof context.API?.autocomplete !== "function") return;
    if (document.activeElement !== textarea) return;

    const completion = completionContext(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (!completion || (!completion.word_prefix && !completion.phrase_prefix)) return;

    activeRequest = {
      value: textarea.value,
      caret: textarea.selectionStart,
      completion,
    };
    void requestSuggestions(activeRequest);
  }

  async function requestSuggestions(request) {
    const { word_prefix, phrase_prefix } = request.completion;
    try {
      const response = await requestLane((signal) => context.API.autocomplete(
        { word_prefix, phrase_prefix, limit: 8 },
        signal
      ));
      if (!isCurrentRequest(request)) return;

      const suggestions = matchingSuggestions(response, request);
      if (suggestions.length === 0) {
        dismiss();
        return;
      }
      menu.show(suggestions);
    } catch (_) {
      // Completion is advisory; failed requests must leave editing available.
      if (request === activeRequest) dismiss();
    }
  }

  function acceptSuggestion(suggestion) {
    if (!suggestion || !isCurrentRequest(activeRequest)) {
      dismiss();
      return;
    }

    const [start, end] = activeRequest.completion[suggestion.scope];
    dismiss();
    isAccepting = true;
    try {
      textarea.setRangeText(suggestion.text, start, end, "end");
      dispatchInput(textarea);
    } finally {
      isAccepting = false;
    }
  }

  function onKeyDown(event) {
    if (isComposing || event.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      dismiss();
      return;
    }
    if (event.key === "Escape") {
      if (menu.isOpen()) consumeKey(event);
      dismiss();
      return;
    }
    if (!menu.isOpen()) return;

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (event.shiftKey) return;
        consumeKey(event);
        menu.moveSelection(event.key === "ArrowDown" ? 1 : -1);
        break;
      case "Enter":
        if (event.shiftKey) {
          dismiss();
          return;
        }
        consumeKey(event);
        acceptSuggestion(menu.selectedSuggestion());
        break;
      case "Tab":
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        // Preserve normal focus navigation and caret movement.
        dismiss();
        break;
    }
  }

  function onSelectionChange() {
    if (activeRequest && !isCurrentRequest(activeRequest)) dismiss();
  }

  function onCompositionStart() {
    isComposing = true;
    dismiss();
  }

  function onCompositionEnd() {
    isComposing = false;
  }

  function onScroll(event) {
    // Caret scrolling can follow input. Move the menu without cancelling that request.
    if (!menu.contains(event.target)) menu.reposition();
  }

  function listen(target, event, handler, capture = false) {
    target.addEventListener(event, handler, capture);
    removeListeners.push(() => target.removeEventListener(event, handler, capture));
  }

  // The panel's key bus delivers events intercepted by its ComfyUI shortcut guard.
  if (typeof context.onKey === "function") {
    removeListeners.push(context.onKey(textarea, "keydown", onKeyDown));
  } else {
    listen(textarea, "keydown", onKeyDown);
  }
  listen(textarea, "input", onInput);
  listen(textarea, "blur", dismiss);
  listen(textarea, "pointerdown", dismiss);
  listen(textarea, "compositionstart", onCompositionStart);
  listen(textarea, "compositionend", onCompositionEnd);
  listen(textarea, "select", onSelectionChange);
  listen(document, "selectionchange", onSelectionChange);
  listen(document, "scroll", onScroll, true);
  listen(document.defaultView, "resize", dismiss);

  function detach() {
    if (isDetached) return;
    isDetached = true;
    dismiss();
    for (const removeListener of removeListeners) removeListener();
    menu.destroy();
  }

  return { dismiss, detach };
}

function matchingSuggestions(response, request) {
  const suggestions = Array.isArray(response?.suggestions) ? response.suggestions : [];
  return suggestions.filter((suggestion) => {
    if (typeof suggestion?.text !== "string") return false;
    // Also protect the editor when an older server still returns sentence entries.
    if (!isShortCompletion(suggestion.text)) return false;
    if (suggestion.scope !== "word" && suggestion.scope !== "phrase") return false;
    if (!request.completion[`${suggestion.scope}_prefix`]) return false;

    const [start, end] = request.completion[suggestion.scope];
    return suggestion.text !== request.value.slice(start, end);
  });
}

function consumeKey(event) {
  event.preventDefault();
  event.stopPropagation();
}
