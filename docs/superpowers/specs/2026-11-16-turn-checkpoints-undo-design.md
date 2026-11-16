# Turn checkpoints and undo

Date: 2026-11-16
Status: implemented on branch turn-checkpoints-undo; not run in the real app yet

## Goal

Let the user undo what an agent turn did to the files, with one click in the
Mac app, without adding commits to the user's branch or touching their staged
changes.

Inspired by T3 Code's checkpoints (`apps/server/src/orchestration-v2/CheckpointService.ts`,
`apps/server/src/vcs/GitVcsDriver.ts` in pingdotgg/t3code): a hidden git
commit per turn, pinned under a private ref.

## Scope

- **On:** chats in `isolated-worktree` mode (`Chat.executionMode`), for both
  single-agent and team turns. A team turn is one turn.
- **Off:** `shared-checkout` chats. Several chats can write the same folder at
  once, so a whole-folder snapshot would include other chats' edits, and an
  undo would erase them.
- **Off:** chats whose working directory is not a git repo.
- **Mac app only** for v1. Channels (Telegram, Discord, iMessage) get no undo.
- **Kept as is:** the per-write diffs from `write-diff-recorder.ts`. They still
  drive the Files panel. Checkpoints only add undo.

## How a checkpoint is taken

One helper, `captureCheckpoint(worktree, ref)`, in a new
`packages/gateway/src/turn-checkpoints.ts`:

1. Make a temp index file inside the repo's git dir
   (`<git-common-dir>/codey-checkpoint-index-<uuid>`).
2. With `GIT_INDEX_FILE` set to it:
   - `git read-tree HEAD` (skip when the repo has no commit yet)
   - `git add -A -- .`
   - `git write-tree` → tree id
3. `git commit-tree <tree> -p HEAD -m "codey checkpoint <ref>"` → commit id.
   HEAD as parent lets us tell later whether HEAD moved during the turn.
4. `git update-ref <ref> <commit>`.
5. Delete the temp index, always (`finally`).

The user's real index, branch and HEAD are never touched. Git-ignored files
(for example `node_modules`) are not captured, so undo never touches them.

Budget: 5 seconds for the whole capture. On timeout or any git error the turn
runs anyway, with no undo for it, and one warning goes to the log.

## Refs

```
refs/codey/chats/<chatId>/turns/<userMessageId>/before
refs/codey/chats/<chatId>/turns/<userMessageId>/after
refs/codey/chats/<chatId>/undo/<timestamp>     # safety snapshot taken by an undo
```

`before` is captured right before the agent starts; `after` right after the
turn ends (done, failed or stopped). We take `before` every turn, not "after of
the previous turn", because the user may edit files by hand between turns, and
undo must not erase those edits.

The **user message** that started the turn gets a small record (it exists
before the agent starts, and a team turn has many assistant messages):

```ts
// packages/core/src/types/chat.ts, on ChatMessage
checkpoint?: TurnCheckpoint;  // { before, after?, head, undone?: { at, safety } }
```

## Where it hooks in

In `gateway.ts` `sendToChatWithMemoryTrace`, next to where `WriteDiffRecorder`
is created (around the `const diffRecorder = new WriteDiffRecorder(...)` line):

- capture `before` once the working dir is resolved and the chat is known to
  be `isolated-worktree`;
- capture `after` in the same place that emits `sink({ type: 'done', ... })`,
  and also on the failed and stopped paths.

One lock per worktree path, shared by capture and undo, so they never overlap.

## Undo

New gateway method `undoTurn(chatId, messageId)` and IPC `chats:undoTurn`.

Refuse, with a plain message, when:

- a turn is running in this chat;
- the message has no `checkpoint.before`;
- HEAD has moved since `checkpoint.head` (the agent or the user committed).
  v1 does not rewrite history; the message says the commits are still there.

Otherwise:

1. Take a safety snapshot of the current folder to
   `refs/codey/chats/<chatId>/undo/<timestamp>`. This makes undo itself
   undoable ("Redo").
