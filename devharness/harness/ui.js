/* ==========================================================================
   Harness chrome: the controls, the console mirror and the network log.

   The console mirror matters more than it looks. warnOnce() is this pack's
   primary diagnostic channel ("your frontend lacks X"), and those messages are
   trivially lost in a browser console you are not looking at. Here they are on
   screen, next to the thing that produced them.
   ========================================================================== */

import { app } from "./fake-app.js";
import { loadPack, setupExtensions, createNode, removeNode, watchForReload } from "./boot.js";

const $ = (id) => document.getElementById(id);
const DEV = window.__DEV__;

/* -- panels --------------------------------------------------------------- */

function row(listId, text, cls) {
  const list = $(listId);
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.textContent = text;
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
  while (list.children.length > 500) list.removeChild(list.firstChild);
}

window.addEventListener("dev:log", (e) => row("dev-log", e.detail.msg, e.detail.cls));
window.addEventListener("dev:ext", (e) => row("dev-log", `registerExtension(${e.detail.name})`, "ok"));
window.addEventListener("dev:select", (e) => row("dev-log", `canvas.selectNode(#${e.detail.id})`));
window.addEventListener("dev:net", (e) => {
  const { method, url, status, ms, aborted } = e.detail;
  const cls = aborted ? "warn" : typeof status === "number" && status >= 400 ? "err" : "";
  row("dev-net", `${String(status).padEnd(6)} ${method.padEnd(5)} ${ms}ms  ${url}`, cls);
});

for (const btn of document.querySelectorAll(".dev-clear")) {
  btn.onclick = () => ($(btn.dataset.clear).textContent = "");
}

// Mirror the pack's own diagnostics onto the page.
for (const level of ["warn", "error"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    row("dev-log", args.map(String).join(" "), level === "error" ? "err" : "warn");
    real(...args);
  };
}
window.addEventListener("error", (e) => row("dev-log", `uncaught: ${e.message}`, "err"));
window.addEventListener("unhandledrejection", (e) =>
  row("dev-log", `unhandled rejection: ${e.reason}`, "err"),
);

/* -- status --------------------------------------------------------------- */

async function refreshStatus() {
  try {
    const s = await (await fetch("/__dev/status", { cache: "no-store" })).json();
    $("dev-lib").textContent = s.library;
    $("dev-lib").title = `scratch library (rev ${s.rev})`;
    $("dev-count").textContent = `${s.count} prompts · ${s.routes} routes`;
  } catch {
    $("dev-count").textContent = "backend unreachable";
  }
}

/* -- controls ------------------------------------------------------------- */

const nodeOpts = () => ({
  flavour: $("dev-flavour").value,
  domWidget: $("dev-domwidget").value,
  lateWidgets: Number($("dev-late").value),
});

$("dev-add").onclick = () => {
  const node = createNode(nodeOpts());
  // A delete button per node, because hydrate.js chains onRemoved and a binder
  // leak is invisible unless something actually calls it.
  const del = document.createElement("button");
  del.className = "dev-node-del";
  del.textContent = "delete node";
  del.onclick = () => removeNode(node);
  node.__el.appendChild(del);
  refreshStatus();
};

$("dev-graph").onchange = () => {
  app.__dev.setGraphMode($("dev-graph").value);
  row("dev-log", `graph probe: ${$("dev-graph").value}`, "ok");
};

$("dev-reset").onclick = async () => {
  await fetch("/__dev/reset", { method: "POST" });
  row("dev-log", "scratch library reset + reseeded", "ok");
  refreshStatus();
};

let hostile = false;
const hostileKeys = (e) => {
  // Stand in for ComfyUI: Delete removes a node, Enter queues a prompt, etc.
  if (["Delete", "Backspace", "Enter", " "].includes(e.key)) {
    row("dev-log", `ComfyUI would have handled "${e.key}" — the guard let it through!`, "err");
  }
};
$("dev-hostile").onclick = () => {
  hostile = !hostile;
  $("dev-hostile").textContent = `hostile keys: ${hostile ? "on" : "off"}`;
  if (hostile) document.addEventListener("keydown", hostileKeys, true);
  else document.removeEventListener("keydown", hostileKeys, true);
};

$("dev-double").onclick = async () => {
  // The scenario shared/singleton.js exists for: two module instances under two
  // cache-busted URLs. If the singleton bag is not doing its job you get two
  // modals, two key guards and two toast stacks.
  await loadPack({ bust: true });
  row("dev-log", "re-imported under a second ?v= — open the panel and look for duplicates", "warn");
};

/* -- go ------------------------------------------------------------------- */

const res = await loadPack();
await setupExtensions();
if (!res.failed.length) createNode(nodeOpts());
await refreshStatus();
if (DEV.reload) watchForReload();
