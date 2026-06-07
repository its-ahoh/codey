# Real Thinking Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the codey-mac fake "show thinking" paragraph fold with a real one driven by the model's actual extended-thinking: capture it from claude-code, transport it on a dedicated stream event, render it live with auto-collapse; when there is no real thinking, show full output unfolded.

**Architecture:** claude-code emits `thinking` content blocks over stream-json; the adapter captures them into a new `onThinking` callback + `AgentResponse.thinking`. The gateway forwards them as a new `ChatStreamEvent { type:'thinking', token, step? }` and persists thinking on the `ChatMessage`. codey-mac accumulates thinking (per-message / per-team-step), renders a `<ThinkingBlock>` that is live while thinking and auto-collapses once answer text starts. The old `StepBody` paragraph heuristic is deleted.

**Tech Stack:** TypeScript (monorepo: `@codey/core`, `@codey/gateway`), React (codey-mac, Electron), vitest.

**Spec:** `docs/superpowers/specs/2026-06-07-real-thinking-fold-design.md`

**Environment (REQUIRED before any test/build):**
```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1   # default node v16 cannot run vitest/tsc
```
A fresh worktree also needs `npm install` at the repo root and a build of core + gateway before the mac app can import them.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/core/src/types/index.ts` | Agent request/response contract | Add `onThinking` + `AgentResponse.thinking` |
| `packages/core/src/types/chat.ts` | Persisted `ChatMessage` (shared by gateway + mac) | Add `thinking?` + `thinkingByStep?` |
| `packages/core/src/agents/thinking-stream.ts` | **NEW** pure classifier for stream-json thinking blocks | Create |
| `packages/core/src/agents/thinking-stream.test.ts` | **NEW** unit tests for the classifier | Create |
| `packages/core/src/agents/claude-code.ts` | claude-code adapter | Capture thinking, emit `onThinking`, return `thinking` |
| `packages/gateway/src/chat-runner.ts` | Stream event protocol | Add `thinking` event + `done.thinking` |
| `packages/gateway/src/gateway.ts` | Chat + team orchestration | Wire `onThinking`, persist thinking, emit on `done` |
| `codey-mac/src/components/thinkingState.ts` | **NEW** pure collapse-decision helper | Create |
| `codey-mac/src/components/thinkingState.test.ts` | **NEW** unit tests | Create |
| `codey-mac/src/hooks/useChats.tsx` | Stream → state reducer | Accumulate thinking, persist on complete |
| `codey-mac/src/components/ChatTab.tsx` | Message rendering | Add `<ThinkingBlock>`, delete `StepBody` fake fold |

---

## Task 1: Thinking contract on the agent types

**Files:**
- Modify: `packages/core/src/types/index.ts` (AgentRequest ~line 109, AgentResponse ~line 165)
- Modify: `packages/core/src/types/chat.ts` (ChatMessage ~line 21-42)

- [ ] **Step 1: Add `onThinking` to `AgentRequest`**

In `packages/core/src/types/index.ts`, directly under the existing `onStream` line:

```typescript
  onStream?: (text: string) => void;
  /** Streamed extended-thinking text (model reasoning), separate from the answer. */
  onThinking?: (text: string) => void;
  onStatus?: (update: StatusUpdate) => void;
