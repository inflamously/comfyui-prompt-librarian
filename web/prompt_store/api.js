/* Use api.fetchApi so ComfyUI and reverse-proxy URL prefixes are preserved.
 * These routes belong to the independent PromptLibrary node.
 */

import { api } from "../../../scripts/api.js";
import { EMPTY_LABEL } from "./labels.js";

/** Route prefix. Every route is `/prompt_library/<name>`. */
export const BASE = "/prompt_library/";

/**
 * The prompts stored under a category.
 * Returns [] on any failure — the combo showing nothing beats a thrown error
 * inside a LiteGraph widget callback.
 */
export async function fetchPrompts(category) {
    if (!category || category === EMPTY_LABEL) return [];
    try {
        const res = await api.fetchApi(
            BASE + "prompts?category=" + encodeURIComponent(category)
        );
        const data = await res.json();
        return Array.isArray(data.prompts) ? data.prompts : [];
    } catch (e) {
        console.error("[prompt-library] fetchPrompts failed", e);
        return [];
    }
}

/** Append `text` to `category`. Answers `{names, prompts}` (or `{error}`). */
export async function savePrompt(category, text) {
    const res = await api.fetchApi(BASE + "save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text }),
    });
    return res.json();
}

/** Remove one prompt from a category. Answers `{names, prompts}`. */
export async function deletePrompt(category, text) {
    const res = await api.fetchApi(BASE + "delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text }),
    });
    return res.json();
}
