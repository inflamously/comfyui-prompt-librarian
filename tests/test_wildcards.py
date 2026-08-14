"""Tests for ``prompt_librarian.wildcards``.

Determinism, nesting, weights, pick-N, escapes, and — the ones that matter for
not hanging a render worker — the path-traversal guard, the cycle guard and
the output-size guard.
"""

import os

import pytest

from prompt_librarian import wildcards as wc

# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture
def wcdir(tmp_path):
    root = tmp_path / "wildcards"
    root.mkdir()
    return root


@pytest.fixture
def files(wcdir):
    return wc.WildcardFiles(str(wcdir))


def write(root, name, *lines):
    path = root / (name + ".txt")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def resolve(text, seed=0, files=None, snippets=None):
    return wc.resolve(text, seed, files=files, snippets=snippets or {})


# --------------------------------------------------------------------------- #
# Determinism
# --------------------------------------------------------------------------- #

BIG = "{" + "|".join(f"opt{i:02d}" for i in range(40)) + "}"
BIG5 = " ".join([BIG] * 5)


def test_same_seed_same_output(files):
    assert resolve(BIG5, 1234, files) == resolve(BIG5, 1234, files)


def test_different_seeds_differ_over_a_large_choice_set(files):
    outputs = {resolve(BIG5, seed, files) for seed in range(20)}
    # 40^5 possibilities: 20 seeds colliding would mean the seed is ignored.
    assert len(outputs) >= 18


def test_every_option_is_reachable(files):
    seen = {resolve("{a|b|c}", seed, files) for seed in range(60)}
    assert seen == {"a", "b", "c"}


def test_no_wildcards_is_a_passthrough(files):
    text = "make him dance ballet, drifting towards the camera"
    assert resolve(text, 7, files) == text


# --------------------------------------------------------------------------- #
# Choice syntax
# --------------------------------------------------------------------------- #

def test_nesting(files):
    seen = {resolve("{a|{b|c}}", seed, files) for seed in range(80)}
    assert seen == {"a", "b", "c"}


def test_deep_nesting(files):
    assert resolve("{{{{x}}}}", 0, files) == "x"


def test_weights_are_honoured_statistically(files):
    draws = [resolve("{9::heavy|light}", seed, files) for seed in range(2000)]
    share = draws.count("heavy") / float(len(draws))
    assert 0.85 <= share <= 0.95, share


def test_zero_weight_option_is_never_picked(files):
    draws = {resolve("{0::never|1::always}", seed, files) for seed in range(200)}
    assert draws == {"always"}


def test_pick_n_distinct(files):
    for seed in range(40):
        out = resolve("{2$$a|b|c}", seed, files)
        parts = out.split(", ")
        assert len(parts) == 2
        assert len(set(parts)) == 2
        assert set(parts) <= {"a", "b", "c"}


def test_pick_range(files):
    lengths = set()
    for seed in range(120):
        parts = resolve("{1-3$$a|b|c}", seed, files).split(", ")
        assert len(set(parts)) == len(parts)
        lengths.add(len(parts))
    assert lengths == {1, 2, 3}


def test_pick_n_clamps_to_available_options(files):
    assert sorted(resolve("{9$$a|b}", 3, files).split(", ")) == ["a", "b"]


def test_empty_brace(files):
    assert resolve("x{}y", 0, files) == "xy"


# --------------------------------------------------------------------------- #
# Escapes
# --------------------------------------------------------------------------- #

def test_escapes_survive(files):
    assert resolve(r"\{a\|b\}", 0, files) == "{a|b}"
    assert resolve(r"\_\_name\_\_", 0, files) == "__name__"
    assert resolve(r"\[\[snip\]\]", 0, files) == "[[snip]]"


def test_escaped_pipe_inside_a_choice(files):
    # The whole reason for the sentinel pass: `\|` must not split the options.
    assert resolve(r"{a\|b}", 0, files) == "a|b"


def test_escaped_brace_is_not_a_choice(files):
    out = resolve(r"\{a|b\}", 0, files)
    assert out == "{a|b}"


# --------------------------------------------------------------------------- #
# Wildcard files
# --------------------------------------------------------------------------- #

