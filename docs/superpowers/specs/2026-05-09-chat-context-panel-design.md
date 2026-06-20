# Chat Context Panel — Design

**Date:** 2026-05-09
**Surface:** `codey-mac` (Electron desktop app)
**Status:** Approved design, pending implementation plan

## Summary

Add a right-side panel to `ChatTab` that shows per-turn run context for the selected assistant message: tool calls timeline, files touched, attachments, run target (worker/team + agent/model), and pending-team state. The panel auto-follows the live turn during streaming and becomes sticky when the user clicks an older message.

This mirrors the OpenAI Codex pattern of "task sidebar" surfacing what the agent is doing. Codey's `ToolCallEntry` data is already rich enough to power it without new backend work.

## Goals

- Surface what the agent actually did for any given turn without making the user expand inline tool blocks or scroll through prose.
- Keep the chat stream itself uncluttered.
- Add zero new IPC for the panel's read-side; reuse existing `Chat` / `ChatMessage` state.

## Non-goals

- Artifact viewer / file preview pane (separate larger feature).
- Search within tool calls.
- Diff view for `Edit` / `Write` outputs — paths only.
- Cross-chat "all artifacts" browser like Claude Desktop.

## Architecture

A new component `codey-mac/src/components/ChatContextPanel.tsx` lives alongside `ChatTab.tsx`. `ChatTab` becomes a 2-column flex container:

- Left: existing message stream (unchanged layout).
- Right: `ChatContextPanel`, conditionally rendered when open.

Selection state (`selectedTurnId`, `followLatest`) lives locally in `ChatTab`. Per-chat panel-open preference persists on the `Chat` object. Global panel width persists in app prefs.

All data the panel renders is already on `ChatMessage` / `Chat`. No new IPC except a small `revealInFolder(absPath)` for the "Reveal in Finder" affordance.

## Data model changes

### `Chat` (in `packages/core/src/types/chat.ts`)

Add one optional field:

```ts
/** Per-chat preference for the right-side context panel.
 *  undefined = user hasn't decided; auto-open logic applies.
 *  true/false = explicit user choice; honored verbatim. */
contextPanelOpen?: boolean;
```

### App-level preferences

Add one global preference (existing app-pref store):

- `contextPanelWidth: number` — last user-set width in pixels. Default 340.

No changes to `ChatMessage`, `ToolCallEntry`, `ChatSelection`, or any backend code.

## Selection & follow-latest behavior

- `selectedTurnId` defaults to the latest assistant message's id.
- `followLatest = true` initially; in this mode `selectedTurnId` automatically tracks the newest assistant message as turns arrive (live during streaming).
- Clicking any assistant message in the stream sets `selectedTurnId` to that message and flips `followLatest = false`. The selected message gets a subtle highlight (left-border accent) so the user always sees what the panel reflects.
- A "Follow latest ↓" pill appears in the panel header when `followLatest === false`. Clicking it (or the user sending a new message) resets `followLatest = true` and snaps to the newest turn.
- User messages are not selectable — only assistant turns have run context.

## Auto-open logic (per-chat)

Triggered by the `contextPanelOpen` field:

- `true` → panel open on chat load.
- `false` → panel closed on chat load.
- `undefined` → panel closed initially. Watch incoming messages; on the first assistant turn that produces ≥1 `ToolCallEntry`, open the panel and persist `contextPanelOpen = true`.

After the first auto-open (or any explicit toggle), the panel respects the user's choice — toggling via the header button writes `true`/`false`. No further auto-opens for that chat.

A new chat starts with `undefined`, so the auto-open behavior repeats per chat (not global).

## Panel content

### 1. Header bar

One-line meta: `Turn N · 12:34:05 · 4.2s · 1,820 tok`.
Right side: "Follow latest ↓" pill (only when sticky), close (×) button.

`Turn N` is the assistant turn's index in the chat (1-based, counting only assistant messages).

### 2. Run target

Compact block:

- First line: `Worker: <name>` or `Team: <name> (step k/n: <currentWorker>)` if mid-team. If neither, `Direct chat`.
- Second line, muted: `<agent> · <model>`. Falls back to chat defaults when the message itself doesn't carry an override.

Step info for mid-team comes from `chat.pendingTeam` when the selected turn is the current paused turn; otherwise omitted.

### 3. Tool calls timeline

