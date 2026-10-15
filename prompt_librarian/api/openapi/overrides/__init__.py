"""Per route group, operations whose wire format is not the plain JSON their Spec implies."""

from . import library, word_images

_GROUPS = (library, word_images)

REQUEST_BODIES = {op: build for group in _GROUPS
                  for op, build in getattr(group, "REQUEST_BODIES", {}).items()}

SUCCESS = {op: build for group in _GROUPS
           for op, build in getattr(group, "SUCCESS", {}).items()}
