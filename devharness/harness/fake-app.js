/* ==========================================================================
   The fake ComfyUI `app`, `graph` and `canvas`.

   modal/target/nodes.js probes the graph FOUR different ways, in order, because
   ComfyUI's frontend has changed shape more than once:

       graph._nodes            (array)
       graph.nodes             (array)
       graph.findNodesByType() (function)
       graph.getNodeById()     (function, used by resolveTarget)

   Only one of those is exercised on any given install, so the fallbacks are
   normally dead code that nobody ever runs. `graphMode` makes each reachable on
   demand — that is the point of the harness, not a nicety.
   ========================================================================== */

const nodes = [];

/** Node classes, as LiteGraph keeps them: one constructor per type, so a hook
 * on its prototype (beforeRegisterNodeDef) reaches every node of that type. */
const nodeTypes = new Map();
function nodeType(name) {
  if (!nodeTypes.has(name)) {
    const type = function () {};
    Object.defineProperty(type, "name", { value: name });
    type.comfyClass = name;
    nodeTypes.set(name, type);
  }
  return nodeTypes.get(name);
}

/** Widgets the Librarian node sends to the backend; keep in step with node.py. */
const LIBRARIAN_INPUTS = ["text", "prompt_id", "seed", "resolve_wildcards", "track_usage"];

/**
 * The API-format prompt for the fake canvas. Each Librarian node gets the
 * smallest txt2img chain around it (checkpoint, encode, latent, sampler,
 * decode, save), so the word-picture generator has a workflow to template.
 */
function promptFor(node) {
  const id = String(node.id);
  const inputs = {};
  for (const w of node.widgets || []) {
    if (LIBRARIAN_INPUTS.includes(w.name)) inputs[w.name] = w.value;
  }
  const at = (n) => `${id}.${n}`;
  return {
    [id]: { class_type: "PromptLibrarian", inputs },
    [at(1)]: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "dev-placeholder.safetensors" } },
    [at(2)]: { class_type: "CLIPTextEncode", inputs: { text: [id, 0], clip: [at(1), 1] } },
    [at(3)]: { class_type: "CLIPTextEncode", inputs: { text: "", clip: [at(1), 1] } },
    [at(4)]: { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 4 } },
    [at(5)]: {
      class_type: "KSampler",
      inputs: { model: [at(1), 0], positive: [at(2), 0], negative: [at(3), 0], latent_image: [at(4), 0], seed: 0, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 },
    },
    [at(6)]: { class_type: "VAEDecode", inputs: { samples: [at(5), 0], vae: [at(1), 2] } },
    [at(7)]: { class_type: "SaveImage", inputs: { images: [at(6), 0], filename_prefix: "ComfyUI" } },
  };
}

const out = (msg, cls = "") =>
  window.dispatchEvent(new CustomEvent("dev:log", { detail: { msg, cls } }));

/** "all" exposes every probe; the others expose exactly one. */
let graphMode = "all";
/** When true, findNodesByType/getNodeById throw — both have a try/catch. */
let hostile = false;

function assertNotHostile(what) {
  if (hostile) throw new Error(`fake graph: ${what} is throwing (hostile mode)`);
}

const graph = {
  get _nodes() {
    return graphMode === "all" || graphMode === "_nodes" ? nodes : undefined;
  },
  get nodes() {
    return graphMode === "nodes" ? nodes : undefined;
  },
  get findNodesByType() {
    if (graphMode !== "all" && graphMode !== "findNodesByType") return undefined;
    return (type) => {
      assertNotHostile("findNodesByType");
      return nodes.filter((n) => n.type === type || n.comfyClass === type);
    };
  },
  get getNodeById() {
    if (graphMode !== "all" && graphMode !== "getNodeById") return undefined;
    return (id) => {
      assertNotHostile("getNodeById");
      return nodes.find((n) => String(n.id) === String(id)) || null;
    };
  },
};

const canvas = {
  // Passed as the second argument to every widget callback in node/text-sync.js, so
  // it must be a stable object rather than undefined.
  selectNode(node) {
    window.dispatchEvent(new CustomEvent("dev:select", { detail: { id: node && node.id } }));
  },
  setDirty() {},
  draw() {},
};

export const app = {
  _exts: [],
  graph,
  canvas,

  /** ComfyUI's "queue" serialisation; only `output` (the API format) is used. */
  async graphToPrompt() {
    const output = {};
    for (const node of nodes) {
      if (node.comfyClass === "PromptLibrarian") Object.assign(output, promptFor(node));
    }
    return { workflow: { nodes: nodes.map((n) => ({ id: n.id, type: n.type })) }, output };
  },

  /** The newer frontend's toasts and dialogs. Toasts land in the console panel. */
  extensionManager: {
    toast: {
      add({ severity = "info", summary = "", detail = "" } = {}) {
        const cls = { error: "err", warn: "warn", success: "ok" }[severity] || "";
        out(`toast [${severity}] ${summary}${detail ? ": " + detail : ""}`, cls);
      },
    },
    dialog: {
      async confirm({ title = "", message = "" } = {}) {
        return window.confirm(`${title}\n\n${message}`);
      },
      async prompt({ title = "", message = "", defaultValue = "" } = {}) {
        return window.prompt(`${title}\n\n${message}`, defaultValue);
      },
    },
  },

  registerExtension(ext) {
    this._exts.push(ext);
    window.dispatchEvent(new CustomEvent("dev:ext", { detail: { name: ext && ext.name } }));
    return ext;
  },

  /* -- harness-only controls (never present in real ComfyUI) --------------- */
  __dev: {
    nodes,
    nodeType,
    nodeTypes,
    addNode(node) {
      nodes.push(node);
      return node;
    },
    removeNode(node) {
      const i = nodes.indexOf(node);
      if (i >= 0) nodes.splice(i, 1);
      // setup.js chains onRemoved; if the harness does not call it, a watcher
      // leak is invisible.
      if (node && typeof node.onRemoved === "function") node.onRemoved();
    },
    setGraphMode(mode) {
      graphMode = mode;
    },
    getGraphMode: () => graphMode,
    setHostile(on) {
      hostile = !!on;
    },
  },
};