Vertical list, one row per `ToolCallEntry`. Each row:

- Status icon: `▶` for `tool_start`, `✓` for `tool_end`, `ⓘ` for `info`.
- Tool name in monospaced text.
- One-line `message` summary.

A `tool_start` and its matching `tool_end` (paired by `id`) collapse into a single row showing the end state. Click a row to expand:

- `input` — JSON, syntax-highlighted, scrollable within the row.
- `output` — text, truncated to ~2KB with a "Show more" affordance for the rest.

An unmatched `tool_start` (still running, or completed without an end) renders with a spinner until either its end arrives or the turn completes. If the turn completes with an unmatched start, render `(no result)` in muted text — never error.

### 4. Files touched

Derived from `toolCalls[].input` for known file-acting tools. Initial set:

- `Read`, `Edit`, `Write` → use `file_path`.
- `Bash` → no extraction (too noisy / ambiguous). Possible future enhancement.

Paths are deduped, sorted, and rendered relative to the workspace's `workingDir` (resolved via `chat.workspaceName`). Hover reveals two icons:

- "Reveal in Finder" — calls `codey-api.revealInFolder(absPath)`. If the file is missing or the workspace `workingDir` is unknown, no-op silently and dim the row.
- "Copy path" — `navigator.clipboard.writeText(absPath)`.

### 5. Attachments

Only shown if the **user message that immediately precedes the selected assistant turn** has `attachments`. Image MIME types render as a thumbnail grid; other types render as file chips. Clicking opens the file (existing app behavior).

### 6. Pending team

Shown only when `chat.pendingTeam` is set AND the selected turn is the latest assistant turn. Yellow callout:

- Title: `Waiting on input for <workerName>`.
- Body: the worker's question text.
- Hint: "Type a reply in the chat to resume the team."

### Empty state

If the selected turn has no `toolCalls`, sections 3 and 4 are replaced by a single muted line: "No tool activity for this turn." Sections 1, 2, 5, 6 still render when applicable.

## Layout, sizing, styling

- Third flex column to the right of the message stream. Default width **340px**.
- Resize handle on the panel's left edge, drag to resize. Width clamped to **260–520px**, persisted globally as `contextPanelWidth`.
- Closed state: a slim toggle button in the chat header (right side), side-panel glyph icon. Keyboard shortcut **⌘⇧I** (mac) toggles. Tooltip labels on hover.
- Visual style follows existing `theme.ts` and matches `ChatListPanel` (same divider weight, same surface tone). Internal sections reuse the card/spacing rhythm already in `ChatTab`.
- Panel content scrolls independently of the message stream. Long tool outputs scroll within the expanded row, not the whole panel.
- Responsive: when window inner width drops below ~900px, the panel auto-collapses without overwriting `contextPanelOpen`. It auto-restores when width permits.

## Data flow

- `useChats` already streams `ChatMessage` updates (tool-call entries append live). The panel reads from the same selector — no new subscription.
- In `followLatest` mode, `selectedTurnId` is computed each render as the id of the last `assistant` message. No effect needed.
- Persistence:
  - `Chat.contextPanelOpen` → through whichever existing path persists `Chat` mutations (same path used for `routes`, `selection`, etc.).
  - `contextPanelWidth` → app-pref store.

## Error handling

- "Reveal in Finder" failure → silent no-op, dim the row. No modal.
- Missing workspace `workingDir` → render absolute path verbatim; "Reveal" still attempts it.
- Unmatched `tool_start` after turn completes → `(no result)` in muted text.
- Truncated tool output → "Show more" expands; if `output` is missing entirely, omit the section.

## Testing

Manual test plan (no test runner configured in repo):

- Send a prompt that triggers multiple tool calls; verify timeline populates live, panel auto-opens on first tool call (new chat).
- Click an older assistant turn; verify panel switches, "Follow latest" pill appears, sending a new message snaps back.
- Toggle panel via header button and ⌘⇧I; verify state persists across chat switches.
- Resize panel; verify width persists across app restart and is clamped.
- Run a `/team` command that pauses with `[ASK_USER]`; verify pending-team callout appears on the latest turn.
- Test on a chat with no tool-call activity; verify empty-state text renders.
- Shrink window below 900px; verify panel collapses and restores.

## Open questions

None at design time. Implementation plan will surface anything that turns out to be ambiguous in code.
