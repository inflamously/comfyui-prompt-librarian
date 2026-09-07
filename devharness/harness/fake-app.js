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
  // Passed as the second argument to every widget callback in node/bind.js, so
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

  registerExtension(ext) {
    this._exts.push(ext);
    window.dispatchEvent(new CustomEvent("dev:ext", { detail: { name: ext && ext.name } }));
    return ext;
  },

  /* -- harness-only controls (never present in real ComfyUI) --------------- */
  __dev: {
    nodes,
    addNode(node) {
      nodes.push(node);
      return node;
    },
    removeNode(node) {
      const i = nodes.indexOf(node);
      if (i >= 0) nodes.splice(i, 1);
      // hydrate.js chains onRemoved; if the harness does not call it, a binder
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
