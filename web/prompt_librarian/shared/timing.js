/**
 * Debounce with `.cancel()` and `.flush()`.
 *
 * `leading: true` invokes on the first call of a burst and suppresses the
 * trailing call for that burst (used for "immediate when cleared" search).
 * `.flush()` runs a pending trailing call right now and returns its result;
 * `.cancel()` drops it. Both are no-ops when nothing is pending.
 *
 * @param {Function} fn
 * @param {number} ms
 * @param {{leading?: boolean}} [opts]
 * @returns {Function & {cancel: () => void, flush: () => any, pending: () => boolean}}
 */
export function debounce(fn, ms, opts = {}) {
  const leading = !!opts.leading;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  let result;

  function invoke() {
    const args = lastArgs;
    const ctx = lastThis;
    lastArgs = null;
    lastThis = null;
    result = fn.apply(ctx, args || []);
    return result;
  }

  function wrapped(...args) {
    lastArgs = args;
    lastThis = this;
    const callNow = leading && timer === null;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs !== null) invoke();
    }, ms);
    if (callNow) return invoke();
    return result;
  }

  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastThis = null;
  };

  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs !== null) return invoke();
    return result;
  };

  wrapped.pending = () => timer !== null;

  return wrapped;
}

/**
 * rAF-coalesced callback — many calls per frame collapse to one, arguments
 * from the last call win. Used for scroll handling in the virtual list.
 * @param {Function} fn
 * @returns {Function & {cancel: () => void}}
 */
export function rafThrottle(fn) {
  let handle = 0;
  let lastArgs = null;
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
  const caf =
    typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;

  function wrapped(...args) {
    lastArgs = args;
    if (handle) return;
    handle = raf(() => {
      handle = 0;
      const a = lastArgs;
      lastArgs = null;
      fn(...(a || []));
    });
  }
  wrapped.cancel = () => {
    if (handle) caf(handle);
    handle = 0;
    lastArgs = null;
  };
  return wrapped;
}
