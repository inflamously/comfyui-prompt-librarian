/* ==========================================================================
   The tag picker has one stable home and scroll position

   Tag chips wrap, and every pick rebuilds their row. Anchoring the dropdown to
   the moving "+ tag" chip made it slide sideways—or jump when that chip was
   replaced. It belongs at the height of `// PROMPT TEXT`, over the textarea.
   Selecting several tags must also leave the dropdown at the same scroll
   offset instead of sending the user back to the first option each time.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { mountInspector } from "../harness/inspector.js";


let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

function rect({ left, top, width, height }) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() { return this; },
  };
}

function setRect(node, value) {
  Object.defineProperty(node, "getBoundingClientRect", {
    configurable: true,
    value: () => value,
  });
}

async function openPicker({ initialTags = [] } = {}) {
  const { createTags } = await imp("prompt_librarian/features/tags/index.js");
  const taxonomy = [{ name: "portrait", count: 4 }, { name: "night", count: 2 }];
  // No layer stack, as before: the picker mounts on <body> and measures from there.
  const { pane } = await mountInspector({ tags: createTags({ taxonomy: () => taxonomy }) });
  pane.buf.tags = initialTags.slice();

  setRect(pane.els.textLabel, rect({ left: 180, top: 120, width: 110, height: 16 }));

  // This is where the old anchor happened to be. Its deliberately different
  // position makes the test prove which element actually controls placement.
  const movingTagButton = document.createElement("button");
  setRect(movingTagButton, rect({ left: 620, top: 82, width: 60, height: 24 }));
  pane.els.tagsRow.appendChild(movingTagButton);

  pane.openTagPicker();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const popover = document.querySelector(".pl-pick-tags");
  assert.ok(popover, "the real tag picker opened");
  return { pane, popover };
}

describe("tag picker position", () => {
  test("opens over the Prompt text label at the same height", async () => {
    const { pane, popover } = await openPicker();

    assert.equal(pane.els.textLabel.textContent, "// PROMPT TEXT");
    assert.equal(popover.style.left, "180px");
    assert.equal(popover.style.top, "120px", "aligned with the label's top edge");
    assert.equal(popover.dataset.flip, "over");
    env.assertNoErrors();
  });

  test("does not move when the tag chips are rebuilt", async () => {
    const { pane, popover } = await openPicker();

    const replacement = document.createElement("button");
    setRect(replacement, rect({ left: 340, top: 180, width: 60, height: 24 }));
    pane.els.tagsRow.replaceChildren(replacement);

    const input = popover.querySelector(".pl-search-in");
    input.value = "por";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    assert.equal(popover.style.left, "180px");
    assert.equal(popover.style.top, "120px");
    env.assertNoErrors();
  });
});

describe("tag picker scrolling", () => {
  test("keeps the dropdown scroll offset after selecting a tag", async () => {
    const { popover } = await openPicker();
    const list = popover.querySelector('[role="listbox"]');
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");

    // jsdom has no layout and therefore does not reproduce the browser's
    // scroll clamping when the option list is emptied. Model that one browser
    // behavior so this test fails unless the picker restores the offset.
    Object.defineProperty(list, "textContent", {
      configurable: true,
      get() { return textContent.get.call(this); },
      set(value) {
        textContent.set.call(this, value);
        if (value === "") popover.scrollTop = 0;
      },
    });

    popover.scrollTop = 137;
    list.querySelector('button[role="option"]').click();

    assert.equal(popover.scrollTop, 137);
    env.assertNoErrors();
  });
});

describe("tag picker toggles", () => {
  test("clicking a selected tag turns it off without closing the dropdown", async () => {
    const { pane, popover } = await openPicker({ initialTags: ["portrait"] });
    const portrait = () => Array.from(popover.querySelectorAll('button[role="option"]'))
      .find((button) => button.textContent.includes("portrait"));

    assert.equal(portrait().getAttribute("aria-selected"), "true");
    portrait().click();

    assert.deepEqual(pane.buf.tags, []);
    assert.equal(portrait().getAttribute("aria-selected"), "false");
    assert.equal(popover.isConnected, true, "multi-select dropdown stays open");
    env.assertNoErrors();
  });
});
