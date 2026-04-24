# Global Worker Library — Design

**Date:** 2026-04-19
**Status:** Approved for implementation (logic only; Mac app UI deferred)

## Problem

Worker personalities and their exec configs (agent/model/tools) currently live
inside each workspace under `workspaces/<name>/workers/*.md` and
`workspaces/<name>/workspace.json`. The same worker — e.g. `architect` — is
copied into every workspace that uses it. Edits in one workspace don't
propagate; duplicates drift; upgrading a model for a worker across N workspaces
means touching N files. Duplication is the pain.

## Solution overview

Move workers into a single global library at the repo root. Workspaces stop
owning worker definitions; they only name which teams exist for that project.
Every worker in the global library is available to every workspace. No
per-workspace overrides.

## Non-goals

- **No per-workspace worker overrides.** If you need "architect on Opus here,
  Sonnet there," create a second global worker (`architect-opus`). Revisit
  overrides later only if this bites.
- **No migration tool.** This is a breaking change. Old worker data is dropped;
  the user rewrites workers from scratch. The startup guard makes the breakage
  loud and actionable.
- **No Mac app UI changes in this spec.** A follow-up spec will add a Workers
  tab, a Teams section in the Workspaces tab, and CRUD HTTP endpoints.

## Architecture

### On-disk layout

```
codey/
  workers/                            ← NEW: global worker library
    architect/
      personality.md                  ← role, soul, instructions
      config.json                     ← { codingAgent, model, tools }
    executor/
      personality.md
      config.json
  workspaces/
    default/
      workspace.json                  ← workingDir + optional teams only
      memory.md
      # no workers/ subfolder anymore
    api-project/
      workspace.json
      memory.md
```

### File formats

**`workers/<name>/personality.md`** — same structure as today minus the
`## Relationship` section (relationships are now explicit teams in
`workspace.json`):

```markdown
# Worker: Architect

## Role
...

## Soul
...

## Instructions
...
```

**`workers/<name>/config.json`** — required. No defaults.

```json
{
  "codingAgent": "claude-code",
  "model": "claude-opus-4-6",
  "tools": ["file-system", "git", "web-search"]
}
```

**`workspace.json`** — `workers` field removed. `teams` is optional.

```json
{
  "workingDir": "./",
  "teams": {
    "review": ["architect", "executor"]
  }
}
```

### Rules

- A worker exists iff `workers/<name>/` contains both `personality.md` and
  `config.json`. Name = folder name, lowercased for lookup.
- The global library is the set. Every workspace can use every worker.
- Teams are workspace-scoped, ordered arrays. Each member name must resolve in
  the global library; unknown names cause a loud load-time failure on that
  workspace.
- No `/worker` gate by workspace — any global worker can run in any workspace.

## Components

### `WorkerManager` (rewrite of `src/workers.ts`)

- Constructor takes the repo root (or `workersDir` defaulting to `./workers`).
  No longer takes a workspace path.
- `loadWorkers()` scans `workers/*/` once at startup. For each folder, reads
  `personality.md` and `config.json`. Missing `config.json` is a load-time error
  for that worker (logged + skipped; do not crash the gateway — other workers
  still load).
- Internal shape:
  ```ts
  interface Worker {
    name: string
    personality: { role: string; soul: string; instructions: string }
    config: { codingAgent: 'claude-code'|'opencode'|'codex'; model: string; tools: string[] }
  }
  ```
- Public surface: `getWorker(name)`, `getAllWorkers()`, `getWorkerNames()`,
  `buildWorkerPrompt(name, task)`, `getWorkerCodingAgent(name)`,
  `getWorkerModel(name)`, `listWorkers()`.
- Dropped: `setWorkspace()`, `getRelatedWorkers()`, `parseRelationships()`,
  the separate `workerConfigs` map.

### `WorkspaceManager` (edits to `src/workspace.ts`)

- Parse `teams` from `workspace.json` on workspace load.
- On workspace switch, validate every team member name resolves in
  `WorkerManager`. If any unknown names, log a clear error listing them and
  mark the workspace's team as unusable; other workspaces and worker commands
  still work.
