/* The progress card shown while words render. */

export function createPanel(document, onStop) {
  const card = document.createElement("div");
  card.className = "pl-wordgen";
  card.setAttribute("role", "status");
  const title = document.createElement("div");
  title.className = "pl-wordgen-title";
  const line = document.createElement("div");
  line.className = "pl-wordgen-line";
  const bar = document.createElement("div");
  bar.className = "pl-wordgen-bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  const actions = document.createElement("div");
  actions.className = "pl-wordgen-actions";
  const button = document.createElement("button");
  button.type = "button";
  actions.appendChild(button);
  card.append(title, line, bar, actions);
  document.body.appendChild(card);

  let finished = false;
  button.addEventListener("click", () => (finished ? card.remove() : onStop()));

  function update(state) {
    const settled = state.done + state.failed;
    finished = !state.running;
    fill.style.width = `${state.total ? (100 * settled) / state.total : 100}%`;
    if (finished) {
      title.textContent = `Word pictures: ${state.done} made`;
      line.textContent = state.error || (state.failed ? `${state.failed} words gave no image` : "all done");
      button.textContent = "Close";
      button.disabled = false;
      return;
    }
    title.textContent = `Word pictures: ${settled} / ${state.total}`;
    line.textContent = state.stopped ? "stopping after this word…" : `rendering “${state.current}”`;
    button.textContent = "Stop";
    button.disabled = state.stopped;
  }

  return { update, close: () => card.remove(), element: card };
}
