import { placeDropdown } from "./completion-position.js";
import { pictureOf } from "./word-preview.js";

const EDITOR_ATTRIBUTES = [
  "aria-autocomplete",
  "aria-controls",
  "aria-expanded",
  "aria-activedescendant",
];

/** Own the dropdown DOM, selection, and accessibility attributes.
 * `onHighlight(suggestion|null)` hears every highlight change, and null on hide.
 */
export function createAutocompleteMenu(textarea, host, onAccept, onHighlight = () => {}) {
  const document = textarea.ownerDocument;
  const originalAttributes = new Map(
    EDITOR_ATTRIBUTES.map((name) => [name, textarea.getAttribute(name)])
  );
  const menu = document.createElement("div");
  menu.className = "pl-autocomplete";
  menu.id = "pl-autocomplete-" + Math.random().toString(36).slice(2);
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Saved prompt suggestions");
  menu.hidden = true;

  // Escape the card's layout containment so placement uses viewport coordinates.
  (host.closest(".pl-root") || host).appendChild(menu);
  textarea.setAttribute("aria-autocomplete", "list");
  textarea.setAttribute("aria-controls", menu.id);
  textarea.setAttribute("aria-expanded", "false");

  let suggestions = [];
  let selectedIndex = 0;

  function highlightSelection() {
    Array.from(menu.children).forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === selectedIndex));
    });

    const selectedOption = menu.children[selectedIndex];
    if (selectedOption) {
      textarea.setAttribute("aria-activedescendant", selectedOption.id);
      selectedOption.scrollIntoView?.({ block: "nearest" });
    }
    onHighlight(suggestions[selectedIndex] || null);
  }

  function createOption(suggestion, index) {
    const option = document.createElement("div");
    const count = suggestion.source_count;
    option.id = `${menu.id}-${index}`;
    option.setAttribute("role", "option");
    option.textContent = suggestion.text;
    option.title = `${count} saved prompt${count === 1 ? "" : "s"}`;
    if (pictureOf(suggestion.text)) option.classList.add("has-picture");

    // Accept clicks without moving focus or the caret out of the editor.
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => onAccept(suggestion));
    return option;
  }

  function show(items) {
    suggestions = items;
    selectedIndex = 0;
    menu.replaceChildren(...items.map(createOption));
    menu.hidden = false;
    textarea.setAttribute("aria-expanded", "true");
    reposition();
    highlightSelection();
  }

  function hide() {
    suggestions = [];
    menu.hidden = true;
    menu.replaceChildren();
    textarea.setAttribute("aria-expanded", "false");
    textarea.removeAttribute("aria-activedescendant");
    onHighlight(null);
  }

  function moveSelection(direction) {
    selectedIndex = (selectedIndex + direction + suggestions.length) % suggestions.length;
    highlightSelection();
  }

  function reposition() {
    if (!menu.hidden) placeDropdown(menu, textarea);
  }

  function destroy() {
    hide();
    menu.remove();
    for (const [name, value] of originalAttributes) {
      if (value === null) textarea.removeAttribute(name);
      else textarea.setAttribute(name, value);
    }
  }

  return {
    show,
    hide,
    moveSelection,
    reposition,
    destroy,
    isOpen: () => !menu.hidden,
    contains: (element) => menu.contains(element),
    selectedSuggestion: () => suggestions[selectedIndex],
    element: menu,
  };
}
