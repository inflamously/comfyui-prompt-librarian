"""Test bootstrap for the Prompt Librarian modules.

ComfyUI is not importable here, so a stub ``folder_paths`` module is injected
into ``sys.modules`` *before* ``prompt_librarian.store`` is imported. The stub
points ``get_user_directory()`` at a throwaway temp directory, and the autouse
``user_dir`` fixture repoints it at each test's ``tmp_path``. Between that and
the explicit ``path=`` override every store fixture uses, no test can reach a
real ComfyUI user directory — and in particular nothing here ever reads the old
node's ``prompts.json``.

This conftest also puts the pack root on ``sys.path``, so any other test module
here can simply ``from prompt_librarian import search`` / ``dedupe`` / ... at
module level and get the same stubbed environment.
"""

import os
import sys
import tempfile
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# `tests` is a package inside a package (the pack's own `__init__.py`), so pytest
# walks up and imports the pack root — which does `from .prompt_store import ...`
# and needs ComfyUI. Stand a namespace shim in its place: `tests.*` still
# resolves, the pack's `__init__` never executes, and nothing here depends on it.
for _name in (os.path.basename(_ROOT), "__init__"):
    if _name not in sys.modules:
        _shim = types.ModuleType(_name)
        _shim.__path__ = [_ROOT]
        _shim.__file__ = os.path.join(_ROOT, "__init__.py")
        sys.modules[_name] = _shim

# Injected before the import below; a real ComfyUI folder_paths must never win.
_STUB_USER_DIR = tempfile.mkdtemp(prefix="pl-test-user-")
_STUB = types.ModuleType("folder_paths")
_STUB.get_user_directory = lambda: _STUB_USER_DIR
_STUB.__pl_test_stub__ = True
sys.modules["folder_paths"] = _STUB

from prompt_librarian import store as librarian_store  # noqa: E402  (follows the stub)
from prompt_librarian.store import utils as store_utils  # noqa: E402


@pytest.fixture
def mod():
    """The module under test."""
    return librarian_store


@pytest.fixture(autouse=True)
def user_dir(tmp_path, monkeypatch):
    """Point both the stub and the headless fallback at this test's tmp_path."""
    target = tmp_path / "user"
    target.mkdir()
    monkeypatch.setattr(_STUB, "get_user_directory", lambda: str(target))
    # The fallback lives on the leaf module now that `store` is a package;
    # patching the facade would leave `utils.user_dir()` reading the real one.
    monkeypatch.setattr(store_utils, "_FALLBACK_USER_DIR", str(target))
    return target


@pytest.fixture
def lib_path(tmp_path):
    """Explicit library path for the store fixtures (parent does not exist yet)."""
    return str(tmp_path / "lib" / "library.sqlite3")


@pytest.fixture
def store(lib_path):
    """A store pointed at an empty temp directory."""
    return librarian_store.LibrarianStore(path=lib_path, migrate_from=False)


@pytest.fixture
def fresh(lib_path):
    """Factory for extra store instances over the same file (reload testing)."""

    def _make():
        return librarian_store.LibrarianStore(path=lib_path, migrate_from=False)

    return _make
