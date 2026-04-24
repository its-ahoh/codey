# Worker/Team UI + CRUD API — Design

**Date:** 2026-04-20
**Status:** Approved for implementation
**Depends on:** `2026-04-19-global-worker-library-design.md` (logic landed in commits `5efe2c5..8879f38`)

## Problem

The global worker library is live on disk and in the gateway, but the Mac app
has no way to browse, create, or edit workers, and no way to manage per-workspace
teams. Creation by hand (editing `personality.md` + `config.json`) is a friction
point. Chat's worker dropdown is still wired to the old in-workspace source.

## Solution overview

Add HTTP CRUD endpoints on the gateway for workers and per-workspace teams.
Expose them in the Mac app as a new **Workers** tab and a **Teams** section
inside the existing **Workspaces** tab. Worker creation happens by free-text
prompt — the description is passed to the currently active coding agent, which
returns a structured worker spec, which the gateway writes to disk and reloads.

## Non-goals

- No per-user/per-profile workers. Single global library continues.
- No team templates or cross-workspace team sharing.
- No version history for workers beyond git.
- No inline streaming of generation output in the UI — a single request/response
  is enough.

## Architecture

### New gateway endpoints

All endpoints return JSON. Errors are `{ error: string }` with a non-2xx status.

```
GET    /workers
  → { workers: [{ name, personality: {role, soul, instructions}, config }] }

PUT    /workers/:name
  body: { personality: {role, soul, instructions}, config }
  → { worker }
  Rewrites personality.md and config.json for the worker, reloads library.

DELETE /workers/:name
  → { ok: true }
  Removes the folder, reloads library. Also removed from every workspace.json
  team definition that references it — see "Cascade on delete" below.

POST   /workers/generate
  body: { prompt: string }
  → { worker }
  Builds a meta-prompt, runs it through the currently active AgentFactory
  instance using the active config's agent + model, parses the structured
  response, writes personality.md + config.json, reloads library.

GET    /workspaces/:name/teams
  → { teams: Record<string, string[]> }

PUT    /workspaces/:name/teams
  body: { teams: Record<string, string[]> }
  → { teams }
  Full-replacement update. Validates every member name resolves in the global
  library; 400 with `{ error, unknown: [...] }` if any don't.
```

The existing `GET /status` stays as-is. The existing `/workspaces` endpoint
already lists workspaces — we reuse it.

### Generation flow

`POST /workers/generate` sequence:

1. Load the active `GatewayConfig` to pick `defaultAgent` + `defaultModel`.
2. Build a system prompt: *"You are generating a Codey worker. Return exactly
   one JSON object matching this schema: `{name, role, soul, instructions,
   codingAgent, model, tools}`. Do not include anything else."*
3. Run through `AgentFactory.createAgent(activeAgent)` with the user's
   description as the user prompt.
4. Parse the response as JSON. If parsing fails, retry once with a stricter
   "return ONLY JSON, no prose" reminder; if it fails again, return 500 with
   the raw output so the user can adjust their prompt.
5. Validate: `name` must match `/^[a-z][a-z0-9-]*$/`, `codingAgent` must be
   one of the known three, `model` must be a non-empty string, `tools` must be
   an array.
6. Reject if `workers/<name>/` already exists (409).
7. Write `workers/<name>/personality.md` (assembled from role/soul/instructions
   with the same `# Worker: Name` / `## Role` / `## Soul` / `## Instructions`
   sections that the loader parses) and `workers/<name>/config.json`.
8. Call `workerManager.loadWorkers()` to refresh the library.
9. Return the new worker.

### Cascade on delete

When `DELETE /workers/:name` succeeds, walk every `workspaces/*/workspace.json`
and remove the worker from any team's member list. If that empties a team,
drop the team entry. Persist every modified file. This keeps team validation
honest without a separate cleanup endpoint.

### Mac app: Workers tab

- New sidebar icon (worker/person), position between chat and workspaces.
- Left pane: list of workers sorted alphabetically. Each row shows name,
  role line (truncated), agent/model badge. A floating `+` button at the
  bottom of the list.
- Right pane: selected worker's editor.
  - Three text inputs for role, soul, instructions (multi-line).
  - Agent dropdown (claude-code / opencode / codex), model text input, tools
    text input (comma-separated tokens).
  - Save button writes via `PUT /workers/:name`, becomes "✓ Saved" briefly.
  - Trash button (with confirm) calls `DELETE`.
