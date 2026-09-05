"""The dev tool: scenarios replay cleanly, and scratch paths stay scratch."""

import subprocess
import sys
from pathlib import Path

import pytest

from scripts.devkit import server

_ROOT = Path(__file__).resolve().parents[1]


def _dev(*args):
    return subprocess.run(
        [sys.executable, str(_ROOT / "scripts" / "dev.py"), *args],
        cwd=_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )


def test_every_scenario_matches_the_committed_baseline():
    result = _dev("sim")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "sim OK" in result.stdout


def test_an_unknown_mode_prints_usage_instead_of_guessing():
    result = _dev("serve")
    assert result.returncode == 2
    assert "dev.py sim" in result.stdout


def test_fresh_dir_wipes_only_what_it_created(tmp_path):
    made = server.fresh_dir(str(tmp_path / "run"), root=str(tmp_path))
    (Path(made) / "library.sqlite3").write_text("scratch")

    again = server.fresh_dir(made, root=str(tmp_path))
    assert not (Path(again) / "library.sqlite3").exists()

    foreign = tmp_path / "foreign"
    foreign.mkdir()
    with pytest.raises(SystemExit):
        server.fresh_dir(str(foreign), root=str(tmp_path))
    assert foreign.exists()


@pytest.mark.parametrize(
    "path",
    [
        "elsewhere/library.sqlite3",
        "user/default/prompt-librarian/library.sqlite3",
    ],
)
def test_guard_refuses_real_or_outside_libraries(tmp_path, path):
    root = tmp_path / "scratch"
    target = (tmp_path / path) if path.startswith("elsewhere") else (root / path)
    with pytest.raises(SystemExit):
        server.guard_scratch(str(target), root=str(root))


# --------------------------------------------------------------------------- #
# Word pictures: placeholder renders standing in for ComfyUI
# --------------------------------------------------------------------------- #


def _librarian_prompt(text="red fox", output="PreviewImage"):
    return {
        "6": {"class_type": "PromptLibrarian", "inputs": {"text": text}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 320, "height": 512}},
        "9": {"class_type": output, "inputs": {"images": ["8", 0]}},
    }


def test_a_word_always_renders_the_same_placeholder():
    pytest.importorskip("PIL")
    from scripts.devkit import pictures

    first, again = pictures.render_word("fog", 96, 64), pictures.render_word("fog", 96, 64)
    assert first.size == (96, 64)
    assert first.tobytes() == again.tobytes()
    assert first.tobytes() != pictures.render_word("rain", 96, 64).tobytes()


def test_a_queued_word_prompt_renders_into_the_folder_its_output_node_names(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image

    from scripts.devkit import pictures

    dirs = pictures.comfy_dirs(str(tmp_path))
    outputs = pictures.run_prompt(_librarian_prompt(), dirs)
    [ref] = outputs["9"]["images"]
    assert ref["type"] == "temp"
    with Image.open(Path(dirs["temp"]) / ref["filename"]) as image:
        assert image.size == (320, 512), "the latent's size, as ComfyUI would render it"

    saved = pictures.run_prompt(_librarian_prompt(output="SaveImage"), dirs)
    assert saved["9"]["images"][0]["type"] == "output"


@pytest.mark.parametrize(
    "prompt",
    [{}, _librarian_prompt(output="VAEDecode"), {"6": {"class_type": "PromptLibrarian",
                                                       "inputs": {"text": ["3", 0]}}}],
    ids=["empty", "no-image-output", "wired-text"],
)
def test_a_prompt_comfyui_would_reject_is_rejected(tmp_path, prompt):
    pytest.importorskip("PIL")
    from scripts.devkit import pictures

    with pytest.raises(ValueError):
        pictures.run_prompt(prompt, pictures.comfy_dirs(str(tmp_path)))


def test_seeding_pictures_goes_through_the_real_use_case(tmp_path):
    pytest.importorskip("PIL")
    from prompt_librarian import app
    from prompt_librarian.features.prompts.create import create_prompt
    from prompt_librarian.features.word_images import list_word_images
    from scripts.devkit import pictures

    dev_app = app.build(path=str(tmp_path / "lib" / "library.sqlite3"), migrate_from=False)
    try:
        create_prompt(dev_app.lib, body="red fox in fog, lantern, harbour at night", tags=[])
        words, total = app.word_picture_candidates(dev_app)
        made = pictures.seed_pictures(dev_app, leave=2)
        stored = list_word_images(app.word_images_dir(dev_app))
        _left, left_total = app.word_picture_candidates(dev_app)
    finally:
        dev_app.lib.close()
    assert total > 2
    assert made == total - 2
    assert set(stored) == {w.lower() for w in words[:-2]}, "the most used words get pictures"
    assert left_total == 2, "the least used are left for the generator"
    assert {entry["source"] for entry in stored.values()} == {"generated"}
    assert [p.name for p in (tmp_path / "lib").iterdir() if p.is_dir()] == ["word-images"], (
        "the source renders are temporary"
    )
