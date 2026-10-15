/* Public surface of the word-pictures feature. */

import { render } from "./runner.js";
import { prepareTemplate, wordPrompt } from "./template.js";

export { startWordPictures } from "./start.js";

/**
 * Render arbitrary prompt text through the open workflow, small and as a
 * preview: what word pictures do, offered to other features (the gallery's A/B).
 * @param {{app: () => object, host: object}} deps app() is ComfyUI's app; host its queue
 */
export function createRenderer({ app, host }) {
  return {
    /** Whether this ComfyUI can queue prompts from an extension. */
    available: () => typeof app()?.graphToPrompt === "function" && !!host.available?.(),
    /** Check the open workflow once; throws a message fit for the user. */
    prepare: async (nodeId) => prepareTemplate((await app().graphToPrompt()).output, nodeId),
    /** The first image `text` renders to, or null. */
    render: async (template, text) => {
      const images = await render(host, wordPrompt(template, text));
      return images.find((img) => img && typeof img.filename === "string") || null;
    },
  };
}