def test_file_lookup(wcdir, files):
    write(wcdir, "mood", "calm", "tense")
    seen = {resolve("__mood__", seed, files) for seed in range(40)}
    assert seen == {"calm", "tense"}


def test_subdirectory_lookup(wcdir, files):
    write(wcdir, "sub/dir/name", "deep")
    assert resolve("__sub/dir/name__", 0, files) == "deep"


def test_blank_and_comment_lines_are_skipped(wcdir, files):
    write(wcdir, "m", "# a comment", "", "   ", "only")
    assert resolve("__m__", 0, files) == "only"
    assert files.options("m") == ["only"]


def test_carriage_returns_are_stripped(wcdir, files):
    (wcdir / "crlf.txt").write_bytes(b"one\r\ntwo\r\n")
    assert files.options("crlf") == ["one", "two"]


def test_undecodable_bytes_are_replaced_not_raised(wcdir, files):
    (wcdir / "bad.txt").write_bytes(b"caf\xff")
    assert files.options("bad") == ["caf\ufffd"]


def test_missing_file_is_literal_and_reported(files):
    out = wc.resolve_verbose("a __nope__ b", 0, files=files, snippets={})
    assert out["text"] == "a __nope__ b"
    assert "__nope__" in out["missing"]


def test_file_contents_can_reference_choices(wcdir, files):
    write(wcdir, "chain", "{x|y}")
    assert resolve("__chain__", 0, files) in ("x", "y")


def test_names_lists_every_file(wcdir, files):
    write(wcdir, "b", "1")
    write(wcdir, "a", "1")
    write(wcdir, "nest/c", "1")
    assert files.names() == ["a", "b", "nest/c"]


def test_options_cache_follows_the_file(wcdir, files):
    write(wcdir, "m", "one")
    assert files.options("m") == ["one"]
    write(wcdir, "m", "one", "two")
    assert files.options("m") == ["one", "two"]


# --------------------------------------------------------------------------- #
# Path traversal
# --------------------------------------------------------------------------- #

def test_traversal_is_rejected_end_to_end(tmp_path, wcdir, files):
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET", encoding="utf-8")
    out = wc.resolve_verbose("__../secret__", 0, files=files, snippets={})
    assert "SECRET" not in out["text"]
    assert out["text"] == "__../secret__"
    assert "__../secret__" in out["missing"]


@pytest.mark.parametrize("name", [
    "../../../etc/passwd",
    "..",
    "a/../../b",
    "/etc/passwd",
    "//server/share/x",
    "C:/windows/system32/x",
    "C:\\windows\\x",
    "\\\\server\\share",
    "",
])
def test_unsafe_names_never_resolve_to_a_path(files, name):
    assert files.path_for(name) is None


def test_safe_names_resolve_inside_the_root(wcdir, files):
    path = files.path_for("sub/name")
    assert path is not None
    assert os.path.realpath(str(wcdir)) == os.path.commonpath(
        [os.path.realpath(str(wcdir)), path]
    )


def test_drive_letter_token_stays_literal(files):
    # `:` is not in the name character class, so it never even reaches the
    # filesystem guard -- belt and braces.
    assert resolve("__C:/windows/x__", 0, files) == "__C:/windows/x__"


# --------------------------------------------------------------------------- #
# Guards
# --------------------------------------------------------------------------- #

def test_self_referencing_file_terminates(wcdir, files):
    write(wcdir, "loop", "__loop__")
    out = wc.resolve_verbose("__loop__", 0, files=files, snippets={})
    assert out["text"] == "__loop__"
    assert out["warnings"]


def test_mutually_recursive_files_terminate(wcdir, files):
    write(wcdir, "ping", "__pong__")
    write(wcdir, "pong", "__ping__")
    out = wc.resolve_verbose("__ping__", 0, files=files, snippets={})
    assert "__" in out["text"]
    assert out["warnings"]


def test_recursive_snippet_terminates(files):
    out = wc.resolve_verbose("[[a]]", 0, files=files, snippets={"a": "[[a]]"})
    assert out["text"] == "[[a]]"
    assert out["warnings"]


