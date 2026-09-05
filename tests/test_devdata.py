"""The dev playground dataset is synthetic and always uses a temp store."""

from prompt_librarian.features import dupes as dedupe
from scripts.devkit.data import DEFAULT_PROMPT_COUNT, SHOWCASE_PROMPTS, prompt_seeds
from scripts.devkit.server import seed
from tests import uc


def test_showcase_has_fifty_varied_well_formed_prompts():
    assert DEFAULT_PROMPT_COUNT == 50
    assert len(SHOWCASE_PROMPTS) == DEFAULT_PROMPT_COUNT
    assert len({item.key for item in SHOWCASE_PROMPTS}) == DEFAULT_PROMPT_COUNT
    assert len({item.body for item in SHOWCASE_PROMPTS}) == DEFAULT_PROMPT_COUNT
    assert all(len(item.body) >= 100 for item in SHOWCASE_PROMPTS)
    assert all(item.tags for item in SHOWCASE_PROMPTS)
    assert len({tag for item in SHOWCASE_PROMPTS for tag in item.tags}) >= 40


def test_prompt_seeds_honours_small_and_large_counts():
    assert prompt_seeds(0) == []
    assert len(prompt_seeds(12)) == 12
    assert len(prompt_seeds(75)) == 75
    assert len({item.body for item in prompt_seeds(75)}) == 75


def test_seed_populates_the_showcase_features(store):
    seed(store, DEFAULT_PROMPT_COUNT)

    records = uc.all_prompts(store.lib)
    assert len(records) == DEFAULT_PROMPT_COUNT
    assert {item["rating"] for item in records} == {0, 1, 2, 3, 4, 5}
    assert any(item["pinned"] for item in records)
    assert any(item["used"] >= 30 for item in records)
    assert sorted(len(item["versions"]) for item in records)[-2:] == [2, 50]
    assert len(uc.list_snippets(store.lib)) == 4
    assert len(uc.ignored_pairs(store.lib)) == 1
    assert len(dedupe.dupe_counts(store.dupe_source, 0.9, exhaustive=True)["groups"]) == 2
