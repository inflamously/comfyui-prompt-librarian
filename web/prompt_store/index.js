/* ComfyUI loads every web module; only extension entries may register hooks.
 * This node stays independent of prompt_librarian/.
 */

import { app } from "../../../scripts/app.js";
import { deletePrompt, fetchPrompts, savePrompt } from "./api.js";
import { EMPTY_LABEL, makeLabels } from "./labels.js";
import { setComboValues } from "./widgets.js";

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

        // Do NOT call origCatCb — ComfyUI's internal combo callback
        // resets widget state and fights our async update.
        categoryW.callback = function(value) {
            nameW.value = value === EMPTY_LABEL ? "" : value;
            loadAndApply(value);
        };

        node.addWidget("button", "Load", null, async () => {
            const cat = (categoryW.value || "").trim();
            const wantedLabel = promptW.value;
            await loadAndApply(cat);
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
                const data = await savePrompt(category, textW.value);
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
                const data = await deletePrompt(category, textW.value);
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