def test_expansion_bomb_hits_max_output(wcdir, files, monkeypatch):
    monkeypatch.setattr(wc, "MAX_OUTPUT", 300)
    write(wcdir, "big", "x" * 200)
    out = wc.resolve_verbose("__big__ __big__ __big__", 0, files=files, snippets={})
    assert len(out["text"]) <= 300
    assert any("exceeded" in w for w in out["warnings"])
    # Last good text: the substitutions that fit landed, the rest stayed literal.
    assert "__big__" in out["text"]


def test_real_expansion_bomb_is_bounded(wcdir, files):
    write(wcdir, "huge", "y" * 50000)
    out = wc.resolve_verbose(" ".join(["__huge__"] * 6), 0, files=files, snippets={})
    assert len(out["text"]) <= wc.MAX_OUTPUT
    assert out["warnings"]


def test_pathological_nesting_does_not_hang(files):
    text = "{" * 40 + "a" + "}" * 40
    out = wc.resolve_verbose(text, 0, files=files, snippets={})
    assert out["warnings"]


# --------------------------------------------------------------------------- #
# Snippets
# --------------------------------------------------------------------------- #

def test_snippet_inlines(files):
    assert resolve("a [[cine]] b", 0, files, {"cine": "volumetric haze"}) == \
        "a volumetric haze b"


def test_snippet_store_shape(files):
    snippets = {"cine": {"body": "35mm", "updated": "x"}}
    assert resolve("[[cine]]", 0, files, snippets) == "35mm"


def test_missing_snippet_is_literal_and_reported(files):
    out = wc.resolve_verbose("[[nope]]", 0, files=files, snippets={})
    assert out["text"] == "[[nope]]"
    assert "[[nope]]" in out["missing"]


def test_snippet_can_contain_a_choice(files):
    assert resolve("[[c]]", 0, files, {"c": "{x|y}"}) in ("x", "y")


# --------------------------------------------------------------------------- #
# signature() / helpers
# --------------------------------------------------------------------------- #

def test_signature_changes_when_a_file_changes(wcdir, files):
    write(wcdir, "m", "one")
    before = files.dir_signature()
    write(wcdir, "m", "one", "two")
    assert files.dir_signature() != before


def test_signature_changes_when_a_file_is_added(wcdir, files):
    write(wcdir, "m", "one")
    before = files.dir_signature()
    write(wcdir, "n", "two")
    assert files.dir_signature() != before


def test_signature_is_stable_when_nothing_changes(wcdir, files):
    write(wcdir, "m", "one")
    assert files.dir_signature() == files.dir_signature()


def test_signature_of_a_missing_directory_is_stable(tmp_path):
    files = wc.WildcardFiles(str(tmp_path / "does-not-exist"))
    assert files.dir_signature() == files.dir_signature()
    assert files.names() == []


@pytest.mark.parametrize(("text", "expected"), [
    ("plain text", False),
    ("{a|b}", True),
    ("__mood__", True),
    ("[[snip]]", True),
    (r"\{a\|b\}", False),
    (r"\_\_mood\_\_", False),
    ("", False),
    (None, False),
])
def test_has_wildcards(text, expected):
    assert wc.has_wildcards(text) is expected


def test_referenced_names():
    assert wc.referenced_names("__a__ and __sub/b__") == {"a", "sub/b"}
    assert wc.referenced_names(r"\_\_a\_\_") == set()


def test_resolve_verbose_shape(wcdir, files):
    write(wcdir, "m", "calm")
    out = wc.resolve_verbose("{a|b} __m__", 3, files=files, snippets={})
    assert set(out) == {"text", "picks", "missing", "warnings"}
    kinds = {pick["kind"] for pick in out["picks"]}
    assert kinds == {"choice", "wildcard"}


def test_collect_is_filled_in(files):
    collect = {}
    wc.resolve("{a|b}", 0, files=files, snippets={}, collect=collect)
    assert collect["picks"] and collect["missing"] == [] and collect["warnings"] == []


def test_resolve_never_raises_on_junk(files):
    for text in ("{", "}", "{{", "|", "__", "[[", "]]", "{|||}", "{$$}", "{-1$$a}"):
        wc.resolve(text, 0, files=files, snippets={})


def test_none_text_is_empty(files):
    assert resolve(None, 0, files) == ""
