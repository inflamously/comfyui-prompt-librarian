"""Library locations resolve under the user directory, never a hard-coded one."""

from prompt_librarian.shared import paths


def test_paths_resolve_under_the_user_directory(user_dir):
    assert paths.user_dir() == str(user_dir)
    root = user_dir / "default" / "prompt-librarian"
    assert paths.database_path() == str(root / "library.sqlite3")
    assert paths.wildcards_dir() == str(root / "wildcards")