- `+` button opens an inline "Create worker" panel replacing the right pane:
  - Single large textarea: "Describe the worker you want…"
  - Submit button runs `POST /workers/generate`, shows a working spinner until
    the endpoint returns, then switches to the new worker's editor view.
  - Any error (parse failure, duplicate name) surfaces as a red bar above
    the textarea; user can edit and resubmit.

### Mac app: Teams section (inside Workspaces tab)

On the existing Workspaces tab, when a workspace is selected, show a Teams
section below its settings.

- Each team: row with name + chip-list of member workers in order.
- Each chip has an `x` to remove; a `+` at the end opens a dropdown of
  available global workers.
- Reorder via drag handle or up/down arrows (keep it simple — arrows).
- "+ New team" inline creates an empty team with an auto-incrementing
  default name (user can rename).
- Changes debounce-save via `PUT /workspaces/:name/teams` (full replacement).

### Mac app: chat dropdown

The existing worker selector in `ChatTab.tsx` currently reads from workspace
state. Change it to fetch `GET /workers` once on mount (and when the gateway
restart notification fires). Add an "empty" option that runs tasks without
a worker personality wrapper — current behavior.

## Components

### `src/routes.ts` (or wherever HTTP routes live)

Five new route handlers. Each takes the shared `WorkerManager` and
`WorkspaceManager`. The generate route also needs the `AgentFactory`.

### `src/worker-generator.ts` (new)

Encapsulates the generation flow — prompt assembly, JSON-with-retry parsing,
file writing. Keeps route handlers thin and makes the flow easier to test.

### `codey-mac/src/services/api.ts`

Add typed methods for the five new endpoints plus `generateWorker`.

### `codey-mac/src/components/WorkersTab.tsx` (new)

The Workers tab described above.

### `codey-mac/src/components/TeamsSection.tsx` (new)

Embedded in `WorkspacesTab.tsx`.

### `codey-mac/src/App.tsx`

Wire the new `workers` tab into the sidebar between `chat` and `workspaces`.

## Data flow

```
[user types description, clicks Create]
    ↓
[codey-mac] POST /workers/generate { prompt }
    ↓
[gateway] worker-generator builds meta-prompt → AgentFactory (active agent+model)
    ↓
[agent CLI] returns JSON string
    ↓
[worker-generator] parse + validate + write files + reload
    ↓
[gateway] returns { worker }
    ↓
[codey-mac] switches right pane to the editor for the new worker
```

```
[user toggles a team member in Workspaces tab]
    ↓
[codey-mac] debounce 400ms → PUT /workspaces/:name/teams { teams }
    ↓
[gateway] validates members exist → writes workspace.json → reloads workspace
    ↓
[codey-mac] confirms save badge
```

## Error handling

| Situation                                   | Behavior                                           |
|---------------------------------------------|----------------------------------------------------|
| `POST /workers/generate` JSON parse fails   | Retry once; on second failure 500 with raw output. |
| Generated worker name collides              | 409 `{ error: "Worker '<name>' already exists" }`. |
| `PUT /workers/:name` for missing worker     | 404.                                               |
| `PUT /workspaces/:name/teams` unknown member| 400 `{ error, unknown: [...] }`. UI highlights.    |
| `DELETE /workers/:name` for missing worker  | 404.                                               |
| Delete cascade can't write a workspace.json | 500 with the failing path; other writes already    |
|                                             | persisted are left as-is (log a warning).         |
| UI loses gateway connection                 | Existing toast + read-only mode (already wired).   |

## Testing

Extend `scripts/verify-workers.ts` with a new section:

1. `PUT /workers/architect` with edited personality — re-reads file, confirms
   disk matches.
2. `POST /workers/generate` with a fixed prompt — mocks the agent CLI by
   setting an env var `CODEY_TEST_AGENT_STUB_OUTPUT` that the AgentFactory
   honors when present (small escape hatch for this test only).
3. `PUT /workspaces/default/teams` with a new team — reads workspace.json,
   confirms the new team is present and validated.
4. `DELETE /workers/<temp>` — confirms folder removed and the team referencing
   it is dropped.

The script calls the routes directly via `fetch` against a gateway started in
the same process (reuse the pattern from existing integration points) or
exercises the handler functions directly if they're exported without the HTTP
layer.

## Follow-ups (explicit non-goals for this spec)

- Streaming generation output back to the UI.
- "Duplicate worker" / "fork" actions.
- Importing/exporting workers as a bundle.
- Per-workspace enabled/disabled workers (the spec already ruled this out).

