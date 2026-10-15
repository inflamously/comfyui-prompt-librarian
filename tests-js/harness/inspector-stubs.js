/* ==========================================================================
   Stand-ins for the features the inspector gets from modal/app.js, for tests
   that mount the real inspector to test something else (see inspector.js). They record
   what the inspector asked for; the features have their own tests.
   ========================================================================== */

/** A mountDupes(slot, side) that records calls; `.panel` is the last one made. */
export function stubMountDupes() {
  const mount = (slot, side) => {
    mount.side = side;
    mount.panel = {
      calls: [],
      schedule() { this.calls.push("schedule"); },
      check() { this.calls.push("check"); },
      clear() { this.calls.push("clear"); },
      cancel() { this.calls.push("cancel"); },
      destroy() { this.calls.push("destroy"); },
      threshold: () => 0.9,
    };
    return mount.panel;
  };
  return mount;
}

/** An attachAutocomplete(textarea, host) that does nothing. */
export function stubAttachAutocomplete() {
  return () => ({ dismiss() {}, destroy() {} });
}
