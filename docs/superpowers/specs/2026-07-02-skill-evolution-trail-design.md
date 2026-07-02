# Skill Evolution Trail — Design

Date: 2026-07-02
Status: Approved (pending implementation plan)
Depends on: 2026-07-01-self-crystallizing-skills-design.md (PR #158)

## Problem

Self-crystallizing skills evolve (version bumps from the evolve LLM), get
rolled back, and get upserted — but the only record is the rollback stack
(`history`, capped at 5, and *consumed* by rollback) plus aggregate counters.
The user cannot answer "how did this skill get to v4?": there are no
timestamps, no record of which run triggered a change, and rolling back
erases the very entries that would explain what happened.

Each skill needs its own append-only audit trail, and the user needs surfaces
to read it.

## Decisions (locked during brainstorming)

- **Granularity:** evolution events only — one entry per version change
  (created / evolved / rolled-back). Individual applications are NOT logged
  per-run; `useCount`/`successSignals` already aggregate usage.
- **Storage:** a separate `evolution` event array per skill entry, distinct
  from the rollback stack. Rejected alternatives: extending `history`
  (rollback pops it — the audit trail would lose events exactly when the user
  most wants the record) and per-skill sidecar files (more files and atomic
  write paths for kilobytes of data — YAGNI).
- **Surfaces:** all three — inspectable on disk (`index.json`), a
  `/skill history <name>` command, and a Mac app Skills panel.
- **Mac panel scope:** viewer + management actions (forget / restore /
  rollback). No steps editing in this round (a manual edit raises
  versioning questions — deferred).

## Data Model (packages/core)

New type in `skill-crystallizer.ts`:

```typescript
export interface SkillEvolutionEvent {
  at: number;                        // Date.now()
  kind: 'created' | 'evolved' | 'rolled-back';
  fromVersion?: number;              // absent for 'created'
  toVersion: number;
  /** The run that triggered an 'evolved' event; absent for created/rolled-back. */
  trigger?: { runId: string; promptSummary: string };
  /** Snapshot of the steps as of this event, so the trail alone reconstructs
   *  every version even after the rollback stack's cap prunes old steps. */
  steps: string;
}
```

`SkillEntry` gains `evolution: SkillEvolutionEvent[]`, capped at
`EVOLUTION_MAX = 20` (oldest dropped). Back-compat: entries persisted without
the field load as `[]` (same backfill pattern as `history`).

**Single choke point:** events are appended inside the store's own mutators so
every surface records automatically —

- `add()` — appends `created` on new entries; on an upsert that changes
  steps (which already bumps the version) appends `evolved` with the new
  version and, when the caller supplies one, the trigger.
- `bumpVersion(name, newSteps, trigger?)` — gains an optional trigger param;
  appends `evolved`. The gateway's evolve stage passes
  `{ runId: trace.runId, promptSummary: trace.promptSummary }`.
- `rollback(name)` — appends `rolled-back` with `toVersion` = the restored
  version and the restored steps snapshot.

The rollback stack (`history`) is unchanged and remains the mechanism for
restoring steps; `evolution` is read-only history and is never consumed.

## `/skill history <name>` (packages/gateway)

New subcommand alongside forget/restore/rollback (extends the existing
`parseCommand` skill regex and `handleCommand` cases). Output, oldest-first:

```
📜 release-notes — evolution (v3 current)
- v1 created · 2d ago
- v2 evolved · 1d ago ← "draft release notes for v2.1"
- v3 evolved · 5h ago ← "changelog for the mac app"
- v2 rolled-back · 3h ago

Current steps (v2):
1. fetch merged PRs
2. group by type
```

Unknown skill → same "not found" reply shape as the sibling subcommands.
Empty trail (legacy skill created before this feature) → "No recorded
evolution events yet." Uses the existing `Codey.relativeTime` helper.

## Mac Skills Panel (codey-mac)

- **IPC (electron main):** handlers `skills:list`, `skills:history`,
  `skills:forget`, `skills:restore`, `skills:rollback` calling
  `inProcessGateway`'s workspace manager → `getSkillStore()` directly (same
  shape as existing workspace/chat IPC). `skills:list` returns entries with
  name, description, version, useCount, lastUsedAt, archived, successSignals;
  `skills:history` returns the `evolution` array for one skill.
- **Renderer:** a Skills panel following the codey-mac pattern used by the
  existing management panels (the implementation plan pins the exact
  component/navigation pattern after reading the current UI):
  - List: name, `vN`, use count, last-used (relative), archived badge.
  - Expandable per-skill timeline rendering the evolution events (kind icon,
    relative time, trigger summary for evolved events, steps snapshot in a
    collapsed/monospace block).
  - Actions: forget (archive) / restore / rollback buttons, each with a
    confirmation; rollback disabled when the skill has no rollback stack;
    restore shown only for archived skills.
  - Mutations refresh the list from `skills:list` (no optimistic state).
- Panel is read-your-own-workspace: it reflects the gateway's current
  workspace, same as the rest of the app.

## Error Handling

- Store mutators never throw for trail reasons — appending an event is a
  plain array push inside methods that already persist via the debounced
  atomic writer.
- IPC handlers return `{ ok: false, error }` on unknown skill / store
  unavailable; renderer shows the error inline in the panel.
- `/skill history` with no name falls through like other malformed skill
  subcommands (generic unknown-command behavior) — acceptable, consistent.

## Testing

- **Core:** `add` records `created`; upsert-with-changed-steps records
  `evolved`; `bumpVersion` with trigger records the trigger; `rollback`
  records `rolled-back` with restored version/steps; cap at EVOLUTION_MAX
  drops oldest; legacy entries load with `evolution: []`; events survive a
  persist/reload round-trip.
- **Gateway:** history command formatting (via the same test seam the other
  command tests use, if any; otherwise verified in the plan's build steps).
- **Mac:** IPC handlers unit-tested against a temp-dir SkillStore (list,
  history, mutations); renderer tested to codey-mac's existing standard.

## Out of Scope (YAGNI)

- Per-application logging (every use of a skill) — aggregates cover it.
- Editing skill steps from the Mac panel — versioning semantics of manual
  edits deferred.
- Diff rendering between versions (the panel shows snapshots; a diff view is
  a UI nicety for later).
- Cross-workspace skill browsing in the panel.
- Retro-fitting trails for skills created before this feature ships.
