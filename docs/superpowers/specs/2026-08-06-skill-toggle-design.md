# Skill on/off toggle (Mac app)

**Date:** 2026-08-06
**Status:** Approved, ready for planning

## Problem

The Skills tab in the Codey Mac app can install, reveal, copy and remove skills, but
there is no way to temporarily silence one. Users who want a noisy skill out of the
way today, without losing it, have to delete the folder and reinstall it later.

## Constraint that shapes the design

Codey does not load skills. Each coding agent CLI (Claude Code, Codex, OpenCode)
scans its own skill roots and picks up any directory containing `SKILL.md`. A
"disabled" flag stored only in Codey config would change the Codey UI and nothing
else — the agent would keep loading the skill. Disabling therefore has to make the
skill invisible to that scan.

## Design

### 1. Disk representation

Disabled means the skill directory's `SKILL.md` is renamed to `SKILL.md.disabled`.
Enabling renames it back. There is no side-car state file: the disk is the single
source of truth, so a skill a user disabled by hand is reported correctly, and a
skill Codey disabled stays disabled for every agent that scans that directory.

### 2. `codey-mac/electron/skills.ts`

- `ScannedSkill` gains `enabled: boolean`.
- `scanSkillsDir` checks `SKILL.md` first, then `SKILL.md.disabled`. **Either file
  marks the skill boundary** — scanning must stop descending there, and the skill
  must still appear in the list, otherwise disabling would make it vanish from the
  UI entirely and its internals would be walked as if they were skill roots.
  Frontmatter is parsed from whichever file exists; `enabled` is set accordingly.
- New pure function `setSkillEnabled(fsMod, pathMod, dir, enabled)`: performs the
  rename, is a no-op when the directory is already in the requested state, and
  throws when neither file exists.
- One ambiguous case needs a decision, because a directory can end up holding
  *both* files — `skills:install` copies a source tree wholesale, so importing a
  folder where someone had hand-disabled a skill lands both files in a managed
  root. The rename must never overwrite, since the existing `SKILL.md.disabled`
  may be a hand-written backup. Enabling from that state is a correct no-op: the
  skill really is enabled and the stale file is just litter. Disabling from it
  throws, rather than returning success without renaming — a silent success there
  is the one outcome that leaves the UI showing "off" for a skill the agent still
  loads.

### 3. IPC and the slash-command palette

- New `skills:setEnabled` handler in `codey-mac/electron/main.ts`, exposed as
  `skills.setEnabled(dir, enabled)` in `electron/preload.ts` and typed in
  `src/codey-api.d.ts`.
- The slash-command list built from `skills:list` in `main.ts` filters out skills
  with `enabled === false`, so a disabled skill no longer appears in the chat `/`
  palette.

### 4. UI — `codey-mac/src/components/SkillsTab.tsx`

- A small toggle sits in the card header, left of the scope badge. It calls
  `stopPropagation` so it does not open the detail modal.
- The detail modal carries a second toggle for the same skill.
- Disabled cards render at `opacity: 0.55` with an `Off` badge. They stay in the
  list and in the skill count; disabling never hides a skill from its own tab.
- Toggling updates local state optimistically and reverts on failure, surfacing the
  error through the existing error banner.
- Plugin-managed skills can be toggled like any other. Their detail modal shows a
  note: `Plugin updates may restore this skill.`

### 5. Interaction with install

Copying a disabled skill through `skills:install` carries the `SKILL.md.disabled`
file along, so the copy arrives disabled. This is the expected outcome and needs no
special handling.

### 6. Tests — `codey-mac/electron/skills.test.ts`

- A directory holding only `SKILL.md.disabled` is reported with `enabled: false`,
  and its subdirectories are not scanned.
- `setSkillEnabled` round-trips a skill disabled and enabled again.
- Repeated calls in the same direction are a no-op rather than an error.
- A directory with neither file throws.
- A directory holding both files: disabling throws, enabling is a no-op, and both
  files survive with their original content.
- Plugin skill scanning preserves `enabled`.

## Out of scope

- Bulk enable/disable of many skills at once.
- Reconciling a plugin update that restores a `SKILL.md` the user had disabled.
- Any disable mechanism that is specific to one agent, such as Claude Code
  `settings.json` deny rules.
