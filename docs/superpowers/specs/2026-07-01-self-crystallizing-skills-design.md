# Self-Crystallizing Skills — Design

Date: 2026-07-01
Status: Approved (pending implementation plan)

## Problem

When a user works through the same kind of task more than once, Codey
re-derives the work each time and produces fresh output from scratch. The
user wants Codey to notice recurring *process* and turn the shared part into a
small reusable **skill**, so repeated work becomes "apply the known
procedure" instead of "reason it out again."

The full lifecycle the user asked for:

> detect repetition → suggest a skill → auto-apply on match → evolve on use →
> archive when stale.

## What Codey Can Observe (constraint)

Codey delegates solo tasks to a CLI agent (claude-code / opencode / codex) and
sees only the **prompt in** and the **response out** — not the sub-agent's
internal step-by-step reasoning. The one place Codey observes real *process*
is **team / sequential / graph runs**, where Codey itself orchestrates each
worker step.

Therefore repetition detection works on what is genuinely observable:

- the task prompt (summarized),
- the output shape (files touched, response structure), and
- for team runs, the ordered worker/step sequence.

The design does not pretend to see inside a solo sub-agent.

## Decisions (locked during brainstorming)

- **Detection trigger:** *suggested* — Codey detects, then asks before creating.
- **Detection signal:** recurring **sub-processes** across runs (part of how a
  task was worked through resembles other runs), not whole-prompt similarity.
- **Artifact:** a dedicated, lightweight **skill file** per workspace, distinct
  from workers (personas) and memory (facts/lessons).
- **Application:** *auto-applied* silently on a confident match, with a
  one-line note of which skill was used.
- **Self-cleaning:** unused skills are archived (recoverable), not deleted.
- **Self-evolving:** each application can refine the skill, versioned and
  rollback-able.

## Architecture

New module `packages/core/src/skill-crystallizer.ts`, plus a per-workspace
`skills/` directory.

```
workspaces/<name>/
  skills/
    index.json             — manifest of active skills
    <skill-name>.md        — "use when…" header + distilled steps
    archived/
      <skill-name>.md      — self-cleaned or user-forgotten skills
```

Three moving parts:

1. **Run recorder** — after every completed run, append a compact *run trace*
   (prompt summary, output shape, and for team runs the worker/step sequence)
   to a rolling per-workspace history.
2. **Distiller (LLM)** — on run completion, compares the new trace against a
   sample of recent traces. If it finds a recurring sub-process, it emits a
   candidate skill `{ name, whenToUse, steps }`. Reuses the Advisor's
   `{agent, model}` config (same pattern as `judge.ts`), overridable via
   `skills.distillModel`.
3. **Applier** — before a run, matches the task against active skills (cheap
   description match → confirm with a lightweight LLM check). On a confident
   match, injects the skill's steps into the prompt and records the use.

## Data Model

Per-skill record in `skills/index.json`:

```jsonc
{
  "name": "release-notes",          // lowercase-kebab-case, unique per workspace
  "description": "one line",
  "whenToUse": "trigger conditions in natural language",
  "steps": "current distilled procedure (markdown body of the .md)",
  "version": 3,                      // bumped on evolution
  "useCount": 5,
  "lastUsedAt": "2026-06-28T...",
  "successSignals": { "cleanRuns": 4, "corrections": 1 },
  "sourceRunIds": ["run_abc", "run_def"],
  "createdAt": "2026-06-01T..."
}
```

Prior versions of `steps` are retained (in-file history or `archived/`-style
sidecar) so a bad evolution can be rolled back.

## Lifecycle

### Creation (suggested)

When the distiller finds a recurring sub-process, Codey posts one message on
the active surface (chat / Mac):

> 🧩 I've done something like this ~3× ("draft release notes → group by type →
> link PRs"). Save it as a reusable skill **release-notes**? (yes / no / rename)

- `yes` → write `skills/<name>.md` + manifest entry.
- `no` → record a lightweight suppression so the same pattern won't nag again
  soon.
- `rename` → same as yes with a user-supplied name.

### Application (auto)

On a matching future task, Codey applies the skill silently and prepends one
line to its response:

```
⚙︎ using skill: release-notes (v2)
```

Application never blocks the run. A no-match run proceeds normally.

### Evolution (self-improving)

After a run that applied skill X completes, the distiller compares what
actually happened against X's current steps. If the run revealed a
better / missing / wrong step, it proposes a refined version:

- bump `version`, keep the prior version for rollback,
- apply high-confidence refinements silently (matching the auto-apply trust
  model), surfaced as a one-liner: `evolved release-notes → v3`,
- `successSignals` (did the applied run go cleanly? did the user re-ask or
  correct afterward?) decide whether to reinforce or revise.

### Self-cleaning (decay)

A cheap, no-LLM GC pass runs on workspace load and after every Nth run:

- **Unused TTL** — `lastUsedAt` older than `staleDays` (default 30) →
  archived to `skills/archived/` (recoverable, not deleted).
- **Weak-skill rule** — created but never reached `useCount ≥ 2` within
  `weakSkillDays` (default 7) → archived sooner as a likely false positive.
- Archived skills stop being matched/applied but remain on disk.

## Configuration

New `skills` block in `gateway.json`, all defaulted so it works out of the box:

```jsonc
"skills": {
  "enabled": true,
  "suggestOnRepeat": 2,   // min recurrences before suggesting
  "autoApply": true,
  "staleDays": 30,        // unused → archive
  "weakSkillDays": 7,     // created but useCount<2 → archive
  "distillModel": null    // falls back to advisor.{agent, model}
}
```

## Commands (manual control alongside automation)

- `/skills` — list active skills with useCount, version, lastUsed.
- `/skill <name> <task>` — invoke a skill explicitly.
- `/skill forget <name>` — archive.
- `/skill restore <name>` — unarchive.

## Component Boundaries

- **skill-crystallizer.ts** — owns detection, distillation, evolution, GC, and
  the manifest read/write. Pure logic over traces + skill records; takes an
  agent factory + advisor config as deps (mirrors `worker-generator.ts` and
  `judge.ts`). Testable without the gateway.
- **Gateway** — wires the recorder into run completion, the applier into run
  start, surfaces the creation suggestion + one-line notes, and handles the
  `/skill(s)` commands.
- **Run trace** — a small serializable type shared between recorder and
  distiller; the only coupling to how runs execute.

This keeps the crystallizer independently testable and leaves the gateway as a
thin wiring layer.

## Testing

- Distiller: given N synthetic traces with a shared sub-process, emits a
  sensible candidate; given unrelated traces, emits nothing.
- Applier: matches a task to the right skill; no false match on unrelated task.
- Evolution: a run diverging from steps proposes a version bump; a clean run
  reinforces without churn.
- GC: stale and weak skills archive at the right thresholds; archived skills
  are excluded from matching but restorable.
- Suggestion suppression: `no` prevents re-suggesting the same pattern.

## Out of Scope (YAGNI)

- Cross-workspace / global skills (workspace-scoped only for v1).
- Embeddings-based similarity (LLM distiller is enough at current scale).
- Sharing/exporting skills between users.
