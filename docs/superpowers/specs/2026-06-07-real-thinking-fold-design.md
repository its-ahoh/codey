# Real Thinking Fold — Design

**Date:** 2026-06-07
**Status:** Approved (pending spec review)

## Problem

In the codey-mac chat UI, completed team steps render through `StepBody`
(`codey-mac/src/components/ChatTab.tsx`), which splits the worker's output by
paragraph and **shows only the last paragraph by default**, collapsing every
earlier paragraph behind a "Show thinking (N paragraphs)" toggle.

This heuristic — "last paragraph = answer, everything before = collapsible
thinking" — is wrong for substantive work. The earlier paragraphs usually carry
the actual result (what was reviewed, what was decided, what was done), not
throwaway reasoning. Collapsing them by default hides key information; e.g. a
worker output ending in "That covers both the review and the brainstorming"
leaves only that closing line visible and the substance hidden.

There is no real "thinking" signal today: the claude-code adapter only consumes
`text_delta` events and silently drops the model's actual extended-thinking
blocks. The UI fakes thinking by paragraph position.

## Goal

Replace fake paragraph-position folding with a real one, governed by one rule:

> **有真用真,无则不折** — if the agent emits real extended-thinking, capture it
> and fold *that* (answer text never folds); if there is no real thinking signal,
> do not fold at all.

## Decisions (locked)

- **Signal source:** real model extended-thinking when available; otherwise no
  fold. Drop the paragraph-position heuristic entirely.
- **Scope:** unified across all assistant messages (regular + team steps). Real
  thinking capture is implemented for **claude-code first**; codex/opencode fall
  to the safe "no signal → no fold" default until later.
- **Streaming UX:** thinking displays live while the model is thinking, then
  auto-collapses once answer text begins (matching the official Claude UI).
- **Persistence:** thinking is persisted on the message record (collapsed), so
  reopening a chat can still expand it. Accepted cost: slightly larger messages.
- **Transport:** dedicated `thinking` stream event (not inline-tagged text).
- **Delivery shape:** two layers.
  - **L0 (stop the bleeding):** remove the `StepBody` fake fold → team steps show
    full output. This alone resolves the information-loss complaint.
  - **L1 (enhancement):** real thinking channel adapter → transport → render.

## Data Flow

```
claude-code CLI (stream-json: thinking content blocks)
  → ClaudeCodeAdapter captures thinking_delta
      → request.onThinking(text)            (live)
      → AgentResponse.thinking              (final, for persistence)
  → gateway emits ChatStreamEvent { type:'thinking', token, step? }
  → codey-mac useChats reducer accumulates (per-message / per-step)
  → ChatTab <ThinkingBlock> renders: live while thinking, auto-collapse on answer
  → answer body rendered in full, never folded
persistence: thinking stored on the message record (collapsed by default)
```

## Components

### 1. Adapter capture — `packages/core/src/agents/claude-code.ts`

- Extend the local `StreamEvent` type: `event.delta` gains `thinking?: string`
  (alongside existing `text?`). `content_block.type` already present.
- In `processEvent`:
  - `content_block_start` with `cb.type === 'thinking'` → enter thinking-collect
    state.
  - `content_block_delta` with `delta.type === 'thinking_delta'` → accumulate
    `thinkingText += delta.thinking` and call `request.onThinking?.(delta.thinking)`;
    set `streamedThinkingFromDeltas = true`.
  - Final `assistant` event: a `block.type === 'thinking'` with `block.thinking`
    is accumulated only if `!streamedThinkingFromDeltas` (mirrors the existing
    text de-dup at lines 206–212).
  - `redacted_thinking` blocks (no plaintext) → skipped, nothing emitted.
- Return `thinking: thinkingText.trim() || undefined` on `AgentResponse`.

### 2. Type contract — `packages/core/src/types/index.ts`

- `AgentRequest.onThinking?: (text: string) => void`
- `AgentResponse.thinking?: string`

### 3. Transport — `packages/gateway/src/chat-runner.ts` + `gateway.ts`

- `ChatStreamEvent` gains `| { type: 'thinking'; chatId: string; token: string; step?: number }`.
- `done` event gains `thinking?: string` (regular single-agent messages).
- Regular chat paths (`gateway.ts` ~2860 / ~2910): wire
  `onThinking: (t) => sink({ type:'thinking', chatId, token: t })`.
- Team path: `runWorkerStep` threads `onThinking` through to the agent request
  (near `gateway.ts:157`); each step tags its events with `step`:
  `sink({ type:'thinking', chatId, token: t, step: stepNum })`.
- Persistence: regular → `done.thinking = response.thinking`. Team → thinking
  collected per step into `thinkingByStep` and stored with the message.
  - **Open integration point:** the exact message persistence store was not
    located during exploration. The first plan task is to find where chat
    messages are persisted and add the optional thinking field there. The design
    contract is: "an optional thinking payload hangs off the message record"
    (string for single-agent, step-keyed map for team).

### 4. Render — `codey-mac/src/hooks/useChats.tsx` + `ChatTab.tsx`

- `ChatMessage` gains `thinking?: string` and `thinkingByStep?: Record<number, string>`.
- Reducer: new `case 'thinking'` accumulates into in-flight state
  (regular → `thinking`; team → `thinkingByStep[step]`) and sets
  `agentStatus: 'thinking'`. The first answer `stream` token flips status to
  `'writing'` (existing behavior) — this is the **auto-collapse trigger**.
  `completeSend` writes thinking onto the persisted message.
- New `<ThinkingBlock>` component:
  - Thinking phase (streaming, answer not yet started) → expanded, live.
  - Answer started / message complete → collapsed by default with a
    "Show thinking" toggle; manual toggle wins (reuse the existing
    `expandedSteps` Set keyed per block).
- **Remove the `StepBody` paragraph-split fake fold (L0).** Team steps render
  `<ThinkingBlock>` (that step's thinking) + full output. `splitParagraphs` is
  removed (its only consumer is `StepBody`).
- Regular assistant messages: when `msg.thinking` is present, render
  `<ThinkingBlock>` above the full `<Markdown>` body.

## Error Handling / Edge Cases

- No thinking emitted (model didn't think, or non-claude-code agent) → field is
  `undefined` → no fold, full output shown ("无则不折").
- Thinking present but empty after trim → treated as none.
- `redacted_thinking` → not displayed.
- Stream interrupted (stop / error) → accumulated thinking is best-effort
  retained, consistent with how partial content is handled today.
- Team run where some workers think and others don't → per-step keyed,
  independent; absent steps simply show no ThinkingBlock.

## Testing

- **Adapter unit test:** feed synthetic stream-json containing thinking blocks;
  assert the `onThinking` call sequence and final `AgentResponse.thinking`.
  Cover: deltas only, final-assistant-only (no deltas), redacted, none.
- **Reducer unit test:** thinking tokens accumulate; `agentStatus` transitions
  thinking → writing; `completeSend` persists; team thinking groups by step.
- **`teamMessageFormat` regression:** body parsing unaffected (thinking is no
  longer inline).
- **ThinkingBlock behavior:** auto-collapse on answer start, manual toggle
  override — component or manual verification.
- **Environment note:** vitest/tsc require nvm `v22.17.1`; a fresh worktree needs
  dependency reinstall + build of core and gateway.

## Out of Scope

- Real thinking capture for codex / opencode (they fall to "no fold" for now).
- Any change to the team message text format / `parseTeamMessage` (thinking is
  carried out-of-band, not inline).
