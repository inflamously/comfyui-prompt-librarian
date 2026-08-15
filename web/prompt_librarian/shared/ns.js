/* ==========================================================================
   Prompt Librarian — the log namespace
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports EVERY .js under WEB_DIRECTORY as an
   extension, so this file is loaded whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only.

   Its own file because every module in the pack wants it and nothing should
   have to pull in a larger module to get a string.
   ========================================================================== */

export const NS = "[prompt-librarian]";
