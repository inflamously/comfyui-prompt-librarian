---
name: structure-interview
description: Interview the user about a messy directory's structure, then write a restructure plan (docs/<area>-restructure.md) and the architecture rules in AGENTS.md. Use when the user says a folder's structure is bad, asks to be interviewed about structure, or wants a proper layout before a rewrite or migration.
---

# Structure interview

Turn "this structure is horrendous" into decisions the user made, a target tree, an
old → new mapping and migration steps. The user decides; you survey, ask and write.

Respect the privacy boundary in `AGENTS.md`. Never point a command at the real
ComfyUI user directory.

## 1. Survey before asking (a few tool calls, no subagents)

For the target directory, gather:

- files with line counts (`find … | xargs wc -l`), the biggest files and the entry point;
- the cross-folder import graph: count `src -> dst` edges between top-level folders,
  including dynamic `import()`;
- shared context or global state: how often each property of a context or state
  object is used (e.g. `grep -oE 'ctx\.[a-zA-Z]+' | sort | uniq -c`), and the state
  shape itself;
- the existing enforcement (structure tests, import-linter contracts) and how tests
  are laid out.

Show the user **5 or fewer bullets** of findings: hidden coupling, mixed folder kinds
(features vs technical layers), sideways imports, global state, giant files. Then
start asking.

## 2. Interview in rounds

Use `AskUserQuestion`: up to 4 questions per round, recommended option first and
marked "(Recommended)". Add `preview` code sketches when the options are code shapes.
Base each round on the answers so far. Typical rounds:

1. **Problem and constraints.** What hurts (multi-select), what the coming rewrite
   needs, whether to mirror the backend's rules, hard constraints (build step,
   dependencies).
2. **Building blocks.** Library or in-house helpers, how features talk to each other
   (composition root vs stores vs event bus), what "component library" means to the
   user, which folders become feature slices.
3. **Placement.** Where shared widgets live, what gets dropped (and whether the drop
   covers the backend too), where adapters go (e.g. the canvas node side), how to
   migrate (plan everything then go slice by slice, big bang, or organically).
4. **Mechanics.** Load timing (eager vs lazy), how state is split, CSS, naming.
5. **Rules and output.** What a feature may touch in the store, where the API client
   goes, how to enforce the rules, where the plan lives.
6. **Code-grounded questions.** Before writing, grep the consumers of ambiguous
   modules: who imports the pickers, the caches, the fallbacks. Ask about patterns
   the earlier answers don't settle (e.g. defensive lazy loading with alias probing,
   a module several features use).

Read the answers literally. A free-text answer often redefines the question: e.g.
"this is basically A -> B <-> C + shared" is the target layering. Reflect it back as
a small diagram.

## 3. When the user wants to clarify

If a round is rejected with "clarify", ask what they want to clarify, then answer
**only** that, factually and briefly. Example questions: can a library be vendored
with no build step, can we reuse the host app's framework. Name the real
constraints (bare-specifier imports, duplicate module instances, host internals
being undocumented). Give one recommendation, then offer to resume. When the user
changes direction ("na, in-house then"), accept it and reword the paused questions
for that direction. Don't argue for the option they dropped.

## 4. Save as you go

Once the direction is fixed (constraints, the library choice the user rejected, code
style), write or update one `project` memory with **Why** and **How to apply**, and
add its line to `MEMORY.md`. When you finish, point that memory at the plan file.

## 5. Write the outcome

**`docs/<area>-restructure.md`**, in this order:

1. Decisions table (topic → decision), one row per answer.
2. Target tree with a one-line role per folder or file.
3. Layers, highest first, and who may import whom.
4. Building-block sketches (base class, store, wiring example), marked "settled in
   step 1".
5. State slices: owner and keys, taken from the current state shape.
6. Old → new mapping table that covers **every** current file or folder, including
   deletions.
7. Enforcement additions: concrete rules for the structure test, plus a shrinking
   allowlist of legacy directories while the migration runs.
8. Migration steps: foundations first, then one slice per step, each keeping
   `npm test` and `python3 scripts/dev.py sim` green. The step that deletes the old
   glue (the context object, the fallbacks) comes last.
9. Out of scope.

**`AGENTS.md`**: add an "Architecture (<area>)" section mirroring the backend's
(tree, numbered Rules, Contracts and what enforces them). Fix any line that called
the area out of scope, and annotate the matching item under "Upcoming tasks".

Only documents and memory change. Don't touch code, don't run the migration and
don't commit.

## 6. Close

Summarise the decisions in a short diagram plus bullets. List separately **the calls
you made yourself** (helper placement, numeric ceilings, step order) so the user can
override them. Then offer step 1 in one sentence.
