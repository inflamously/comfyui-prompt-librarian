"""Register two independent node domains, their web extensions, and routes."""

from .prompt_store import (
    EMPTY_LABEL,
    PromptLibrary,
    _add_prompt,
    _category_names,
    _load_prompts,
    _save_prompts,
)

from .prompt_librarian import PromptLibrarian

NODE_CLASS_MAPPINGS = {
    "PromptLibrary": PromptLibrary,
    "PromptLibrarian": PromptLibrarian,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptLibrary": "Prompt Library",
    "PromptLibrarian": "Prompt Librarian",
}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# Guarded so importing the package never crashes a headless / CLI ComfyUI start.
try:
    from aiohttp import web
    from server import PromptServer

    if hasattr(PromptServer, "instance") and PromptServer.instance is not None:
        routes = PromptServer.instance.routes

        @routes.get("/prompt_library/list")
        async def prompt_library_list(request):
            return web.json_response({"names": _category_names()})

        @routes.get("/prompt_library/prompts")
        async def prompt_library_prompts(request):
            category = request.rel_url.query.get("category", "")
            prompts = _load_prompts().get(category, [])
            return web.json_response({"prompts": prompts})

        @routes.post("/prompt_library/save")
        async def prompt_library_save(request):
            data = await request.json()
            category = (data.get("category") or "").strip()
            text = data.get("text", "")
            if not category or category == EMPTY_LABEL:
                return web.json_response(
                    {"error": "A non-empty category is required."}, status=400
                )
            prompts = _add_prompt(category, text)
            return web.json_response(
                {"names": _category_names(), "prompts": prompts}
            )

        @routes.post("/prompt_library/delete")
        async def prompt_library_delete(request):
            data = await request.json()
            category = (data.get("category") or "").strip()
            text = data.get("text", "")
            prompts = _load_prompts()
            lst = prompts.get(category)
            if lst is not None and text in lst:
                lst.remove(text)
                if not lst:
                    del prompts[category]
                _save_prompts(prompts)
            remaining = prompts.get(category, [])
            return web.json_response(
                {"names": _category_names(), "prompts": remaining}
            )
except Exception as exc:  # pragma: no cover - defensive, mirrors KJNodes pattern
    print(f"[comfyui-prompt-library] route registration skipped: {exc}")


# Keep route registration guards independent so either node survives the other
# stack failing to import.
try:
    from server import PromptServer as _PromptServer

    if getattr(_PromptServer, "instance", None) is not None:
        from .prompt_librarian import api as _librarian_api

        _librarian_api.register(_PromptServer.instance.routes)
except Exception as exc:  # pragma: no cover - defensive
    print(f"[prompt-librarian] route registration skipped: {exc}")
