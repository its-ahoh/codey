# Team Parallel Mode (Roundtable Discussion) — Design

**Date:** 2026-05-24
**Status:** Design approved, plan pending
**Related:** [team-auto-dispatch](2026-05-01-team-auto-dispatch-design.md), [team-manager-iterative-routing](2026-05-06-team-manager-iterative-routing-design.md), [team-pause-for-user-input](2026-05-07-team-pause-for-user-input-design.md)

## Summary

Add a third team `dispatch` mode — `parallel` — that runs all team members concurrently as a moderated roundtable discussion. Workers maintain their own opinion files and read each other's; a Manager loop watches the shared workspace, updates a running consensus summary, escalates questions to the user, and decides when the discussion converges, drifts, or should be terminated.

Unlike `all` (strict sequential) and `auto` (Manager picks one next worker each turn), `parallel` treats the team as participants in a live discussion rather than a pipeline. The primary use case is **multi-perspective brainstorming and decision-making**, not parallel task execution.

## Goals

- Enable simultaneous multi-worker discussion of a topic with shared visibility.
- Let Manager arbitrate continuation vs. user-escalation vs. termination based on observed file activity.
- Reuse existing Chat machinery for identity, persistence, sidebar listing, and resume.
- Reuse existing `[ASK_USER]` / `[ASK_USER:choice]` user-interaction surface.

## Non-Goals

- **Not** for parallel task execution (split-the-work scenarios). Workers discuss, they don't divide labor.
- **Not** a long-running daemon; each `/team` invocation is bounded by `maxDurationMs`.
- **Not** a replacement for `auto` mode — `auto` remains the right choice for sequential planner→executor handoffs.

## User-Facing Behavior

### Configuration

In `workspace.json`:

```json
{
  "teams": {
    "roundtable": {
      "members": ["architect", "executor", "code-reviewer"],
      "dispatch": "parallel",
      "parallel": {
        "maxDurationMs": 600000,
        "idleTimeoutMs": 60000,
        "managerPollMs": 30000
      }
    }
  }
}
```

All three `parallel.*` fields are optional with sensible defaults (10 min / 60s / 30s).

### Invocation

`/team roundtable <topic>` — same syntax as existing teams. Gateway detects `dispatch === 'parallel'` and routes to the new runner.

### Resume

If the user sends another message into a chat whose linked discussion is `done` or `terminated`, the same chat re-enters `running` state: existing opinion files are preserved, the new user message is appended to `topic.md` as a continuation, and workers + Manager restart with full prior context. No special CLI flag needed.

### Final Output

When the Manager terminates, it posts one structured message to the chat:

```
🪑 Roundtable: <topic>
终止原因: <consensus | drift | timeout | user_cancel | max_duration>

【Manager 总结】
<final summary.md contents>

【各方观点】
• architect: <one-line excerpt by Manager>
• executor: <one-line excerpt>
• code-reviewer: <one-line excerpt>

完整记录: workspaces/<ws>/chats/<chatId>/discussion/
```

## Architecture

### Storage

Each parallel-team invocation is backed by an existing Chat (via `ChatManager`). The chat record carries a new optional field:

```ts
interface Chat {
  // …existing fields…
  discussion?: {
    teamName: string;
    status: 'running' | 'paused' | 'done' | 'terminated';
    startedAt: number;
    terminatedReason?: 'consensus' | 'drift' | 'timeout' | 'max_duration' | 'user_cancel';
  };
}
```

Working files live alongside the chat:

```
workspaces/<ws>/chats/<chatId>/discussion/
  ├── topic.md          # immutable per turn; appended on resume
  ├── control.md        # Manager → workers signals (JSON-ish or fenced sections)
  ├── summary.md        # Manager-maintained consensus & open questions
  ├── transcript.log    # append-only event log of file writes
  └── opinions/
      ├── architect.md
      ├── executor.md
      └── code-reviewer.md
```

Deletion: when a chat is deleted via the existing UI, the discussion directory is removed as part of chat cleanup.

### Control File Schema

`control.md` is the **only** coordination channel between Manager and workers. Workers must read it before each write. Format:

```
---
status: running | paused | finalizing | terminated
revision: <monotonic int>
updated_at: <iso timestamp>
---

## Directive
<free text from Manager: "keep discussing X", "focus on Y", "converge on a recommendation">

## User Question
<only present when status=paused; rendered to user via ASK_USER mechanism>

## Resume Note
<only present right after user answer; tells workers what user said>
```

Workers ignore directives they don't understand but MUST honor `status`:
- `running` → continue normally
- `paused` → stop writing; poll control.md until status changes
- `finalizing` → write a final consolidating update to own opinion, then exit
- `terminated` → exit immediately

### Runtime Components

Three concurrent loops per discussion:

**1. Worker loop (one per team member, spawned via `Promise.all`)**

Each worker is invoked once with a long-running prompt that includes:
- Topic, paths to its own opinion file, other opinion files, summary.md, control.md
- Tool access (Read/Write) for those files
- Loop protocol: read control → read peers' opinions + summary → update own opinion → repeat
- Exit conditions: control.status in {finalizing, terminated}, OR worker decides it has nothing to add for N consecutive checks (worker-internal heuristic)
- Question protocol: when stuck, write `[ASK_MANAGER]: <question>` at end of own opinion file and pause; Manager reads, decides whether to route to a peer (write a directive) or escalate to user

The worker runs as one long session — it does not get re-spawned per turn. This requires the underlying coding-agent CLI to support tool use within a single invocation (claude-code, opencode, codex all do).

**2. Manager loop**

