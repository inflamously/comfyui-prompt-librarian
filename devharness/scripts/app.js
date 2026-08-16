/* ==========================================================================
   Stand-in for ComfyUI's /scripts/app.js
   --------------------------------------------------------------------------
   Served at /scripts/app.js by scripts/devserver.py so that

       /extensions/comfyui-prompt-library/prompt_librarian/index.js

   resolves `../../../scripts/app.js` to this file, exactly as it does in a real
   ComfyUI. The number of `../` depends on how deep a file sits under web/, so
   the mount layout is load-bearing; devserver.py asserts it at startup.

   THIS FILE IS A GUESS ABOUT THE HOST. It encodes what the pack assumes about
   `app`, `graph` and `canvas` — nothing more. Anything it gets wrong, the
   harness will get wrong in the same direction, which is why devharness/ is
   checked in and reviewable rather than generated into a Python string.

   NEVER put this under web/: WEB_DIRECTORY = "./web" means ComfyUI imports
   every .js beneath it as an extension, so a stub there would load on every
   real user's machine.
   ========================================================================== */

export { app } from "/__dev/harness/fake-app.js";
