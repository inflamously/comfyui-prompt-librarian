/* ComfyUI loads every .js under web/, including unreferenced modules.
 * Keep other modules inert on import; register hooks only in this entry.
 * The caps/lanes singleton allocations are the tested exceptions.
 * This domain must remain independent of prompt_store/.
 */

import { app } from "../../../scripts/app.js";
import { NS } from "./shared/ns.js";
import { warnOnce, singleton } from "./shared/singleton.js";
import { ensureStyles } from "./shared/styles.js";
import { buildFace } from "./node/face.js";
import { ensureHydrated } from "./node/hydrate.js";

const NODE_CLASS = "PromptLibrarian";

/* Share the host bag instead of importing this entry again under another URL.
 */
function host() {
  return singleton("host", () => ({ app: null }));
}


/** Load the modal defensively so its failure cannot break the node.
 */
async function openLibrarian(node) {
  ensureStyles();
  ensureHydrated(node);
  try {
    const modal = await import("./modal/index.js");
    if (typeof modal.setHost === "function") modal.setHost({ app });
    if (typeof modal.openModal !== "function") throw new Error("openModal missing");
    await modal.openModal({ targetNodeId: node ? node.id : null });
  } catch (err) {
    warnOnce(
      "modal-missing",
      "the librarian panel could not be opened (web/prompt_librarian/modal/). The node still works: `text` is the prompt and is saved with the workflow.",
      err && err.message
    );
  }
}


app.registerExtension({
  name: "prompt-librarian.ui",

  setup() {
    host().app = app;
    // Inject styles during setup, when the document head is ready.
    ensureStyles();
  },

  nodeCreated(node) {
    if (!node || node.comfyClass !== NODE_CLASS) return;

    buildFace(node, openLibrarian);

    // Add Open Librarian independently of the face so either rendering tier has it.
    if (!node.__plOpenBtn) {
      node.__plOpenBtn = node.addWidget("button", "Open Librarian", null, () =>
        openLibrarian(node),
      );
      if (node.__plOpenBtn) node.__plOpenBtn.serialize = false;
    }

    // Retry after widget wiring; first modal open provides a later backstop.
    if (!ensureHydrated(node)) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => ensureHydrated(node));
      }
      setTimeout(() => ensureHydrated(node), 500);
    }
  },
});

console.debug(`${NS} librarian ui registered`);
