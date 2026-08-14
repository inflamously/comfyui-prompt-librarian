"""Tests for the ``PromptLibrarian`` node.

The load-bearing properties: ``INPUT_TYPES`` is pure (no disk, no combos),
``run()`` never fails a render, and usage only counts a run of the *saved*
body.
"""

import os

import pytest

import librarian_store
import librarian_wildcards as wc
import prompt_librarian
from prompt_librarian import PromptLibrarian


@pytest.fixture
def node():
    return PromptLibrarian()


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A real store in a temp dir, wired into the node module."""
    target = librarian_store.LibrarianStore(path=str(tmp_path / "lib" / "library.json"))
    monkeypatch.setattr(prompt_librarian, "STORE", target)
    return target


@pytest.fixture
def wcdir(tmp_path, monkeypatch):
    """A temp wildcards dir behind the shared ``FILES`` instance."""
    root = tmp_path / "wildcards"
    root.mkdir()
    files = wc.WildcardFiles(str(root))
    monkeypatch.setattr(wc, "FILES", files)
    return root


# --------------------------------------------------------------------------- #
# INPUT_TYPES
# --------------------------------------------------------------------------- #

def test_input_types_shape():
    spec = PromptLibrarian.INPUT_TYPES()
    assert set(spec) == {"required"}
    assert list(spec["required"]) == [
        "text", "prompt_id", "seed", "resolve_wildcards", "track_usage",
    ]
    assert spec["required"]["text"][0] == "STRING"
    assert spec["required"]["text"][1]["multiline"] is True
    assert spec["required"]["prompt_id"][1]["multiline"] is False
    assert spec["required"]["seed"][1]["control_after_generate"] is True
    assert spec["required"]["resolve_wildcards"][0] == "BOOLEAN"
    assert spec["required"]["track_usage"][0] == "BOOLEAN"


def test_input_types_has_no_combo_widgets():
    # A combo is declared as a *list* of values. Not one here -- that is the
    # whole reason this node needs no setComboValues shim, no [EMPTY_LABEL]
    # sentinel and no VALIDATE_INPUTS override.
    for name, spec in PromptLibrarian.INPUT_TYPES()["required"].items():
        assert isinstance(spec[0], str), name
    assert not hasattr(PromptLibrarian, "VALIDATE_INPUTS")


def test_input_types_touches_no_filesystem(tmp_path, user_dir, monkeypatch):
    """Calling INPUT_TYPES must not create (or read) the store directory.

    The old node's INPUT_TYPES calls ``_category_names()`` -> ``open()`` on
    every ``/object_info`` request. This asserts we never grew that habit.
    """
    store_dir = os.path.join(str(user_dir), "default", "prompt-librarian")
    assert not os.path.exists(store_dir)

    def _boom(*args, **kwargs):  # pragma: no cover - only runs on regression
        raise AssertionError("INPUT_TYPES touched the filesystem")

    monkeypatch.setattr(os, "stat", _boom)
    monkeypatch.setattr(os, "listdir", _boom)
    monkeypatch.setattr(librarian_store.LibrarianStore, "ensure_loaded", _boom)
    PromptLibrarian.INPUT_TYPES()
    monkeypatch.undo()
    assert not os.path.exists(store_dir)


def test_class_attributes():
    assert PromptLibrarian.RETURN_TYPES == ("STRING",)
    assert PromptLibrarian.RETURN_NAMES == ("text",)
    assert PromptLibrarian.CATEGORY == "prompt_library"
    assert PromptLibrarian.FUNCTION == "run"
    assert isinstance(PromptLibrarian.DESCRIPTION, str) and PromptLibrarian.DESCRIPTION


# --------------------------------------------------------------------------- #
# run()
# --------------------------------------------------------------------------- #

def test_run_returns_ui_and_result(node, store):
    out = node.run("hello", "", 0, False, False)
    assert out["result"] == ("hello",)
    assert out["ui"]["text"] == ["hello"]


def test_run_passes_raw_through_when_disabled(node, store, wcdir):
    text = "{a|b} __mood__ [[snip]]"
    assert node.run(text, "", 0, False, False)["result"] == (text,)


def test_run_resolves_when_enabled(node, store, wcdir):
    assert node.run("{a|b}", "", 0, True, False)["result"][0] in ("a", "b")


def test_run_is_deterministic_per_seed(node, store, wcdir):
    text = " ".join(["{a|b|c|d|e|f|g|h}"] * 6)
    first = node.run(text, "", 99, True, False)["result"]
    assert node.run(text, "", 99, True, False)["result"] == first


def test_run_resolves_wildcard_files(node, store, wcdir):
    (wcdir / "mood.txt").write_text("calm\n", encoding="utf-8")
    assert node.run("__mood__", "", 0, True, False)["result"] == ("calm",)


def test_run_falls_back_to_raw_when_resolution_explodes(node, store, monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(wc, "resolve", _boom)
    assert node.run("{a|b}", "", 0, True, False)["result"] == ("{a|b}",)


def test_run_never_raises_without_a_store(node, monkeypatch):
    monkeypatch.setattr(prompt_librarian, "STORE", None)
    assert node.run("hi", "some-id", 0, False, True)["result"] == ("hi",)


def test_run_never_raises_when_the_store_errors(node, monkeypatch):
    class Broken:
        def record_usage(self, pid, body=None):
            raise OSError("disk gone")

    monkeypatch.setattr(prompt_librarian, "STORE", Broken())
    out = node.run("hi", "some-id", 0, False, True)
    assert out["result"] == ("hi",)
    assert out["ui"]["counted"] == [False]


def test_run_tolerates_a_junk_seed(node, store, wcdir):
    assert node.run("{a|b}", "", "not-a-number", True, False)["result"][0] in ("a", "b")


# --------------------------------------------------------------------------- #
# Usage tracking
# --------------------------------------------------------------------------- #

def test_usage_increments_for_a_matching_body(node, store):
    rec = store.create(name="n", body="ballet drift")
    out = node.run("ballet drift", rec["id"], 0, False, True)
    assert out["ui"]["counted"] == [True]
    assert out["ui"]["used"] == [1]
    assert store.get(rec["id"])["used"] == 1


def test_usage_does_not_increment_for_an_edited_body(node, store):
    rec = store.create(name="n", body="ballet drift")
    out = node.run("ballet drift, but edited", rec["id"], 0, False, True)
    assert out["ui"]["counted"] == [False]
    assert store.get(rec["id"])["used"] == 0


def test_usage_ignores_whitespace_only_differences(node, store):
    rec = store.create(name="n", body="ballet drift")
    node.run("  ballet drift\n", rec["id"], 0, False, True)
    assert store.get(rec["id"])["used"] == 1


def test_usage_counts_the_raw_text_not_the_resolved_output(node, store, wcdir):
    # A wildcard prompt resolves differently every seed by design, so the
    # comparison has to be against what is saved: the raw widget text.
    rec = store.create(name="n", body="a {x|y} b")
    node.run("a {x|y} b", rec["id"], 5, True, True)
    assert store.get(rec["id"])["used"] == 1


def test_usage_does_not_raise_for_an_unknown_id(node, store):
    out = node.run("whatever", "0" * 32, 0, False, True)
    assert out["ui"]["counted"] == [False]
    assert store.count() == 0


def test_usage_is_skipped_when_disabled(node, store):
    rec = store.create(name="n", body="body")
    node.run("body", rec["id"], 0, False, False)
    assert store.get(rec["id"])["used"] == 0


def test_usage_is_skipped_without_an_id(node, store):
    rec = store.create(name="n", body="body")
    node.run("body", "", 0, False, True)
    assert store.get(rec["id"])["used"] == 0


# --------------------------------------------------------------------------- #
# IS_CHANGED
# --------------------------------------------------------------------------- #

def changed(**kwargs):
    base = {"text": "hi", "prompt_id": "", "seed": 0,
            "resolve_wildcards": True, "track_usage": True}
    base.update(kwargs)
    return PromptLibrarian.IS_CHANGED(**base)


def test_is_changed_is_stable(wcdir):
    assert changed() == changed()


def test_is_changed_is_not_nan(wcdir):
    # NaN would rerun every queue; with a fixed seed the output is
    # deterministic and control_after_generate already varies the hash.
    value = changed()
    assert isinstance(value, str) and value == value


@pytest.mark.parametrize(("field", "value"), [
    ("text", "different"),
    ("seed", 1),
    ("resolve_wildcards", False),
    ("prompt_id", "abc"),
])
def test_is_changed_differs_per_field(wcdir, field, value):
    assert changed(**{field: value}) != changed()


def test_is_changed_ignores_track_usage(wcdir):
    assert changed(track_usage=False) == changed(track_usage=True)


def test_is_changed_folds_in_the_signature_only_with_wildcards(wcdir, monkeypatch):
    (wcdir / "mood.txt").write_text("calm\n", encoding="utf-8")
    plain_before = changed(text="plain text")
    wild_before = changed(text="{a|b}")

    (wcdir / "mood.txt").write_text("calm\ntense\n", encoding="utf-8")
    assert changed(text="plain text") == plain_before      # untouched
    assert changed(text="{a|b}") != wild_before            # signature folded in


def test_is_changed_survives_a_broken_signature(wcdir, monkeypatch):
    def _boom():
        raise OSError("no dir")

    monkeypatch.setattr(wc.FILES, "dir_signature", _boom)
    assert isinstance(changed(text="{a|b}"), str)


def test_is_changed_skips_the_signature_when_resolution_is_off(wcdir, monkeypatch):
    calls = []
    monkeypatch.setattr(wc, "signature", lambda: calls.append(1) or "x")
    changed(text="{a|b}", resolve_wildcards=False)
    assert calls == []
