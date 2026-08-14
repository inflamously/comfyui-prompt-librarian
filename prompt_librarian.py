"""``PromptLibrarian`` — the librarian node.

A second, fully independent node alongside the existing ``PromptLibrary``. It
shares nothing with it: its own store file (``library.json``), its own
``/prompt_librarian/*`` routes, its own web assets. ``prompts.json`` is never
read or written by anything in this file.

Design notes that matter
------------------------

**There are no combo widgets at all.** That single decision deletes the whole
class of LiteGraph/Vue reactivity pain the old node lives with. Compare
``prompt_store.py`` + ``web/prompt_library.js``, where a JS-populated combo
forces *all* of:

* ``_category_names()`` returning ``["<empty>"]`` — a sentinel that exists only
  because an empty combo list breaks the ComfyUI frontend;
* ``VALIDATE_INPUTS`` returning ``True`` unconditionally, purely to bypass
  server-side validation of a list the server has never seen;
* a ``setComboValues`` shim poking ``widget.options.values`` and calling
  ``setDirtyCanvas`` to make the frontend notice;
* a 500 ms ``setTimeout`` on ``nodeCreated`` to dodge widget-wiring order.

Here, selection / category / tags / sort / filters are panel state and never
workflow state, so none of that machinery is needed. ``text`` is a plain
serialized multiline STRING widget — the source of truth, always travelling
inside the workflow ``.json`` — and ``prompt_id`` is a plain serialized STRING
carrying only the metadata link (the JS sets ``widget.type = "hidden"`` so it
stays serialized but out of the layout). A workflow opened on a machine with no
library still renders and still runs; it just does not count usage.

**No filesystem access at import time, and none in ``INPUT_TYPES``.** This is a
deliberate divergence from the old node, whose ``INPUT_TYPES`` calls
``_category_names()`` → ``_load_prompts()`` → ``open()`` on *every*
``/object_info`` request, which fires on every page load and every workflow
validation. ``INPUT_TYPES`` here is a pure dict literal; the store is only
touched inside :meth:`run`.
"""

import hashlib
import logging

log = logging.getLogger(__name__)

# Both imports are optional at runtime: the node must still load (and still
# pass `text` through) on a machine where the store cannot be reached.
try:  # package import inside ComfyUI, flat import in tests / tooling
    try:
        from . import librarian_wildcards as wildcards
    except ImportError:  # pragma: no cover - exercised by the flat-import path
        import librarian_wildcards as wildcards
except Exception:  # pragma: no cover - defensive
    wildcards = None

try:
    try:
        from .librarian_store import STORE
    except ImportError:  # pragma: no cover
        from librarian_store import STORE
except Exception:  # pragma: no cover - defensive
    STORE = None


MAX_SEED = 0xFFFFFFFFFFFFFFFF


class PromptLibrarian:
    """Load, resolve and run a prompt from the librarian library.

    ``text`` is the prompt body and the node's output. ``prompt_id`` links it
    back to a stored record so runs can be counted and the panel can show the
    record's face on the node.
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Pure: a dict literal, no I/O, no store access. See the module
        # docstring — this method is called on every /object_info request.
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

    # -- execution --------------------------------------------------------- #

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

        # Usage is counted against the *raw* widget text, not the resolved
        # output: a wildcard prompt resolves differently every seed by design.
        # `record_usage` itself returns None (and writes nothing) when the id is
        # unknown or the body no longer matches the saved one, which is what
        # keeps `used` meaning "this exact saved body ran".
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

        # `ui` values are lists by ComfyUI convention. This is how the panel
        # shows what the seed actually produced without a second output socket.
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

    # -- change detection --------------------------------------------------- #

    @classmethod
    def IS_CHANGED(cls, text="", prompt_id="", seed=0, resolve_wildcards=True,
                   track_usage=True, **_ignored):
        """Hash of everything that can change the output.

        Deliberately **not** ``NaN``. With a fixed seed and fixed text the
        output is fully deterministic, so forcing a rerun every queue would
        just burn a sampler pass for nothing; ``control_after_generate`` on
        ``seed`` already varies the hash whenever the user wants variation.

        ``track_usage`` is excluded on purpose — it changes bookkeeping, not
        the output, and flipping it should not invalidate a cached render.

        The wildcards-directory signature is folded in *only* when the text
        actually contains a wildcard form. Editing a wildcard file changes the
        output for a fixed seed, so it has to participate; hashing it
        unconditionally would rerun graphs that never touch a wildcard, and it
        costs one ``os.walk`` plus a stat per file.
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
