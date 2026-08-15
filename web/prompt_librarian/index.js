/* ==========================================================================
   Prompt Librarian — extension entry
   --------------------------------------------------------------------------
   THIS IS THE ONLY FILE IN THIS DOMAIN ALLOWED TO HAVE IMPORT-TIME SIDE
   EFFECTS.

   ComfyUI imports every .js under WEB_DIRECTORY as an extension, so every
   module under web/prompt_librarian/ is loaded whether or not we ask for it —
   those files are inert by construction (exports and const data only). All the
   wiring lives here: one registerExtension call, one stylesheet, one node hook.

   Extension name is `prompt-librarian.ui`. The OLD node registers
   `prompt-library.ui` (web/prompt_store/) — different node class, different
   routes, different store, zero overlap. Deleting either domain directory must
   leave the other working, which is also why nothing here imports from
   web/prompt_store/.

   Feature layout under this directory, mirroring the Python side:

     shared/      h(), text/number formatting, timing, the singleton bag
     api/         transport: request primitive, lanes, caps, routes, meta cache
     node/        the node's own face, widgets, hydration and the ⇄ binding
     modal/       the overlay shell, state store, key isolation, layers
     browse/      the left rail: search, filters, virtualised list, bulk bar
     inspector/   the right pane: fields, dupe gate, the save flow
     pickers/     the popover primitive and its five consumers
     compare/     diff, compare/merge and version-history dialogs
   ========================================================================== */

import { app } from "../../../scripts/app.js";
import { NS } from "./shared/ns.js";
import { warnOnce, singleton } from "./shared/singleton.js";
import { ensureStyles } from "./shared/styles.js";
import { buildFace } from "./node/face.js";
import { ensureHydrated } from "./node/hydrate.js";

const NODE_CLASS = "PromptLibrarian";

/* --------------------------------------------------------------------------
   Host injection point.

   Other modules never import this file (that would re-run registerExtension
   under a second cache-busted URL). They read the host off the shared
   singleton bag instead. `app` is captured here, in the one place that is
   already coupled to ComfyUI's module layout.
   -------------------------------------------------------------------------- */
function host() {
  return singleton("host", () => ({ app: null }));
}

/* --------------------------------------------------------------------------
   Modal
   -------------------------------------------------------------------------- */

/**
 * Open the librarian for a node. `modal/index.js` is imported LAZILY and
 * inside a try/catch: the extension must load and the node must work without
 * it. A missing modal logs once and no-ops; it never throws into LiteGraph's
 * event handling.
 */
async function openLibrarian(node) {
  ensureStyles();
  ensureHydrated(node); // third and final hydration trigger
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

/* --------------------------------------------------------------------------
   Registration — the one and only side effect in this domain
   -------------------------------------------------------------------------- */

app.registerExtension({
  name: "prompt-librarian.ui",

  setup() {
    host().app = app;
    // Injected here, not at import time: the document head is guaranteed
    // ready by setup(), and a stylesheet request during module evaluation
    // competes with ComfyUI's own boot.
    ensureStyles();
  },

  nodeCreated(node) {
    if (!node || node.comfyClass !== NODE_CLASS) return;

    // Try the richer DOM card first; fall back to the proven button face.
    // buildFace() may still fall back asynchronously (post-rAF mount
    // verification), which it handles itself.
    buildFace(node, openLibrarian);

    // `Open Librarian` exists in BOTH tiers — it is the primary affordance and
    // must never depend on the DOM card having rendered correctly. Added here
    // rather than inside either face builder so exactly one is ever created.
    if (!node.__plOpenBtn) {
      node.__plOpenBtn = node.addWidget("button", "Open Librarian", null, () =>
        openLibrarian(node),
      );
      if (node.__plOpenBtn) node.__plOpenBtn.serialize = false;
    }

    // Trigger 1: next frame. Trigger 2: the 500 ms the old node proved.
    // Trigger 3 is the first modal open, inside openLibrarian().
    if (!ensureHydrated(node)) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => ensureHydrated(node));
      }
      setTimeout(() => ensureHydrated(node), 500);
    }
  },
});

console.debug(`${NS} librarian ui registered`);