```

- [ ] **Step 2: Add `thinking` to `AgentResponse`**

In the same file, inside `AgentResponse` (next to `output`):

```typescript
export interface AgentResponse {
  success: boolean;
  output: string;
  /** Full extended-thinking text captured this run, if the model emitted any. */
  thinking?: string;
  error?: string;
```

- [ ] **Step 3: Add thinking fields to `ChatMessage`**

In `packages/core/src/types/chat.ts`, inside `ChatMessage`, after `durationSec`:

```typescript
  /** Extended-thinking for a single-agent assistant message (collapsed in UI). */
  thinking?: string;
  /** Per-team-step extended-thinking, keyed by step number. */
  thinkingByStep?: Record<number, string>;
```

- [ ] **Step 4: Typecheck core**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd packages/core && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/index.ts packages/core/src/types/chat.ts
git commit -m "feat(core): add thinking fields to agent + chat message types"
```

---

## Task 2: Pure thinking-stream classifier (TDD)

The adapter's event handling is a closure inside `run()` and hard to test directly. Extract the thinking decision into a pure, exported function and unit-test it. The shape mirrors the `StreamEvent` already declared in `claude-code.ts` (`event.event.type`, `event.event.content_block.type`, `event.event.delta`).

**Files:**
- Create: `packages/core/src/agents/thinking-stream.ts`
- Test: `packages/core/src/agents/thinking-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/agents/thinking-stream.test.ts
import { describe, it, expect } from 'vitest';
import { thinkingDeltaFrom, isThinkingBlockStart } from './thinking-stream';

describe('thinkingDeltaFrom', () => {
  it('extracts text from a thinking_delta', () => {
    expect(thinkingDeltaFrom({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm ' } },
    })).toBe('hm ');
  });

  it('returns null for a text_delta', () => {
    expect(thinkingDeltaFrom({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    })).toBeNull();
  });

  it('returns null for non-delta events', () => {
    expect(thinkingDeltaFrom({ type: 'assistant' })).toBeNull();
  });
});

describe('isThinkingBlockStart', () => {
  it('is true for a thinking content_block_start', () => {
    expect(isThinkingBlockStart({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } },
    })).toBe(true);
  });

  it('is false for a tool_use start', () => {
    expect(isThinkingBlockStart({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    })).toBe(false);
  });

  it('ignores redacted_thinking (no plaintext to show)', () => {
    expect(isThinkingBlockStart({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'redacted_thinking' } },
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd packages/core && npx vitest run src/agents/thinking-stream.test.ts
```
Expected: FAIL — `Cannot find module './thinking-stream'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/agents/thinking-stream.ts

/** Minimal shape of a claude-code stream-json event we inspect for thinking. */
export interface ThinkingProbe {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; thinking?: string; text?: string };
    content_block?: { type?: string; name?: string };
  };
}

/** Returns the thinking text of a thinking_delta event, or null if not one. */
export function thinkingDeltaFrom(event: ThinkingProbe): string | null {
  if (event.type !== 'stream_event') return null;
  if (event.event?.type !== 'content_block_delta') return null;
  const delta = event.event.delta;
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return delta.thinking;
  }
  return null;
}

/** True when this event opens a (non-redacted) thinking content block. */
export function isThinkingBlockStart(event: ThinkingProbe): boolean {
  if (event.type !== 'stream_event') return false;
  if (event.event?.type !== 'content_block_start') return false;
  return event.event.content_block?.type === 'thinking';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd packages/core && npx vitest run src/agents/thinking-stream.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/thinking-stream.ts packages/core/src/agents/thinking-stream.test.ts
git commit -m "feat(core): pure classifier for claude-code thinking stream events"
```

---

## Task 3: Capture thinking in the claude-code adapter

**Files:**
- Modify: `packages/core/src/agents/claude-code.ts` (StreamEvent type ~40-45; `processEvent` ~167-212; final resolve where `AgentResponse` is built)

- [ ] **Step 1: Extend the local StreamEvent delta type**

In the `event.delta` field of the `StreamEvent` interface (~line 43), add `thinking`:

```typescript
    delta?: { type?: string; text?: string; thinking?: string };
```

- [ ] **Step 2: Import the classifier and add accumulators**

At the top of `claude-code.ts` with the other imports:

```typescript
import { thinkingDeltaFrom, isThinkingBlockStart } from './thinking-stream';
```

Inside `run()`, next to `let streamedText = '';` (~line 140):

```typescript
      let streamedText = '';
      let thinkingText = '';
      let streamedThinkingFromDeltas = false;
```

- [ ] **Step 3: Handle thinking in `processEvent`**

In `processEvent`, extend the `content_block_start` branch (~172) to recognise thinking starts, and the `content_block_delta` branch (~178) to capture thinking deltas. Replace those two branches with:

```typescript
        } else if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
          const cb = event.event.content_block;
          if (cb?.type === 'tool_use' && cb.name === 'AskUserQuestion') {
            collectingAskUser = true;
            askUserInputJson = '';
          }
          // thinking blocks need no setup; isThinkingBlockStart kept for symmetry/future use
          void isThinkingBlockStart;
        } else if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
          const thinking = thinkingDeltaFrom(event);
          if (thinking !== null) {
            thinkingText += thinking;
            request.onThinking?.(thinking);
            streamedThinkingFromDeltas = true;
          }
          const delta = event.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            streamedText += delta.text;
            request.onStream?.(delta.text);
            streamedFromDeltas = true;
          } else if (collectingAskUser && delta?.type === 'input_json_delta') {
            askUserInputJson += (delta as any).partial_json ?? (delta as any).text ?? '';
          }
        }
```

- [ ] **Step 4: Capture thinking from the final `assistant` event (no-delta fallback)**

In the `assistant` event loop (~206), add a `thinking` block branch alongside the existing `text`/`tool_use` branches:

```typescript
          for (const block of event.message.content) {
            if (block.type === 'thinking' && (block as any).thinking) {
              if (!streamedThinkingFromDeltas) {
                thinkingText += (block as any).thinking;
              }
            } else if (block.type === 'text' && block.text) {
              if (!streamedFromDeltas) {
                streamedText += block.text;
                request.onStream?.(block.text);
              }
            } else if (block.type === 'tool_use' && block.name) {
```

(Leave the rest of the `tool_use` branch unchanged.)

- [ ] **Step 5: Return `thinking` on every resolve path**

Find each place that builds the success `AgentResponse` (the object literal passed to `safeResolve`/`resolve` with `output:` and `success: true`). Add:

```typescript
        thinking: thinkingText.trim() || undefined,
```

next to `output:`. (There is one primary success resolve in the `result`/`close` handler; add the field there. Error/early resolves that have no output may omit it.)

- [ ] **Step 6: Typecheck core**

Run:
```bash
cd packages/core && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Build core (gateway + mac import the compiled output)**

Run:
```bash
cd packages/core && npm run build
```
Expected: builds to `dist/` with no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/agents/claude-code.ts
git commit -m "feat(core): capture extended-thinking in claude-code adapter"
```

---

## Task 4: Add thinking to the gateway stream protocol

**Files:**
- Modify: `packages/gateway/src/chat-runner.ts` (ChatStreamEvent ~6-15)

- [ ] **Step 1: Add the `thinking` event and `done.thinking`**

In `ChatStreamEvent`, add a new member after the `stream` line and extend `done`:

```typescript
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'thinking'; chatId: string; token: string; step?: number }
  | { type: 'done'; chatId: string; response: string; thinking?: string; tokens?: number; durationSec?: number; title?: string; choices?: string[]; userQuestion?: { question: string; options: Array<{ label: string; description?: string }> } }
```

- [ ] **Step 2: Typecheck gateway**

Run:
```bash
cd packages/gateway && npx tsc --noEmit
```
Expected: no errors (consumers don't yet emit/handle the new event; that's fine).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chat-runner.ts
git commit -m "feat(gateway): add thinking stream event + done.thinking"
```

---

## Task 5: Wire thinking for single-agent chats

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (single-agent run path ~2860/2910; assistant persist ~3924-3934; done emit ~3953)

- [ ] **Step 1: Forward thinking deltas on the single-agent run**

At the single-agent `onStream` sink site (~2860), add an `onThinking` sibling. It currently reads:

```typescript
        onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
        onStatus: (_update: any) => { /* status forwarded via sink elsewhere */ },
```

Change to capture thinking both for live streaming and for persistence:

```typescript
        onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
        onThinking: (text: string) => sink({ type: 'thinking', chatId, token: text }),
        onStatus: (_update: any) => { /* status forwarded via sink elsewhere */ },
```

Apply the same addition at the second single-agent sink site (~2910).

- [ ] **Step 2: Persist thinking on the assistant message**

Where the assistant `ChatMessage` is built before `appendMessage` (~3924), the run's `AgentResponse` is in scope (the variable holding `response`/`res` with `.output`). Add `thinking` to the message:

```typescript
        role: 'assistant',
        content: output,
        thinking: response.thinking,
        // ...existing fields (timestamp, isComplete, tokens, etc.)
```

(Use whatever local name the response has at this site — confirm it is the `AgentResponse` from the single-agent run.)

- [ ] **Step 3: Emit thinking on `done`**

At the `done` sink (~3953):

```typescript
      sink({ type: 'done', chatId, response: output, thinking: response.thinking, tokens, durationSec, title: finalTitle, choices: surfacedChoices, userQuestion: agentUserQuestion });
```

- [ ] **Step 4: Build gateway**

Run:
```bash
cd packages/gateway && npm run build
```
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): stream + persist thinking for single-agent chats"
```

---

## Task 6: Wire thinking for team steps

Team steps run through `runWorkerStep` (~131) and stream into one combined message. Each step's thinking must be tagged with its step number so the UI can key it.

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (`runWorkerStep` request build ~155-160; team step sink sites ~2852, ~3054; team assistant persist path)

- [ ] **Step 1: Thread `onThinking` through `runWorkerStep`**

`runWorkerStep` builds the agent request (~155) with `onStream: opts.onStream` / `onStatus: opts.onStatus`. Add an `onThinking` opt and pass it through:

```typescript
  private async runWorkerStep(opts: {
    // ...existing opts
    onStream?: (text: string) => void;
    onThinking?: (text: string) => void;
    onStatus?: (u: StatusUpdate) => void;
    // ...
  }): Promise<{ response: AgentResponse }> {
    // ...
      onStream: opts.onStream,
      onThinking: opts.onThinking,
      onStatus: opts.onStatus,
```

- [ ] **Step 2: Emit step-tagged thinking at each team step call**

At each `runWorkerStep({ ... })` call inside the team loop that has a `sink` and a current `step`/`stepNum` in scope (~2852, ~3054), add:

```typescript
        onThinking: (text: string) => sink({ type: 'thinking', chatId, token: text, step: stepNum }),
```

(Use the loop's actual step variable — `step` or `stepNum` — at each site.)

- [ ] **Step 3: Collect per-step thinking and persist `thinkingByStep`**

In the team assembly that pushes `parts` (~2200, where `{ step, worker, output }` is pushed), also capture the step's `response.thinking`. Build a `thinkingByStep` map as steps complete:

```typescript
      const thinkingByStep: Record<number, string> = {};
      // ...inside the per-step loop, after the step's response resolves:
      if (response.thinking) thinkingByStep[step] = response.thinking;
```

When the team assistant `ChatMessage` is persisted, attach it:

```typescript
        role: 'assistant',
        content: assembledTeamText,
        thinkingByStep: Object.keys(thinkingByStep).length ? thinkingByStep : undefined,
```

(If team runs persist via a shared helper with the single-agent path, attach `thinkingByStep` there instead; the field is optional and ignored when empty.)

- [ ] **Step 4: Build gateway**

Run:
```bash
cd packages/gateway && npm run build
```
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): stream + persist per-step thinking for team runs"
```

---

## Task 7: Accumulate thinking in the mac reducer

**Files:**
- Modify: `codey-mac/src/hooks/useChats.tsx` (InFlight ~6-12; Action union ~34-40; reducer cases; `onEvent` switch ~325-365)

- [ ] **Step 1: Extend `InFlight` with thinking buffers**

In the `InFlight` interface:

```typescript
interface InFlight {
  assistantMessageId: string
  userMessageId: string
  agentStatus: 'idle' | 'thinking' | 'working' | 'writing'
  queuedPosition?: number
  thinking?: string
  thinkingByStep?: Record<number, string>
  // ...existing fields
}
```

- [ ] **Step 2: Add the `thinkingToken` action**

In the Action union (~34):

```typescript
  | { type: 'thinkingToken'; chatId: string; token: string; step?: number }
```

- [ ] **Step 3: Handle `thinkingToken` in the reducer**

Add a case (near `streamToken`, ~151). Accumulate into the in-flight buffer and set `agentStatus: 'thinking'`:

```typescript
    case 'thinkingToken': {
      const chat = state.chats.find(c => c.id === action.chatId)
      const fl = chat ? state.inFlight[chat.id] : undefined
      if (!chat || !fl) return state
      const next: InFlight = { ...fl, agentStatus: 'thinking' }
      if (action.step === undefined) {
        next.thinking = (fl.thinking ?? '') + action.token
      } else {
        next.thinkingByStep = { ...(fl.thinkingByStep ?? {}), [action.step]: (fl.thinkingByStep?.[action.step] ?? '') + action.token }
      }
      return { ...state, inFlight: { ...state.inFlight, [chat.id]: next } }
    }
```

- [ ] **Step 4: Mirror thinking onto the live assistant message**

So `<ThinkingBlock>` can render mid-stream, also write the buffer onto the in-flight assistant `ChatMessage`. In the same case, before returning, map the message (mirror how `streamToken` updates `m.content`):

```typescript
      const messages = chat.messages.map(m =>
        m.id === fl.assistantMessageId
          ? { ...m, thinking: next.thinking, thinkingByStep: next.thinkingByStep }
          : m
      )
      const chats = state.chats.map(c => c.id === chat.id ? { ...c, messages } : c)
      return { ...state, chats, inFlight: { ...state.inFlight, [chat.id]: next } }
```

(Replace the simpler return from Step 3 with this fuller one.)

- [ ] **Step 5: Persist thinking in `completeSend`**

The `completeSend` case (~190) sets final fields on the message. The buffered thinking already lives on the message from Step 4; ensure `completeSend` does not clobber it — when it spreads `{ ...m, content: action.content, ... }`, `thinking`/`thinkingByStep` survive because they are not overwritten. No change needed unless `completeSend` rebuilds the message from scratch; if it does, add `thinking: m.thinking, thinkingByStep: m.thinkingByStep`.

- [ ] **Step 6: Dispatch on the `thinking` stream event**

In the `onEvent` switch (~354, next to `case 'stream'`):

```typescript
        case 'thinking':
          dispatch({ type: 'thinkingToken', chatId: ev.chatId, token: ev.token, step: ev.step })
          break
```

- [ ] **Step 7: Typecheck mac**

Run:
```bash
cd codey-mac && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx
git commit -m "feat(codey-mac): accumulate streamed thinking into chat state"
```

---

## Task 8: Pure collapse-decision helper (TDD)

The `<ThinkingBlock>` needs a clear rule for default expand/collapse. Extract it into a pure, tested function.

**Files:**
- Create: `codey-mac/src/components/thinkingState.ts`
- Test: `codey-mac/src/components/thinkingState.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// codey-mac/src/components/thinkingState.test.ts
import { describe, it, expect } from 'vitest'
import { defaultThinkingExpanded } from './thinkingState'

describe('defaultThinkingExpanded', () => {
  it('expands while thinking and no answer yet', () => {
    expect(defaultThinkingExpanded({ hasAnswer: false, isComplete: false })).toBe(true)
  })
  it('collapses once answer text has started', () => {
    expect(defaultThinkingExpanded({ hasAnswer: true, isComplete: false })).toBe(false)
  })
  it('collapses when the message is complete', () => {
    expect(defaultThinkingExpanded({ hasAnswer: true, isComplete: true })).toBe(false)
  })
  it('collapses a completed message even if answer was empty', () => {
    expect(defaultThinkingExpanded({ hasAnswer: false, isComplete: true })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd codey-mac && npx vitest run src/components/thinkingState.test.ts
```
Expected: FAIL — `Cannot find module './thinkingState'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// codey-mac/src/components/thinkingState.ts

/** Default expanded state for a ThinkingBlock (user toggle overrides this). */
export function defaultThinkingExpanded(args: { hasAnswer: boolean; isComplete: boolean }): boolean {
  // Live thinking is visible; the moment answer text starts (or the turn ends),
  // collapse it so the answer is what the eye lands on.
  return !args.hasAnswer && !args.isComplete
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd codey-mac && npx vitest run src/components/thinkingState.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/thinkingState.ts codey-mac/src/components/thinkingState.test.ts
git commit -m "feat(codey-mac): pure collapse-decision helper for thinking block"
```

---

## Task 9: Render ThinkingBlock, delete the fake fold

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx` (delete `splitParagraphs` ~101-102 and `StepBody` ~147-180; team render ~210-216; regular assistant render ~934-949; styles ~1574-1583)

- [ ] **Step 1: Add the `ThinkingBlock` component**

Add near the old `StepBody` location. It owns its own expand state, seeded from `defaultThinkingExpanded`, and lets the user toggle:

```tsx
import { defaultThinkingExpanded } from './thinkingState'

const ThinkingBlock: React.FC<{
  thinking: string
  hasAnswer: boolean
  isComplete: boolean
}> = ({ thinking, hasAnswer, isComplete }) => {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  if (!thinking.trim()) return null
  const expanded = userToggled ?? defaultThinkingExpanded({ hasAnswer, isComplete })
  return (
    <div>
      <div style={styles.thinkingToggle} onClick={() => setUserToggled(!expanded)}>
        <span style={{ ...styles.teamStepChevron, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        <span>{expanded ? 'Hide thinking' : 'Show thinking'}</span>
      </div>
      {expanded && (
        <div style={styles.thinkingBody}>
          <Markdown variant="assistant">{thinking}</Markdown>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Delete `StepBody` and `splitParagraphs`**

Remove the `splitParagraphs` const (~101-102) and the entire `StepBody` component (~147-180). They have no other consumers (verified: `splitParagraphs` is only used by `StepBody`).

- [ ] **Step 3: Render thinking + full output for team steps**

`TeamMessage` receives the parsed steps but not thinking. Thread `thinkingByStep` from the message into it. Update the `TeamMessage` props and the call site (~941) to pass `thinkingByStep={msg.thinkingByStep}` and `isComplete={msg.isComplete ?? false}`. Then replace the completed-step body (~213-215, the `StepBody` branch) with:

```tsx
              {isLastDuringStream ? (
                <Markdown variant="assistant">{s.output || '…'}</Markdown>
              ) : (
                <div>
                  {thinkingByStep?.[s.step] && (
                    <ThinkingBlock
                      thinking={thinkingByStep[s.step]}
                      hasAnswer={!!s.output.trim()}
                      isComplete={isComplete}
                    />
                  )}
                  <Markdown variant="assistant">{s.output}</Markdown>
                </div>
              )}
```

Add to `TeamMessage`'s prop type:

```tsx
  thinkingByStep?: Record<number, string>
  isComplete: boolean
```

- [ ] **Step 4: Render thinking for regular assistant messages**

At the non-team render (~938), where it currently returns `<Markdown variant="assistant">{text}</Markdown>`, wrap with a ThinkingBlock when present:

```tsx
                  if (!parsed) return (
                    <div>
                      {msg.thinking && (
                        <ThinkingBlock
                          thinking={msg.thinking}
                          hasAnswer={!!text.trim()}
                          isComplete={msg.isComplete ?? false}
                        />
                      )}
                      <Markdown variant="assistant">{text}</Markdown>
                    </div>
                  )
```

- [ ] **Step 5: Keep the thinking styles**

`styles.thinkingToggle` and `styles.thinkingBody` already exist (~1574-1583) and are reused by `ThinkingBlock`. Leave them. If tsc flags `teamStepChevron` as unused elsewhere after the `StepBody` deletion, it is still referenced by `ThinkingBlock` — no change.

- [ ] **Step 6: Typecheck + run mac tests**

Run:
```bash
cd codey-mac && npx tsc --noEmit && npx vitest run
```
Expected: no type errors; all tests pass (including `teamMessageFormat.test.ts` regression and the new `thinkingState.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(codey-mac): render real thinking block, drop fake paragraph fold"
```

---

## Task 10: Full verification

- [ ] **Step 1: Build everything**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
npm run build            # repo-root build (compiles core + gateway + mac as configured)
cd packages/core && npx vitest run && cd ../..
cd codey-mac && npx vitest run && cd ..
```
Expected: builds succeed; all unit tests pass.

- [ ] **Step 2: Manual smoke (single-agent, claude-code)**

Launch the mac app against the gateway, set a chat to a claude-code agent on a model that emits extended thinking, and send a prompt that triggers reasoning. Verify:
- While the agent thinks, a live "Hide thinking" block streams the reasoning.
- When the answer starts, the block auto-collapses to "Show thinking" and the full answer renders below, unfolded.
- Clicking the toggle expands/collapses; the full answer text is never hidden.
- Reopen the chat from history — the collapsed "Show thinking" is still available (persisted).

- [ ] **Step 3: Manual smoke (team)**

Run a `/team` task whose workers produce multi-paragraph output (e.g. a review + brainstorm). Verify:
- Each step shows its FULL output (no paragraph is hidden) — the original bug is gone.
- Steps whose worker emitted thinking show a per-step "Show thinking"; steps without thinking show none.

- [ ] **Step 4: Manual smoke (no-thinking / other agent)**

Send a prompt to an opencode or codex chat (no thinking capture). Verify the message renders full output with no ThinkingBlock ("无则不折").

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for real thinking fold"
```

---

## Self-Review Notes

- **Spec coverage:** capture (T2–T3) · transport (T4) · single-agent wire+persist (T5) · team wire+persist (T6) · reducer accumulate+persist (T7) · live + auto-collapse render (T8–T9) · delete fake fold (T9) · "无则不折" default (T9 Step 4, T10 Step 4) · persistence (T1 ChatMessage, T5/T6 persist, T10 Step 2) · testing (T2, T8, T9 Step 6, T10).
- **Known soft spots to confirm during execution (not placeholders):** the exact local variable name for the run's `AgentResponse` at the gateway persist sites (T5 Step 2, T6 Step 3), and the exact team step variable (`step` vs `stepNum`) at each sink (T6 Step 2). These are explicitly flagged because the gateway file is large; confirm by reading the surrounding lines before editing.
