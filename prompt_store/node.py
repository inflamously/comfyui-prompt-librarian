"""Persist prompts as {category: [body, ...]}; the serialized text widget,
not the truncated dropdown label, is the node output.
"""

import json
import os

import folder_paths

EMPTY_LABEL = "<empty>"


def _store_dir():
    return os.path.join(folder_paths.get_user_directory(), "default", "prompt-library")


def _store_path():
    return os.path.join(_store_dir(), "prompts.json")


def _load_prompts():
    """Return ``{category: [text, ...]}``, or ``{}`` if missing/unreadable.

    Tolerates a hand-edited file and the old flat ``{name: text}`` format
    (a string value is promoted to a single-item list)."""
    path = _store_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, value in data.items():
        if isinstance(value, str):
            out[str(key)] = [value]
        elif isinstance(value, list):
            out[str(key)] = [str(v) for v in value]
    return out


def _save_prompts(prompts):
    os.makedirs(_store_dir(), exist_ok=True)
    with open(_store_path(), "w", encoding="utf-8") as f:
        json.dump(prompts, f, indent=2, ensure_ascii=False, sort_keys=True)


def _category_names():
    """Sorted category names for the combo. Guarded so it is never empty
    (an empty combo list breaks the ComfyUI frontend)."""
    names = sorted(_load_prompts().keys())
    return names if names else [EMPTY_LABEL]


def _save_target(category, category_name):
    """Resolve which category to save under: the typed `category_name` wins,
    otherwise fall back to the selected `category`. Returns "" when neither is
    usable (so callers can skip saving)."""
    target = (category_name or "").strip()
    if not target or target == EMPTY_LABEL:
        target = category if category and category != EMPTY_LABEL else ""
    return target


def _add_prompt(category, text):
    """Add `text` to `category` (creating it), de-duplicated. No-op for empty
    text. Returns the updated list of prompts in that category."""
    prompts = _load_prompts()
    lst = prompts.setdefault(category, [])
    if text and text not in lst:
        lst.append(text)
        _save_prompts(prompts)
    return prompts.get(category, [])


class PromptLibrary:
    """Executing the graph also saves text to the selected category.
    The serialized text widget preserves the full body independently of dropdown labels.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "category": (_category_names(), {
                    "tooltip": "Pick a saved category.",
                }),
                "category_name": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Category to save under. Type a new name to "
                               "create a new category; blank uses the selected one.",
                }),
                "prompt": ([EMPTY_LABEL], {
                    "tooltip": "Pick a prompt in the category (shown truncated).",
                }),
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Prompt body. This is what the node outputs.",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "prompt_library"

    def run(self, category, category_name, prompt, text):
        target = _save_target(category, category_name)
        if target:
            _add_prompt(target, text)
        return (text,)

    @classmethod
    def VALIDATE_INPUTS(cls, category, category_name, prompt, text):
        # Bypass server-side combo validation for `prompt`: the list is
        # populated dynamically by JS and the server only knows the static
        # [EMPTY_LABEL] seed from INPUT_TYPES.
        return True

    @classmethod
    def IS_CHANGED(cls, category, category_name, prompt, text):
        return f"{category_name}\x00{text}"
