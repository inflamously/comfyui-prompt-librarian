import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Frontend for the PromptLibrary node.
// category combo auto-loads prompt list on change.
// Load button is the reliable fallback for filling the text box.
// The `text` widget is the real payload sent to Python.

const EMPTY_LABEL = "<empty>";
const MAX_LABEL = 50;

function truncate(t) {
    const s = (t || "").replace(/\s+/g, " ").trim();
    if (!s) return "(empty)";
    return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) + "…" : s;
}

function makeLabels(texts) {
    const tokenize = t => (t || "").trim().split(/\s+/).filter(Boolean);
    const tokens = texts.map(tokenize);

    let prefixLen = 0, suffixLen = 0;
    if (tokens.length > 1) {
        const minLen = Math.min(...tokens.map(t => t.length));
        while (prefixLen < minLen && tokens.every(t => t[prefixLen] === tokens[0][prefixLen]))
            prefixLen++;
        const suffixMax = minLen - prefixLen;
        while (suffixLen < suffixMax && tokens.every(t => t[t.length - 1 - suffixLen] === tokens[0][tokens[0].length - 1 - suffixLen]))
            suffixLen++;
    }

    const avgLen = tokens.reduce((s, t) => s + t.length, 0) / (tokens.length || 1);
    const useDiff = tokens.length > 1 && avgLen > 0 && (prefixLen + suffixLen) / avgLen > 0.3;

    const seen = {};
    return texts.map((t, i) => {
        let label;
        if (useDiff) {
            const tok = tokens[i];
            const end = suffixLen > 0 ? tok.length - suffixLen : tok.length;
            const unique = tok.slice(prefixLen, end);
            const s = unique.join(" ");
            if (!s) label = "(base)";
            else label = (prefixLen > 0 ? "…" : "") + truncate(s) + (suffixLen > 0 ? "…" : "");
        } else {
            label = truncate(t);
        }
        if (seen[label]) { seen[label] += 1; label = `${label} (${seen[label]})`; }
        else seen[label] = 1;
        return label;
    });
}

// Update a combo widget's option list. Handles both LiteGraph (options IS the
// array) and the newer ComfyUI Vue frontend (options.values, needs reassignment
// not splice for reactivity).
function setComboValues(widget, values) {
    if (!widget) return;
    const list = values && values.length ? values : [EMPTY_LABEL];
    if (Array.isArray(widget.options)) {
        // LiteGraph legacy: options is the values array directly
        widget.options.splice(0, Infinity, ...list);
    } else {
        if (!widget.options) widget.options = {};
        // Direct assignment (not splice) to trigger Vue reactivity if present
        widget.options.values = list.slice();
    }
    if (!list.includes(widget.value)) widget.value = list[0];
}

app.registerExtension({
    name: "prompt-library.ui",

    nodeCreated(node) {
        if (node.comfyClass !== "PromptLibrary") return;

        const categoryW = node.widgets?.find((w) => w.name === "category");
        const nameW    = node.widgets?.find((w) => w.name === "category_name");
        const promptW  = node.widgets?.find((w) => w.name === "prompt");
        const textW    = node.widgets?.find((w) => w.name === "text");
        if (!categoryW || !nameW || !promptW || !textW) return;

        // label -> full text map for the currently loaded category
        const promptMap = new Map();

        async function fetchPrompts(category) {
            if (!category || category === EMPTY_LABEL) return [];
            try {
                const res = await api.fetchApi(
                    "/prompt_library/prompts?category=" + encodeURIComponent(category)
                );
                const data = await res.json();
                return Array.isArray(data.prompts) ? data.prompts : [];
            } catch (e) {
                console.error("[prompt-library] fetchPrompts failed", e);
                return [];
            }
        }

        function applyPrompts(texts, selectText) {
            const labels = texts.length ? makeLabels(texts) : [EMPTY_LABEL];
            setComboValues(promptW, labels);
            promptMap.clear();
            texts.forEach((t, i) => promptMap.set(labels[i], t));
            if (selectText != null && texts.includes(selectText)) {
                promptW.value = labels[texts.indexOf(selectText)];
            } else if (!promptMap.has(promptW.value)) {
                promptW.value = labels[0];
            }
            promptW.tooltip = promptMap.get(promptW.value) ?? "";
            node.setDirtyCanvas(true, true);
        }

        async function loadAndApply(category, selectText) {
            const texts = await fetchPrompts(category);
            applyPrompts(texts, selectText);
        }

        // Auto-load prompt list when category changes.
        // Do NOT call origCatCb — ComfyUI's internal combo callback
        // resets widget state and fights our async update.
        categoryW.callback = function(value) {
            nameW.value = value === EMPTY_LABEL ? "" : value;
            loadAndApply(value);
        };

        // Load: reliable fallback — re-fetches and fills text box from selection.
        node.addWidget("button", "Load", null, async () => {
            const cat = (categoryW.value || "").trim();
            const wantedLabel = promptW.value;
            await loadAndApply(cat);
            // Restore prior label if it survived the refresh
            if (promptMap.has(wantedLabel)) promptW.value = wantedLabel;
            const full = promptMap.get(promptW.value);
            if (full != null) textW.value = full;
            promptW.tooltip = promptMap.get(promptW.value) ?? "";
            nameW.value = cat === EMPTY_LABEL ? "" : cat;
            node.setDirtyCanvas(true, true);
        });

        node.addWidget("button", "Save", null, async () => {
            const category = (nameW.value || categoryW.value || "").trim();
            if (!category || category === EMPTY_LABEL) {
                alert("Enter a category in the 'category_name' field before saving.");
                return;
            }
            try {
                const res = await api.fetchApi("/prompt_library/save", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ category, text: textW.value }),
                });
                const data = await res.json();
                if (data.error) { alert(data.error); return; }
                setComboValues(categoryW, data.names);
                categoryW.value = category;
                nameW.value = category;
                applyPrompts(Array.isArray(data.prompts) ? data.prompts : [], textW.value);
            } catch (e) {
                console.error("[prompt-library] save failed", e);
            }
        });

        node.addWidget("button", "Delete", null, async () => {
            const category = (categoryW.value || "").trim();
            if (!category || category === EMPTY_LABEL) return;
            try {
                const res = await api.fetchApi("/prompt_library/delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ category, text: textW.value }),
                });
                const data = await res.json();
                setComboValues(categoryW, data.names);
                const remaining = Array.isArray(data.prompts) ? data.prompts : [];
                applyPrompts(remaining);
                if (remaining.length) {
                    const full = promptMap.get(promptW.value);
                    if (full != null) textW.value = full;
                }
                node.setDirtyCanvas(true, true);
            } catch (e) {
                console.error("[prompt-library] delete failed", e);
            }
        });

        // Defer initial load: nodeCreated fires during graph init before
        // ComfyUI finishes wiring widget option references.
        setTimeout(() => loadAndApply(categoryW.value), 500);
    },
});
