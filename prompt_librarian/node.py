"""The serialized text widget is authoritative; prompt_id only links metadata.
Workflows must run without the library. Import and INPUT_TYPES must not
access the filesystem: ComfyUI calls INPUT_TYPES during discovery/validation.
"""

import hashlib
import logging

log = logging.getLogger(__name__)

# Optional imports preserve raw-text output when library services are unavailable.
try:
    from . import wildcards
except Exception:  # pragma: no cover - defensive
    wildcards = None

try:
    from .store import STORE
except Exception:  # pragma: no cover - defensive
    STORE = None


MAX_SEED = 0xFFFFFFFFFFFFFFFF


class PromptLibrarian:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "Prompt body. This is what the node outputs, and "
                               "it is what travels inside the workflow file.",
                }),
                "prompt_id": ("STRING", {
                    "multiline": False,
                    "default": "",
                    "tooltip": "Id of the linked library record. Managed by the "
                               "Librarian panel; usually hidden.",
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_SEED,
                    "control_after_generate": True,
                    "tooltip": "Seeds wildcard resolution. Same seed and same "
                               "text always give the same output.",
                }),
                "resolve_wildcards": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Expand {a|b}, __file__ and [[snippet]] before output.",
                }),
                "track_usage": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Count a run against the linked record. Only counts "
                               "when the text still matches the saved body.",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "prompt_library"
    DESCRIPTION = (
        "Prompt Librarian — searchable prompt library with near-duplicate "
        "detection, tags, ratings, usage stats and version history. Open the "
        "panel from the node to browse; the text widget is always the source "
        "of truth. Supports {a|b|c}, {2$$a|b|c}, __wildcard_file__ and "
        "[[snippet]] expansion."
    )


    def run(self, text, prompt_id="", seed=0, resolve_wildcards=True,
            track_usage=True, **_ignored):
        raw = text if isinstance(text, str) else ("" if text is None else str(text))
        out = raw
        detail = {"picks": [], "missing": [], "warnings": []}

        if resolve_wildcards and wildcards is not None:
            try:
                collect = {}
                out = wildcards.resolve(raw, _seed_int(seed), collect=collect)
                detail = {
                    "picks": collect.get("picks", []),
                    "missing": collect.get("missing", []),
                    "warnings": collect.get("warnings", []),
                }
            except Exception:
                # A wildcard bug must never fail a render. Fall back to raw.
                log.exception("[prompt-librarian] wildcard resolution failed; "
                              "falling back to the raw text")
                out = raw

        # Count raw saved bodies, not seeded expansions; unsaved edits do not count.
        counted = False
        used = None
        if track_usage and prompt_id and STORE is not None:
            try:
                rec = STORE.record_usage(prompt_id, body=raw)
                if rec is not None:
                    counted = True
                    used = int(rec.get("used", 0))
            except Exception:
                log.exception("[prompt-librarian] usage tracking failed for %r",
                              prompt_id)

        # ComfyUI expects list-valued ui fields.
        ui = {
            "text": [out],
            "prompt_id": [str(prompt_id or "")],
            "counted": [bool(counted)],
            "chars": [len(out)],
            "missing": list(detail["missing"]),
            "warnings": list(detail["warnings"]),
        }
        if used is not None:
            ui["used"] = [used]
        return {"ui": ui, "result": (out,)}


    @classmethod
    def IS_CHANGED(cls, text="", prompt_id="", seed=0, resolve_wildcards=True,
                   track_usage=True, **_ignored):
        """Hash output-affecting inputs; track_usage only affects bookkeeping.

        Include file signatures only for wildcard text, avoiding unrelated reruns
        and directory scans. A fixed seed remains cacheable.
        """
        digest = hashlib.sha256()
        digest.update(str(text or "").encode("utf-8", "replace"))
        digest.update(b"\x00")
        digest.update(str(_seed_int(seed)).encode("ascii"))
        digest.update(b"\x00")
        digest.update(b"1" if resolve_wildcards else b"0")
        digest.update(b"\x00")
        digest.update(str(prompt_id or "").encode("utf-8", "replace"))

        if resolve_wildcards and wildcards is not None:
            try:
                if wildcards.has_wildcards(text):
                    digest.update(b"\x00")
                    digest.update(wildcards.signature().encode("ascii", "replace"))
            except Exception:
                log.debug("[prompt-librarian] wildcard signature unavailable",
                          exc_info=True)
        return digest.hexdigest()


def _seed_int(seed):
    """Coerce a seed to a non-negative int; a bad widget value must not raise."""
    try:
        value = int(seed)
    except (TypeError, ValueError):
        return 0
    if value < 0:
        value = -value
    return value % (MAX_SEED + 1)
