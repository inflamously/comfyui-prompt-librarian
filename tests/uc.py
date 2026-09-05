"""Every use-case, constant and error under one name, so tests call features directly.

This is an import list, not a facade: no state, no behaviour of its own.
"""
# ruff: noqa: F401 - every import is a re-export

from prompt_librarian.app import (
    App,
    build,
    compact,
    legacy_sources,
    migrate_legacy,
    storage_status,
)
from prompt_librarian.features.autocomplete.suggest import suggest
from prompt_librarian.features.library.ignored import (
    ignore_pair,
    ignored_pairs,
    is_ignored,
    unignore_pair,
)
from prompt_librarian.features.library.settings import read_settings, update_settings
from prompt_librarian.features.library.snippets import (
    delete_snippet,
    get_snippet,
    list_snippets,
    set_snippet,
)
from prompt_librarian.features.library.taxonomy import tag_counts, taxonomy
from prompt_librarian.features.prompts.bulk import bulk_delete, bulk_merge, bulk_retag
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.prompts.delete import delete_prompt
from prompt_librarian.features.prompts.get import (
    all_prompts,
    count_prompts,
    get_prompt,
    get_prompts,
    prompt_ids,
)
from prompt_librarian.features.prompts.merge import merge_into_new, merge_prompts
from prompt_librarian.features.prompts.update import rate_prompt, update_prompt
from prompt_librarian.features.prompts.usage import record_usage
from prompt_librarian.features.prompts.versions import (
    get_version,
    list_versions,
    restore_version,
    version_previews,
)
from prompt_librarian.features.storage.export import export_library, export_metadata
from prompt_librarian.features.storage.importing import import_library
from prompt_librarian.shared.db.schema import SCHEMA_VERSION
from prompt_librarian.shared.errors import (
    BodyTooLargeError,
    ConflictError,
    NotFoundError,
    ReadOnlyError,
    SameRecordError,
    StoreError,
    StoreWriteError,
)
from prompt_librarian.shared.meta import DEFAULT_DUPE_THRESHOLD, MAX_SNIPPET_NAME_CHARS
from prompt_librarian.shared.records import (
    MAX_BODY_CHARS,
    MAX_TAG_CHARS,
    MAX_TAGS,
    MERGE_VERSIONS_KEPT,
    VERSION_BYTES_CAP,
    VERSION_CAP,
)