2. `git diff --name-status -z <before> <safety>` lists what differs.
3. For each path:
   - added since `before` → delete the file;
   - modified or deleted → write it back from `before` using a temp index
     (`read-tree <before>`, then `checkout-index -f -- <paths>`).
4. Mark this message and every later assistant message in the chat
   `checkpoint.undone`. Undoing turn K undoes all turns after K too; the
   confirm dialog lists them.

Redo = the same restore, using the safety ref as the source.

## Rewinding the agent's conversation

Undone messages get `undone: true` and leave the agent's context everywhere
`failed` ones do (history, catch-up, resume checkpoint, transcript slices,
compaction). The agents' own CLI sessions are rewound when the **next** turn
starts (`Chat.pendingRewind`), so Redo stays free until then.

Each turn records on its user message which session ran it
(`agentSession: { agent, sessionId, endId? }`). For each session that ran an
undone turn:

| Agent | How | Verified live 2026-11-16 |
|---|---|---|
| Claude Code | `--resume <id> --resume-session-at <endId of last kept turn>` (undocumented flag; the Agent SDK's `resumeSessionAt`). `endId` = uuid of the last `assistant` stream event. Later plain resumes stay rewound. | yes (claude 2.1.322) |
| Codex | start `codex app-server`, `thread/resume`, `thread/turns/list`, `thread/revert { beforeTurnId }`, close (`core/agents/codex-revert.ts`). No model call. | yes (codex-cli 0.167.0) |
| OpenCode | start `opencode serve` (one-off password, killed as a process group: it ignores SIGTERM), `GET /session/:id/message`, `POST /session/:id/fork { messageID }` at the first dropped user message. The fork is a new session; the anchor and kept turns' `agentSession` switch to it. (`core/agents/session-fork.ts`) | fork mechanics yes (opencode 1.19.5); its model calls fail locally, so "agent forgot" not seen |
| Pi | start `pi --mode rpc --session <id>`, `get_entries`, `fork { entryId }` at the first dropped user entry, `get_state` for the new session id; switch to it as above. | fork mechanics yes (pi 1.5.1); provider out of balance locally, so "agent forgot" not seen |
| Cursor, Grok | drop the session; the next turn bootstraps a fresh one from history without the undone turns (one history read). T3 Code refuses Cursor and starts Grok empty. | n/a |

A session that ran only undone turns, or a failed rewind, also falls back to a
fresh session. The anchor's `syncedThroughMessageId` moves back to the end of
the last kept turn, so other agents' turns in between are still caught up.

## UI (Mac app)

- An **Undo** button in the hover row of the user message that has `checkpoint.before`,
  only in worktree chats, only when no turn is running.
- A confirm dialog: how many turns are undone, how many files change.
- After undo: the undone turns are dimmed, and the first one shows a
  "Files undone from here · Redo" line.

## Cleanup

- Delete a chat's `refs/codey/chats/<chatId>/` when the chat is deleted or its
  worktree is removed.
- Keep at most the last 50 turns per chat; older turns' refs are deleted and
  their Undo button disappears.

## Tests

Unit tests against real temp git repos (no mocks for git):

- capture leaves the index, HEAD and branch unchanged; staged changes survive;
- capture of a repo with no commits;
- undo restores modified, deleted and added files; ignored files untouched;
- undo refused while running, when HEAD moved, with no checkpoint;
- redo puts the undone state back;
- undo of turn K also marks later turns undone;
- shared-checkout chats never capture;
- capture timeout lets the turn run without a checkpoint.

## Open questions

- Should a chat in shared-checkout mode show a hint ("switch to a worktree to
  get undo")? Default: no hint in v1.
- Team turns where bots write in parallel: one before/after pair for the
  whole team turn. Fine for v1.

## Not verified

Nothing here has run yet. Capture time on a large repo is unmeasured; the
5-second budget is copied from T3 Code.
