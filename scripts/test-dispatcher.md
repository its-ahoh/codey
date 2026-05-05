# Auto-Dispatch Manual Test Checklist

Project has no test runner; this is the canonical verification surface for the team auto-dispatch feature.

## Setup

Two workers in `./workers/`:
- `architect` with `## Role\nDesigns systems`
- `reviewer` with `## Role\nAudits code`

Workspace `./workspaces/test/workspace.json`:

```json
{
  "workingDir": "/tmp/scratch",
  "teams": {
    "legacy": ["architect", "reviewer"],
    "auto":   { "members": ["architect", "reviewer"], "dispatch": "auto" }
  }
}
```

`gateway.json` should have a `dispatcher` block configured (see `gateway.json.example`).

Run `npm run dev`, switch to workspace `test`, then exercise each case below.

## Cases

1. **Legacy format unchanged.** `/team legacy refactor module X` → both workers run, sequential carry chain, no dispatcher invocation. Header: `👥 Running team **legacy** (architect → reviewer)`.

2. **`dispatch: 'all'` explicit.** Edit team to `{ "members": [...], "dispatch": "all" }`, repeat command, same behavior as 1.

3. **`dispatch: 'auto'` happy path.** `/team auto fix typo in README` → header is `🧭 Dispatched **auto**: <selected> (skipped: <others>)\nReason: <one line>`. Exact selection depends on the dispatcher model.

4. **Auto fallback on bad model.** Set `gateway.json` `dispatcher.model` to a non-existent name. Repeat command. Header is `⚠️ Auto-dispatch failed (...), running all members.\n👥 Running team **auto** (architect → reviewer)`.

5. **`--all` flag overrides.** With dispatch:'auto' team, run `/team auto --all do task` → no dispatcher invoked, full team runs. Header includes the `[--all override]` suffix.

6. **`--all` requires task.** `/team auto --all` (no task) → usage hint, no execution.

7. **Unknown name filter.** Configure dispatcher to a model that the workspace doesn't actually run (or temporarily monkey-patch a stub) returning `{"selected":["ghost"], "reason":""}`. Confirm header says `⚠️ Auto-dispatch failed (selection empty after filtering unknowns), running all members.`.

Each case should produce an obviously visible header difference and a sane `📊 Team results` summary.
