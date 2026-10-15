/* Base class for every piece of UI with DOM and a lifecycle. A component gets
 * its dependencies through the constructor, builds its element in render(), and
 * releases everything it registered in destroy(): listeners, store
 * subscriptions, key-bus handlers and child components.
 */

export class Component {
  /** @param {object} [deps] api, store slice, shared services, callbacks */
  constructor(deps = {}) {
    this.deps = deps;
    /** @type {HTMLElement|null} */
    this.el = null;
    this._cleanups = [];
  }

  /** Build and return the root element; called once by mount(). */
  render() {
    throw new Error(`${this.constructor.name}.render() not implemented`);
  }

  /** Render into `parent` and return this. */
  mount(parent) {
    if (this.el) throw new Error(`${this.constructor.name} is already mounted`);
    this.el = this.render();
    parent.append(this.el);
    return this;
  }

  /** addEventListener that destroy() undoes with the same arguments. */
  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.own(() => target.removeEventListener(type, fn, opts));
  }

  /** Subscribe to one key of a store slice until destroy(). */
  watch(slice, key, fn) {
    this.own(slice.subscribe(key, fn));
  }

  /** Tie a child component, or a cleanup function, to this component's life. */
  own(child) {
    this._cleanups.push(typeof child === "function" ? child : () => child.destroy());
    return child;
  }

  /** Undo everything in reverse order and detach the element; safe to repeat. */
  destroy() {
    for (const fn of this._cleanups.splice(0).reverse()) fn();
    this.el?.remove();
    this.el = null;
  }
}
