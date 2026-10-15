/* One Store for the modal, split into named slices. A feature only ever sees its
 * own slice: get, set and subscribe. Values are replaced, never mutated in place,
 * so a subscriber fires exactly when a key's value changes (Object.is).
 * The keys of each slice are fixed by the initial state; a typo throws.
 */

import { NS } from "./ns.js";

export class Store {
  /** @param {Record<string, object>} initial slice name -> initial values */
  constructor(initial) {
    this._state = {};
    this._subs = {};
    for (const [name, values] of Object.entries(initial)) {
      this._state[name] = Object.freeze({ ...values });
      this._subs[name] = new Map(); // key or "*" -> Set<fn>
    }
  }

  /** The get/set/subscribe view of one slice. */
  slice(name) {
    if (!(name in this._state)) throw new Error(`${NS} unknown store slice: ${name}`);
    return {
      name,
      get: (key) => (key === undefined ? this._state[name] : this._state[name][key]),
      set: (patch) => this._set(name, patch),
      subscribe: (key, fn) => this._subscribe(name, key, fn),
    };
  }

  /** How many subscribers are registered across all slices; for leak checks. */
  listenerCount() {
    let n = 0;
    for (const subs of Object.values(this._subs)) for (const set of subs.values()) n += set.size;
    return n;
  }

  _set(name, patch) {
    const prev = this._state[name];
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in prev)) throw new Error(`${NS} unknown key "${key}" in slice ${name}`);
      if (!Object.is(prev[key], value)) changed.push(key);
    }
    if (!changed.length) return;
    const next = Object.freeze({ ...prev, ...patch });
    this._state[name] = next;
    this._notify(name, changed, next);
  }

  _notify(name, changed, next) {
    const subs = this._subs[name];
    const calls = [];
    for (const key of changed) {
      for (const fn of subs.get(key) ?? []) calls.push([fn, next[key], key]);
    }
    for (const fn of subs.get("*") ?? []) calls.push([fn, next, "*"]);
    for (const [fn, value, key] of calls) {
      try {
        fn(value, key);
      } catch (err) {
        console.error(`${NS} subscriber failed`, err);
      }
    }
  }

  _subscribe(name, key, fn) {
    const subs = this._subs[name];
    if (key !== "*" && !(key in this._state[name])) {
      throw new Error(`${NS} unknown key "${key}" in slice ${name}`);
    }
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key).delete(fn);
  }
}