- New public methods: `getTeam(name)`, `getTeamNames()`.

### `Gateway` (edits to `src/gateway.ts`)

- `/worker <name> <task>` — look up `name` in `WorkerManager`; error with
  "Unknown worker. Available: <list>" on miss. No workspace gating.
- `/team <name> <task>` — look up `name` in the current workspace's teams.
  Team execution stays sequential (unchanged semantics); on error or missing
  member at run time, report which member failed. Old relationship-parsing
  path is deleted.
- `/workers` — lists the global library.
- `/teams` (new) — lists teams declared in the current workspace.

### Breaking-change startup guard

At gateway startup, before loading workers:

1. If any `workspaces/*/workers/` directory exists, refuse to start:
   ```
   Legacy per-workspace workers detected at <path>.
   Codey now uses a global workers/ library. Move your worker files to
   ./workers/<name>/{personality.md, config.json} and remove the old per-workspace
   folders. workspace.json no longer accepts a "workers" field; use "teams" instead.
   ```
2. If any `workspace.json` has a `workers` field (legacy inline config), refuse
   to start with the same message.

The guard is intentionally blunt — one clear error, no partial-migration mode.

## Data flow

```
[gateway startup]
    ↓
[startup guard]   → refuse + message if legacy layout detected
    ↓
[WorkerManager.loadWorkers()]   → populate global library from ./workers/*/
    ↓
[WorkspaceManager]   → for each workspace, parse teams; validate members
    ↓
[ready]

[user: /worker architect "design REST API"]
    ↓
[Gateway]   → WorkerManager.getWorker("architect") → buildWorkerPrompt → agent

[user: /team review "audit this PR"]
    ↓
[Gateway]   → WorkspaceManager.getTeam("review") → [architect, executor]
    ↓
          for each name: WorkerManager.getWorker(name) → run sequentially, pass output
```

## Error handling

| Situation                                         | Behavior                                                                 |
|---------------------------------------------------|--------------------------------------------------------------------------|
| Legacy `workspaces/*/workers/` present            | Startup refuses; prints migration message.                               |
| `workspace.json` contains legacy `workers` field  | Startup refuses; prints migration message.                               |
| `workers/<name>/` missing `config.json`           | Skip that worker at load; log error; other workers still load.           |
| `workers/<name>/` missing `personality.md`        | Skip that worker at load; log error.                                     |
| Team references unknown worker                    | Log error per workspace listing unknown names; team is unusable.         |
| `/worker <unknown>`                               | Reply with error + list of available global workers.                     |
| `/team <unknown>`                                 | Reply with error + list of teams on current workspace.                   |
| Team member fails mid-sequence                    | Stop the sequence; report which member failed.                           |

## Testing

No test runner is configured in this repo, so testing is manual. The plan must
include a test script (shell or TS) that exercises:

1. Fresh startup with valid `workers/` — all workers load, `/workers` lists them.
2. Startup with a legacy `workspaces/default/workers/` folder — gateway refuses
   with the expected message.
3. Startup with `workers` field in a `workspace.json` — gateway refuses.
4. `/worker architect "hello"` succeeds; `/worker nosuch "hello"` errors with
   the available list.
5. `/team review "hello"` runs architect then executor sequentially; team with
   an unknown member name is reported on workspace load.
6. Removing `config.json` from one worker folder skips only that worker; others
   still load.

## Follow-ups (explicitly out of scope)

1. **Mac app UI** — Workers tab with personality editor + config form, Teams
   section on the active workspace, chat dropdown populated from the global
   library. Needs its own design doc once this lands.
2. **HTTP API for worker/team CRUD** — `GET /workers`, `POST /workers`,
   `PUT /workers/:name`, `DELETE /workers/:name`, `GET/PUT /workspaces/:name/teams`.
   Needed before the Mac app UI.
3. **Per-workspace overrides** — revisit only if the "same personality, different
   model" case becomes common enough to hurt.
4. **Worker families & inheritance** — not needed yet. Avoid adding until there's
   real pain.
