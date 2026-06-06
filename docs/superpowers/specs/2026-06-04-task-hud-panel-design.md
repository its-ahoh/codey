# Task HUD Panel — Design

**Date:** 2026-06-04
**Branch:** `feat/task-hud-panel`
**Status:** Approved design, pending implementation plan

## Problem

When a user juggles many async AI chats in the codey-mac app, switching between
them causes "brain fog": each chat is a different feature in a different state,
and re-reading the transcript to re-orient is slow and disorienting. The user
needs to glance at a chat and immediately understand **what it is, where it is,
and what to do next** — without re-reading the conversation.

## Goal

Add a **Task HUD** to the right-side context panel of each chat: a compact,
glanceable, auto-generated summary of that single chat's task. It answers four
questions, top to bottom, in a deliberate "re-orient → act → trace" flow:

1. **Goal** — what this task is, in one line.
2. **Current State** — how far along, and whether it's blocked / waiting.
3. **Next Action** — the single most useful thing to do right now.
4. **Timeline** — key steps, actions, and decisions in reverse-chronological
   order (newest first); the newest entry is expanded to serve as the
   "catch-up / resume" view.

This release is scoped to **a single chat's panel only**. A cross-chat overview
(the "party roster" idea explored during brainstorming) is explicitly out of
scope for now.

## Non-Goals (YAGNI)

- No multi-task / cross-chat overview board.
- No goal metadata row (workspace name, agent, start date) — removed by request.
- No changes to the existing context-panel tabs (current / files / qq).
- No new visual style — reuse the existing Codey "Classic" palette.

## Information Model

A single structured object, regenerated on demand, attached to the chat:

```ts
interface TaskBrief {
  goal: string;                 // one-line task goal
  state: {
    progress: number;           // 0–100, best-effort
    stepLabel?: string;         // e.g. "步骤 3 / 5" or a phase name
    status: 'working' | 'waiting' | 'blocked' | 'done';
  };
  nextAction?: {
    text: string;               // the recommended next step / open question
    detail?: string;            // one-line elaboration
    messageId?: string;         // anchor: which assistant message raised it
  };
  timeline: TaskEvent[];        // reverse-chronological, newest first
  generatedAt: number;          // when the Aide produced this
}

interface TaskEvent {
  kind: 'progress' | 'action' | 'decision' | 'dropped';
  text: string;                 // headline
  why?: string;                 // one-line rationale (decisions especially)
  when?: number;                // timestamp if derivable
  detail?: string[];            // sub-bullets — populated for the newest entry
}
```

The **newest** timeline entry (top) is rendered expanded with `detail[]`
sub-bullets and a "距上次 N 小时" marker. This replaces the separate "Resume
Brief" block explored earlier: the resume view *is* the expanded head of the
timeline. Older entries render as one-liners.

## Architecture

The codebase already has an **Aide** subsystem (`packages/core/src/aide.ts`,
`aide-tasks.ts`) that runs small LLM tasks against a chat (`runAide`), with
`summarizeChatMessages` and `generateChatTitle` as precedents. The brief is a
new Aide task following the same pattern.

### Data layer — `packages/core`

- New Aide task `generateTaskBrief(chat, opts): Promise<TaskBrief>` in
  `aide-tasks.ts`. It builds a prompt from the chat's messages and tool calls
  and asks the model to return the structured `TaskBrief` (JSON). It reuses the
  same truncation guards (`MAX_MSG_CHARS`) and `runAide` plumbing.
- New field on `Chat`: `taskBrief?: TaskBrief` (in `types/chat.ts`), persisted
  like `compaction`. Cached so reopening the panel doesn't always re-run the
  Aide.
- **Generation timing: on-demand.** The brief is generated when the user opens
  the Task tab, not after every turn. If `chat.taskBrief` is missing or stale
  (chat has new messages since `generatedAt`), the panel triggers a regenerate;
  otherwise it shows the cached brief. This keeps token cost proportional to
  actual use.

### Render layer — `codey-mac`

- `ChatContextPanel` gains the Task HUD. Decision for the plan to settle:
  whether it is a **new tab** alongside current/files/qq, or folded into the
  existing "current" tab. (Brainstorm mockups showed it as its own tab; the
  user later said the other tabs are "not needed for now" — to be confirmed in
  the plan as a UI-placement detail. Either way the four blocks render
  identically.)
- Pure presentation: reads `chat.taskBrief`, renders the four sections using the
  Classic palette tokens from `theme.ts` (`surface`, `border`, `fg/fg2/fg3`,
  `accent` #0A84FF, `green` #32D74B, `yellow` #FFD60A). No business logic in the
  view.
- Loading/empty states: show a lightweight "生成中…" while the Aide runs, and a
  graceful empty state for brand-new chats with no task yet.

### Interaction

- **Next Action "回答" button is clickable.** Clicking it returns focus to the
  chat composer (input box) so the user can immediately respond. If
  `nextAction.messageId` is present, the chat may also scroll to that message.
  Wiring: the panel calls an `onAnswerNextAction(messageId?)` callback that the
  parent (`ChatTab`) uses to focus the composer (and optionally scroll), reusing
  existing focus/scroll plumbing already present for the qq tab and
  `onScrollToStep`.
- **Timeline "全部 ›"** expands the full list (older entries are collapsed by
  default).

## Visual Reference

Final approved mockup: `/tmp/codey-task-hud4.html` (v4, meta row and tab bar
removed). Four stacked sections — Goal, Current State (progress bar + status
pill), Next Action (text + blue button), Timeline (expanded head + collapsed
history) — in the Classic dark palette.

## Data Flow

```
User opens Task tab
   → ChatTab checks chat.taskBrief freshness
   → if stale/missing: call core generateTaskBrief(chat) (async, non-blocking)
        → runAide(prompt) → parse JSON → TaskBrief
        → persist to chat.taskBrief, updatedAt
   → ChatContextPanel renders the four sections from chat.taskBrief
User clicks "回答"
   → onAnswerNextAction(messageId?) → focus composer (+ optional scroll)
```

## Error Handling

- Aide returns malformed JSON → parse defensively; fall back to a minimal brief
  (goal from chat title, empty timeline) and log; never crash the panel.
- Aide call fails / times out → keep showing the last cached brief if any;
  otherwise show a retry affordance in the empty state.
- Very short / brand-new chats → show a friendly empty state rather than an
  Aide call on near-empty input.

## Testing

- **core:** unit-test the prompt builder and the JSON parser/validator for
  `generateTaskBrief` (well-formed, malformed, partial responses) with the Aide
  call mocked. `codey-mac` uses vitest (precedent:
  `notificationLogic.test.ts`).
- **codey-mac:** component-level tests for `ChatContextPanel` rendering each
  `status` variant, the expanded-head timeline, and the empty/loading states;
  test that "回答" invokes `onAnswerNextAction` with the right messageId.

## Open Questions for the Plan

1. Task HUD as a **new tab** vs. folded into the existing "current" tab —
   resolve as a placement detail during planning.
2. Exact staleness rule for "regenerate" (e.g. any new message since
   `generatedAt`, or a small debounce).
