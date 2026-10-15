"""Pack entry: the node; the API is imported behind its own guard so it cannot block loading."""

from .node import PromptLibrarian

__all__ = ["PromptLibrarian"]
