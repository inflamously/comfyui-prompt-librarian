/* Public surface of the tags feature. */

import { normalizeTag } from "./normalize.js";
import { openTagPicker } from "./tag-picker.js";

export { MAX_TAGS, normalizeTag, taxonomyRows } from "./normalize.js";

/**
 * The tags service the composition root hands to other features. Getters,
 * because the layer stack and the taxonomy change after wiring.
 * @param {{taxonomy: () => Array, layers?: () => object, toast?: Function}} deps
 */
export function createTags({ taxonomy, layers = () => null, toast }) {
  return {
    normalize: normalizeTag,
    /** Open the picker; opts as openTagPicker minus taxonomy, layers and toast. */
    openPicker: (opts) => openTagPicker({ ...opts, taxonomy: taxonomy(), layers: layers(), toast }),
  };
}
