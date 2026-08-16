/* ==========================================================================
   Stand-in for ComfyUI's /scripts/api.js

   `api.fetchApi` is the pack's single network call site. The real one prefixes
   ComfyUI's base URL (`/api`, plus any reverse-proxy prefix) — which is why
   the pack never calls bare `fetch`, and why the dev server mounts the backend
   under /api ONLY. A module that reaches for bare fetch gets an immediate 404
   here instead of working locally and 404ing behind somebody's proxy.
   ========================================================================== */

export { api } from "/__dev/harness/fake-api.js";