A dedicated loop independent of any worker. Triggers:
- `fs.watch` on the discussion directory (debounced to ~2s)
- `managerPollMs` (default 30s) heartbeat as fallback

On each trigger:
1. Read all opinion files, summary, control, transcript.
2. Build Manager prompt (extends existing `buildAdvisorPrompt` with parallel-mode-specific sections).
3. Invoke Manager LLM (one-shot, same advisor runner used by `auto` mode).
4. Parse JSON response:

   ```ts
   interface ParallelManagerTurn {
     action: 'continue' | 'ask_user' | 'finalize' | 'terminate';
     summary_update?: string;        // new contents for summary.md
     directive?: string;             // new directive for control.md
     route_to?: string;              // when an [ASK_MANAGER] should go to a peer
     user_question?: string;         // when action=ask_user
     user_question_choices?: string[]; // optional for ASK_USER:choice form
     final_message?: string;         // when action in {finalize, terminate}
     reason: 'consensus' | 'drift' | 'pending_question' | 'idle' | 'continuing';
   }
   ```
5. Apply: write summary.md, update control.md (bumping `revision`), or surface ASK_USER through gateway.

**3. Termination supervisor**

A wall-clock supervisor that fires `finalize` when any of these hit:
- `maxDurationMs` elapsed → terminate, reason: `max_duration`
- `idleTimeoutMs` since last file mtime change → finalize, reason: `idle`
- User cancellation via existing team-pause mechanism → terminate, reason: `user_cancel`

Termination flow: Manager (or supervisor) writes `control.md` with `status: finalizing` → waits up to 20s for workers to write closing opinions → writes `status: terminated` and AbortControllers all still-running worker processes → emits final message via gateway.

### User Interaction

Reuses the existing `[ASK_USER]` / `[ASK_USER:choice]` flow:

1. Manager decides `action: ask_user`.
2. Writes `control.md` with `status: paused` + populated `User Question` section.
3. Posts the question through the existing ask-user surface (Telegram/Discord/Mac UI).
4. On user reply, gateway writes the answer into `control.md` under `Resume Note`, bumps revision, sets `status: running`.
5. Workers polling control.md pick up the resume note in their next iteration.

Multiple workers writing `[ASK_MANAGER]` simultaneously is fine; Manager arbitrates in its next pass (route to peer, or batch into a single user question, or note as parallel open questions).

### Resume Behavior

When a chat with `discussion.status ∈ {done, terminated}` receives a new user message:

1. Append new message to `topic.md` under a `## Continuation (<timestamp>)` header.
2. Reset `control.md` to fresh `status: running` (preserves opinion files & summary as starting state).
3. Set `chat.discussion.status = 'running'`, update `startedAt`.
4. Re-spawn worker loop and Manager loop. Worker prompts explicitly note this is a resumed discussion and that prior opinions are present.

## Component Map

| Component | New / Modified | File(s) |
|-----------|----------------|---------|
| Team config schema | Modified — add `dispatch: 'parallel'` + `parallel: {…}` | `packages/core/src/workspace.ts` |
| Chat schema | Modified — add `discussion` field | `packages/core/src/types/chat.ts` |
| Parallel runner | **New** — orchestrates worker + Manager + supervisor loops | `packages/gateway/src/parallel-team.ts` |
| Manager prompt builder (parallel variant) | **New** — extends advisor with parallel-mode sections | `packages/core/src/advisor.ts` (additive) or new `parallel-advisor.ts` |
| Worker prompt builder (parallel variant) | **New** — `buildParallelWorkerPrompt` with file-protocol instructions | `packages/core/src/workers.ts` |
| Control-file IO | **New** — small module reading/writing `control.md` with revision bump | `packages/core/src/discussion/control.ts` |
| Discussion file layout | **New** — directory create/destroy helpers | `packages/core/src/discussion/files.ts` |
| Gateway dispatch | Modified — route `dispatch: 'parallel'` to new runner | `packages/gateway/src/gateway.ts` |
| Chat deletion | Modified — also rm `chats/<id>/discussion/` | `packages/gateway/src/chats.ts` |
| Resume detection | Modified — when message arrives in done/terminated discussion chat, restart loop | `packages/gateway/src/chat-runner.ts` |

## Error Handling

- **Worker crashes**: discussion continues with surviving workers; Manager notes the loss in summary.
- **Manager LLM fails (parse / timeout)**: supervisor retries up to 3 times with exponential backoff, then forces `terminate` with `reason: drift` and a final message noting the manager-failure.
- **Worker writes malformed `[ASK_MANAGER]`**: ignored; Manager treats it as plain opinion text.
- **Control.md write race**: writes go through a per-discussion mutex; `revision` is monotonic; workers checking control.md compare against last-seen revision and re-read whole file if changed.
- **fs.watch unreliable on some FS**: 30s poll fallback covers this; do not rely on watch alone.

## Testing

- Unit: control-file parser/serializer roundtrip; Manager-response parser tolerates partial JSON; revision monotonicity under concurrent writes.
- Unit: parallel-mode advisor prompt builder (snapshot on representative inputs).
- Integration: stub worker runner that scripts opinion writes; verify Manager loop produces expected summary updates and terminates on simulated consensus.
- Integration: idle-timeout, max-duration, and user-cancel paths each terminate cleanly with correct reason.
- Integration: resume — discussion with existing opinions accepts a continuation message and re-enters running state.

## Open Questions

None blocking. Implementation will clarify:
- Exact debounce window for `fs.watch` (start at 2s, tune empirically).
- Whether Manager prompt should see full opinion files every turn or rolling diffs (start: full files, switch to diffs if context cost is high).
- Whether resume should clear summary.md or preserve it as prior context (current spec: preserve).
