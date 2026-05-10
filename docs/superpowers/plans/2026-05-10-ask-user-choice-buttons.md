# ASK_USER Choice Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workers/agents present yes/no and pick-one questions as click-to-answer buttons in Mac app, Telegram, and Discord, with text fallback in iMessage and TUI.

**Architecture:** Add a `[ASK_USER:choice]: q | A | B` marker variant parsed in `@codey/core`, thread an `options: string[]` field through the gateway pause/render path, extend `ChannelHandler.sendMessage` to carry choices, and render native buttons in each channel (text + numbered list for non-button channels, with gateway-side digit→option mapping).

**Tech Stack:** TypeScript, vitest (core tests), Telegraf (Telegram), discord.js, Electron + React (Mac app).

**Spec:** `docs/superpowers/specs/2026-05-10-ask-user-choice-buttons-design.md`

---

## File Structure

**Modify:**
- `packages/core/src/utils/ask-user.ts` — extend types + regex for `:choice`
- `packages/core/src/utils/ask-user.test.ts` — new cases
- `packages/core/src/types/pending-team.ts` — add `options?: string[]`
- `packages/core/src/types/chat.ts` — add `Chat.lastAskedOptions`, `ChatMessage.choices`
- `packages/core/src/types/index.ts` — `GatewayResponse.choices`
- `packages/core/src/workers.ts` — prompt updates (3 spots)
- `packages/gateway/src/team-pause.ts` — `renderQuestion` returning `{ text, choices? }`
- `packages/gateway/src/gateway.ts` — thread choices through pause sites, plain-chat parsing, digit mapping
- `packages/gateway/src/channels/base.ts` — extend `sendMessage` signature
- `packages/gateway/src/channels/telegram.ts` — inline keyboard + callback_query
- `packages/gateway/src/channels/discord.ts` — ActionRow + button interaction
- `packages/gateway/src/channels/imessage.ts` — numbered list append
- `packages/gateway/src/channels/tui.ts` — numbered list append
- `codey-mac/electron/main.ts` — pass choices via `chat:done`
- `codey-mac/electron/preload.ts` — expose choices field
- `codey-mac/src/services/api.ts` — `ChatStreamEvent` carries choices
- `codey-mac/src/hooks/useChats.tsx` — store choices on last assistant message
- `codey-mac/src/components/ChatTab.tsx` — render button row

---

## Task 1: Extend parser for `[ASK_USER:choice]`

**Files:**
- Modify: `packages/core/src/utils/ask-user.ts`
- Test: `packages/core/src/utils/ask-user.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `packages/core/src/utils/ask-user.test.ts`:

```ts
describe('parseAskUser (choice variant)', () => {
  it('parses two options', () => {
    const out = parseAskUser('[ASK_USER:choice]: merge into main? | yes | no');
    expect(out).toEqual({
      preamble: '',
      question: 'merge into main?',
      options: ['yes', 'no'],
    });
  });

  it('parses many options and trims whitespace', () => {
    const out = parseAskUser('[ASK_USER:choice]: pick db?  |  postgres  | sqlite |  mysql ');
    expect(out?.options).toEqual(['postgres', 'sqlite', 'mysql']);
  });

  it('caps at 8 options', () => {
    const opts = Array.from({ length: 12 }, (_, i) => `o${i}`).join(' | ');
    const out = parseAskUser(`[ASK_USER:choice]: q? | ${opts}`);
    expect(out?.options).toHaveLength(8);
    expect(out?.options?.[0]).toBe('o0');
    expect(out?.options?.[7]).toBe('o7');
  });

  it('skips empty option segments', () => {
    const out = parseAskUser('[ASK_USER:choice]: q? | a | | b |   ');
    expect(out?.options).toEqual(['a', 'b']);
  });

  it('degrades to plain text when fewer than 2 valid options remain', () => {
    const out = parseAskUser('[ASK_USER:choice]: only one? | yes');
    expect(out).toEqual({ preamble: '', question: 'only one? | yes' });
    expect((out as any).options).toBeUndefined();
  });

  it('degrades when no pipe present', () => {
    const out = parseAskUser('[ASK_USER:choice]: just a question');
    expect(out).toEqual({ preamble: '', question: 'just a question' });
  });

  it('preserves preamble for choice marker', () => {
    const text = 'I looked into it.\n[ASK_USER:choice]: which? | a | b';
    const out = parseAskUser(text);
    expect(out?.preamble).toBe('I looked into it.');
    expect(out?.options).toEqual(['a', 'b']);
  });
});

describe('parseAsk (choice variant)', () => {
  it('returns user kind with options', () => {
    const out = parseAsk('[ASK_USER:choice]: q? | a | b');
    expect(out).toEqual({ kind: 'user', preamble: '', question: 'q?', options: ['a', 'b'] });
  });

  it('does not treat [ASK: name]:choice as a team-choice variant', () => {
    // v1: only [ASK_USER] supports :choice. [ASK: name:choice] is unrecognized.
    const out = parseAsk('[ASK: alice:choice]: q? | a | b');
    // Either parses as a plain team ask (target="alice:choice") or skips —
    // both are acceptable; we assert it does NOT carry an options field.
    if (out?.kind === 'team') {
      expect((out as any).options).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/utils/ask-user.test.ts`
Expected: 8 failing tests (the 7 new choice tests fail; existing tests still pass).

- [ ] **Step 3: Implement the parser changes**

Replace `packages/core/src/utils/ask-user.ts` with:

```ts
export interface AskUser {
  /** Worker output before the marker line (joined with \n, trimmed of trailing whitespace). */
  preamble: string;
  /** The question text after `[ASK_USER]:` (or `[ASK_USER:choice]:` before the first `|`). */
  question: string;
  /** Present only when the marker was `[ASK_USER:choice]:` with >= 2 valid options. */
  options?: string[];
}

export interface AskTeam {
  preamble: string;
  /** The teammate the asking worker has nominated to answer. */
  target: string;
  question: string;
}

export type AskMarker =
  | ({ kind: 'user' } & AskUser)
  | ({ kind: 'team' } & AskTeam);

const USER_MARKER_RE = /^\s*\[ASK_USER(?::choice)?\]\s*:\s*(.*)$/;
const USER_CHOICE_MARKER_RE = /^\s*\[ASK_USER:choice\]\s*:\s*(.*)$/;
const TEAM_MARKER_RE = /^\s*\[ASK\s*:\s*([^\]]+?)\s*\]\s*:\s*(.*)$/;

const MAX_OPTIONS = 8;

function splitChoicePayload(payload: string): { question: string; options?: string[] } {
  const parts = payload.split('|').map(s => s.trim());
  const question = parts.shift() ?? '';
  const options = parts.filter(p => p.length > 0).slice(0, MAX_OPTIONS);
  if (options.length < 2) return { question: payload.trim() };
  return { question, options };
}

/**
 * Detect a `[ASK_USER]: <question>` or `[ASK_USER:choice]: <q> | <a> | <b>` marker.
 * Returns null when no marker is present or the question is blank.
 */
export function parseAskUser(output: string): AskUser | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const choiceMatch = lines[i].match(USER_CHOICE_MARKER_RE);
    if (choiceMatch) {
      const { question, options } = splitChoicePayload(choiceMatch[1]);
      if (!question) return null;
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      return options ? { preamble, question, options } : { preamble, question };
    }
    const userMatch = lines[i].match(USER_MARKER_RE);
    if (!userMatch) continue;
    const question = userMatch[1].trim();
    if (!question) return null;
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { preamble, question };
  }
  return null;
}

/**
 * Detect either a `[ASK_USER]:`/`[ASK_USER:choice]:` or `[ASK: <teammate>]:` marker line.
 * Returns the first marker found (in document order) or null.
 */
export function parseAsk(output: string): AskMarker | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const choiceMatch = line.match(USER_CHOICE_MARKER_RE);
    if (choiceMatch) {
      const { question, options } = splitChoicePayload(choiceMatch[1]);
      if (!question) return null;
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      return options
        ? { kind: 'user', preamble, question, options }
        : { kind: 'user', preamble, question };
    }
    const userMatch = line.match(USER_MARKER_RE);
    if (userMatch) {
      const question = userMatch[1].trim();
      if (!question) return null;
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      return { kind: 'user', preamble, question };
    }
    const teamMatch = line.match(TEAM_MARKER_RE);
    if (teamMatch) {
      const target = teamMatch[1].trim();
      const question = teamMatch[2].trim();
      if (!target || !question) continue;
      const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
      return { kind: 'team', target, preamble, question };
    }
  }
  return null;
}
```

Note: `USER_MARKER_RE` is matched only if `USER_CHOICE_MARKER_RE` did NOT match on the same line, so order matters in the loop body. Choice match is tested first.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/utils/ask-user.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/utils/ask-user.ts packages/core/src/utils/ask-user.test.ts
git commit -m "feat(core): parse [ASK_USER:choice] marker with option list"
```

---

## Task 2: Persist options on PendingTeamState, Chat, ChatMessage, GatewayResponse

**Files:**
- Modify: `packages/core/src/types/pending-team.ts`
- Modify: `packages/core/src/types/chat.ts`
- Modify: `packages/core/src/types/index.ts`

- [ ] **Step 1: Extend `PendingTeamState`**

In `packages/core/src/types/pending-team.ts`, add `options?: string[]` to BOTH variants of the union:

```ts
export type PendingTeamState =
  | {
      teamName: string;
      task: string;
      mode: 'sequential';
      memberIndex: number;
      carry: string;
      askingWorker: string;
      question: string;
      /** Options when worker emitted [ASK_USER:choice]; absent for free-text questions. */
      options?: string[];
      askedAt: number;
    }
  | {
      teamName: string;
      task: string;
      mode: 'auto';
      history: ManagerHistoryEntry[];
      lastWorker: string;
      lastOutput: string;
      partsSoFar: PendingPart[];
      seenWorkers: string[];
      step: number;
      askingWorker: string;
      question: string;
      options?: string[];
      askedAt: number;
    };
```

- [ ] **Step 2: Extend `Chat` and `ChatMessage`**

In `packages/core/src/types/chat.ts`:

Add to `ChatMessage`:
```ts
  /** Option labels when this assistant message ended in [ASK_USER:choice]. */
  choices?: string[];
```

Add to `Chat`:
```ts
  /** Last unanswered choice question in a non-team chat. Cleared on next user message. */
  lastAskedOptions?: { messageId: string; options: string[] };
```

- [ ] **Step 3: Extend `GatewayResponse`**

In `packages/core/src/types/index.ts`, add to `GatewayResponse`:
```ts
  /** When present, the response is asking the user to pick from these options. */
  choices?: string[];
```

- [ ] **Step 4: Type-check**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/pending-team.ts packages/core/src/types/chat.ts packages/core/src/types/index.ts
git commit -m "feat(core): add options/choices fields on PendingTeamState, Chat, ChatMessage, GatewayResponse"
```

---

## Task 3: `renderQuestion` returns `{ text, choices? }`

**Files:**
- Modify: `packages/gateway/src/team-pause.ts`
- Test: `packages/gateway/src/team-pause.test.ts` (create if absent)

- [ ] **Step 1: Add failing tests**

Create or append `packages/gateway/src/team-pause.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderQuestion, renderQuestionMessage } from './team-pause';

describe('renderQuestion', () => {
  it('returns text only for free-text question', () => {
    const r = renderQuestion('coder', 'I looked.', 'which db?');
    expect(r.text).toContain('which db?');
    expect(r.choices).toBeUndefined();
  });

  it('returns text + choices for a choice question', () => {
    const r = renderQuestion('coder', '', 'merge?', ['yes', 'no']);
    expect(r.text).toContain('merge?');
    expect(r.choices).toEqual(['yes', 'no']);
  });

  it('renderQuestionMessage stays string-typed for legacy callers', () => {
    const t = renderQuestionMessage('coder', '', 'q?');
    expect(typeof t).toBe('string');
    expect(t).toContain('q?');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/gateway && npx vitest run src/team-pause.test.ts`
Expected: fails because `renderQuestion` is not exported.

- [ ] **Step 3: Implement**

Replace `packages/gateway/src/team-pause.ts`:

```ts
import { PendingTeamState, parseAsk } from '@codey/core';

export function stripAskMarker(output: string): string {
  const ask = parseAsk(output);
  return ask ? ask.preamble : output;
}

export interface QuestionRender {
  text: string;
  choices?: string[];
}

export function renderQuestion(
  workerName: string,
  preamble: string,
  question: string,
  options?: string[],
  truncate = 500,
): QuestionRender {
  const head = preamble.trim();
  const trimmedHead = head.length > truncate ? head.substring(0, truncate) + '…' : head;
  const intro = `❓ **${workerName}** needs your input:`;
  const body = `${question}`;
  const footer = options && options.length > 0
    ? '_Tap an option below, or type your own answer._'
    : '_Reply with your answer to continue, or send a slash command to cancel._';
  const text = [trimmedHead, intro, body, footer].filter(Boolean).join('\n\n');
  return options && options.length > 0 ? { text, choices: options } : { text };
}

/** Legacy string-returning helper kept for callers that don't yet pass choices through. */
export function renderQuestionMessage(
  workerName: string,
  preamble: string,
  question: string,
  truncate = 500,
): string {
  return renderQuestion(workerName, preamble, question, undefined, truncate).text;
}

export function renderCancelNotice(pending: PendingTeamState): string {
  return `Cancelled paused team \`${pending.teamName}\` (was waiting on: ${pending.question}).`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/gateway && npx vitest run src/team-pause.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/team-pause.ts packages/gateway/src/team-pause.test.ts
git commit -m "feat(gateway): renderQuestion returns text + optional choices"
```

---

## Task 4: Thread `options` through gateway pause call sites

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

Update all five sites that currently call `renderQuestionMessage(...)` to persist `options` on `PendingTeamState` and pass them through. The sites are at approximately lines 2016, 2152, 2253, 2341, 2436, 2489 (six calls total — Task 6 covers the plain-chat case separately; this task handles the existing pause paths).

- [ ] **Step 1: Read the current pause sites**

Run: `grep -n "renderQuestionMessage\|persistPendingTeam" packages/gateway/src/gateway.ts | head -30`

Note: each call to `renderQuestionMessage(workerName, preamble, question)` lives near a `persistPendingTeam(...)` call (or builds a `PendingTeamState` object inline).

- [ ] **Step 2: For each of the five team-pause sites, do the following pattern**

For every call to `renderQuestionMessage(askWorkerName, preamble, ask.question)`:

a. The corresponding `persistPendingTeam` payload (or inline `PendingTeamState`) MUST set `options: ask.options` (when `ask` is from `parseAsk`/`parseAskUser` it now has an `options?: string[]` field). Example, around `gateway.ts:2479`:

```ts
this.persistPendingTeam(chatId, {
  mode: 'sequential',
  teamName,
  task: prompt,
  memberIndex: i,
  carry,
  askingWorker: memberName,
  question: ask.question,
  options: ask.options,           // ← new
  askedAt: Date.now(),
});
```

b. Replace the `renderQuestionMessage(...)` call with `renderQuestion(...)` (import is already adjacent). Capture both pieces:

```ts
const rendered = renderQuestion(askWorkerName, preamble, ask.question, ask.options);
```

c. Each site needs to emit BOTH the visible text AND the choices. Since current call sites either return a `{ response: string }` from a private method (handled by `sendChatResponse` later) or call `sink({ type: 'stream', ... })`, do this:

- Where the function returns `{ response }`: continue returning `rendered.text`. Choices flow separately via the saved `pendingTeam.options` (channels read it from the chat in Task 8/9/12) and via the `GatewayResponse.choices` field on the eventual send. Set `gatewayResponse.choices = rendered.choices` on the response object passed to `sendChatResponse`.
- Where the call uses `sink({ type: 'stream', ..., token: text })`: emit text via stream, then emit a new sink event (added in Task 6 below) `{ type: 'choices', chatId, choices }` when `rendered.choices` is defined.

For Task 4 specifically, focus on persisting `options` on `PendingTeamState` and swapping `renderQuestionMessage` → `renderQuestion`. Channel-side rendering is wired up in later tasks.

- [ ] **Step 3: Update the resume path to clear `options`**

In `resumeTeamFromAnswer`, the existing code already replaces `pendingTeam` with a fresh state for the next pause if it happens. No change needed.

- [ ] **Step 4: Type-check**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): persist option list on PendingTeamState and emit via renderQuestion"
```

---

## Task 5: Gateway digit→option mapping at message intake

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Test: `packages/gateway/src/digit-mapping.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/digit-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveChoiceDigit } from './digit-mapping';

describe('resolveChoiceDigit', () => {
  const opts = ['yes', 'no', 'maybe'];

  it('maps "1" to first option', () => {
    expect(resolveChoiceDigit('1', opts)).toBe('yes');
  });

  it('maps "  2 " to second option (whitespace tolerated)', () => {
    expect(resolveChoiceDigit('  2 ', opts)).toBe('no');
  });

  it('returns null for out-of-range digit', () => {
    expect(resolveChoiceDigit('5', opts)).toBeNull();
    expect(resolveChoiceDigit('0', opts)).toBeNull();
  });

  it('returns null for non-digit text', () => {
    expect(resolveChoiceDigit('yes', opts)).toBeNull();
    expect(resolveChoiceDigit('1!', opts)).toBeNull();
  });

  it('returns null when options is empty or absent', () => {
    expect(resolveChoiceDigit('1', [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/gateway && npx vitest run src/digit-mapping.test.ts`
Expected: fail (module missing).

- [ ] **Step 3: Implement the helper**

Create `packages/gateway/src/digit-mapping.ts`:

```ts
/**
 * If `text` is a bare digit `n` and `options[n-1]` exists, return that option.
 * Otherwise return null (caller should pass the original text through unchanged).
 */
export function resolveChoiceDigit(text: string, options: string[]): string | null {
  if (!options || options.length === 0) return null;
  const m = text.match(/^\s*(\d+)\s*$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= options.length) return null;
  return options[idx];
}
```

- [ ] **Step 4: Wire it into the gateway message handler**

In `packages/gateway/src/gateway.ts`, locate `handleMessage` (around the `pendingChat?.pendingTeam` check near line 509). BEFORE the existing pendingTeam branch, insert digit mapping:

```ts
import { resolveChoiceDigit } from './digit-mapping';
// ...
async handleMessage(message: UserMessage) {
  // ...load chat + pendingChat as before...

  // Digit → option resolution for choice questions (works for both pendingTeam
  // and plain-chat lastAskedOptions). Mutates `message.text` so downstream
  // handling sees the resolved option string.
  const pendingOpts = pendingChat?.pendingTeam?.options ?? pendingChat?.lastAskedOptions?.options;
  if (pendingOpts && pendingOpts.length > 0) {
    const resolved = resolveChoiceDigit(message.text, pendingOpts);
    if (resolved !== null) {
      message = { ...message, text: resolved };
    }
  }

  // Clear lastAskedOptions on ANY user message (button click or otherwise).
  if (pendingChat?.lastAskedOptions) {
    this.getChatManager().clearLastAskedOptions(pendingChat.id); // helper added in Task 6
  }

  // ...rest of handleMessage unchanged...
}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/gateway && npx vitest run src/digit-mapping.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/digit-mapping.ts packages/gateway/src/digit-mapping.test.ts packages/gateway/src/gateway.ts
git commit -m "feat(gateway): map digit replies to choice options on message intake"
```

---

## Task 6: Plain-chat ASK_USER parsing + `lastAskedOptions`

**Files:**
- Modify: `packages/gateway/src/gateway.ts`
- Modify: `packages/core/src/chat-manager.ts` (or wherever `ChatManager` is defined — find with `grep -rn "class ChatManager" packages/core/src`)

- [ ] **Step 1: Locate the plain-chat completion path**

Run: `grep -n "type: 'done'\|sink({ type: 'done'" packages/gateway/src/gateway.ts`

There should be a site (near line 3057) where the final agent response is emitted via `sink({ type: 'done', ... })`. This is the plain-chat path that bypasses team mode.

- [ ] **Step 2: Add `clearLastAskedOptions` helper on the chat manager**

In the file that defines `ChatManager` (search with `grep -rn "class ChatManager\|export class ChatManager" packages`), add:

```ts
clearLastAskedOptions(chatId: string): void {
  const chat = this.get(chatId);
  if (!chat || !chat.lastAskedOptions) return;
  delete chat.lastAskedOptions;
  this.persist(chat);   // use whatever the existing persist method is called
}

setLastAskedOptions(chatId: string, messageId: string, options: string[]): void {
  const chat = this.get(chatId);
  if (!chat) return;
  chat.lastAskedOptions = { messageId, options };
  this.persist(chat);
}
```

(Adapt the persist method name to match existing code.)

- [ ] **Step 3: Parse ASK_USER on plain-chat completion**

In `gateway.ts` near the `sink({ type: 'done', ..., response: output, ... })` site, BEFORE emitting `done`:

```ts
import { parseAskUser } from '@codey/core';
// ...

// Plain-chat ASK_USER detection: if the agent's final output contains the
// marker, surface the choices to the channel and persist on the chat for
// digit-mapping on the next reply. Team flows already handled this earlier.
let choices: string[] | undefined;
const plainAsk = parseAskUser(output);
if (plainAsk?.options && plainAsk.options.length >= 2) {
  choices = plainAsk.options;
  // The assistant message ID is whatever ID the chat manager assigned to
  // the just-recorded message. If unavailable, omit messageId — the gateway
  // clears lastAskedOptions on any next user message regardless.
  const lastMsg = updated.messages[updated.messages.length - 1];
  if (lastMsg) {
    this.getChatManager().setLastAskedOptions(chatId, lastMsg.id, plainAsk.options);
    // Also stamp choices on the persisted message so the Mac app can render
    // buttons when this chat is reloaded mid-question.
    lastMsg.choices = plainAsk.options;
    this.getChatManager().updateMessage(chatId, lastMsg);  // use existing API
  }
}

sink({ type: 'done', chatId, response: output, tokens, durationSec, title: updated.title, choices });
```

If `updateMessage` isn't a method, mutate-then-persist using whatever the chat manager exposes. Worst case: re-save the whole chat via the existing save method.

- [ ] **Step 4: Add the `'choices'` event to `ChatStreamEvent`**

In `codey-mac/src/services/api.ts`, extend the union:

```ts
export type ChatStreamEvent =
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'tool_start'; chatId: string; tool?: string; message: string; input?: Record<string, unknown> }
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string }
  | { type: 'info'; chatId: string; message: string }
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number; title?: string; choices?: string[] }
  | { type: 'error'; chatId: string; message: string };
```

- [ ] **Step 5: Type-check**

Run: `cd packages/gateway && npx tsc --noEmit && cd ../core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/core/src codey-mac/src/services/api.ts
git commit -m "feat(gateway): parse [ASK_USER:choice] in plain chat and persist options on chat"
```

---

## Task 7: Extend `ChannelHandler.sendMessage` for choices (text-only fallback channels)

**Files:**
- Modify: `packages/gateway/src/channels/base.ts`
- Modify: `packages/gateway/src/channels/imessage.ts`
- Modify: `packages/gateway/src/channels/tui.ts`

The `GatewayResponse` now carries `choices?: string[]`. Text-only channels render them as a numbered list appended to the message.

- [ ] **Step 1: Add helper in base**

In `packages/gateway/src/channels/base.ts`, add:

```ts
export function formatChoicesAsText(text: string, choices?: string[]): string {
  if (!choices || choices.length === 0) return text;
  const list = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  return `${text}\n\n${list}\n\n_Reply with the number or the option text._`;
}
```

- [ ] **Step 2: Update imessage handler**

In `packages/gateway/src/channels/imessage.ts`, locate `sendMessage(response: GatewayResponse)` and prefix the actual send with:

```ts
import { formatChoicesAsText } from './base';
// ...
async sendMessage(response: GatewayResponse): Promise<void> {
  const text = formatChoicesAsText(response.text, response.choices);
  // ...existing send logic, but use `text` instead of `response.text`...
}
```

- [ ] **Step 3: Update tui handler**

Same pattern in `packages/gateway/src/channels/tui.ts`.

- [ ] **Step 4: Type-check + manual smoke**

Run: `cd packages/gateway && npx tsc --noEmit`

(No automated test here — channel handlers are I/O-bound. Manual verification happens in Task 14.)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/channels/base.ts packages/gateway/src/channels/imessage.ts packages/gateway/src/channels/tui.ts
git commit -m "feat(channels): render choices as numbered list in imessage/tui"
```

---

## Task 8: Telegram inline keyboard + callback_query

**Files:**
- Modify: `packages/gateway/src/channels/telegram.ts`

- [ ] **Step 1: Add inline keyboard on send**

Locate `sendMessage(response: GatewayResponse)` in `packages/gateway/src/channels/telegram.ts`. The current code calls something like `bot.telegram.sendMessage(chatId, text, { ... })`. Add a conditional `reply_markup`:

```ts
async sendMessage(response: GatewayResponse): Promise<void> {
  // ...existing setup (chatId resolution, markdown options, etc.)...

  const extra: any = { /* existing options */ };
  if (response.choices && response.choices.length > 0) {
    // Wrap rows at 3 buttons. callback_data must be <= 64 bytes; fall back
    // to indexed payload for long labels.
    const buttons = response.choices.map((label, idx) => {
      const callback_data = Buffer.byteLength(label, 'utf8') <= 60 ? label : `opt:${idx}`;
      return { text: label, callback_data };
    });
    const rows: typeof buttons[] = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    extra.reply_markup = { inline_keyboard: rows };
  }

  await this.bot.telegram.sendMessage(chatId, response.text, extra);
}
```

- [ ] **Step 2: Handle `callback_query`**

In `start(config)`, after the existing `bot.on('text', ...)` handler, add:

```ts
this.bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string | undefined;
  const fromId = ctx.from?.id?.toString();
  const chatId = ctx.chat?.id?.toString();
  if (!data || !fromId || !chatId) {
    await ctx.answerCbQuery();
    return;
  }
  // Resolve indexed payload if needed. We don't have chat state here; the
  // gateway's intake will pass the literal text through as the answer.
  // For "opt:N" payloads we cannot map without state — keep them as-is and
  // let the gateway resolve via lastAskedOptions/pendingTeam.options.
  let text = data;
  if (/^opt:\d+$/.test(data)) {
    // Emit the digit form so the gateway's digit-mapping resolves it.
    // "opt:0" → "1", "opt:1" → "2", etc.
    const idx = parseInt(data.slice(4), 10);
    text = String(idx + 1);
  }
  await ctx.answerCbQuery();   // dismiss spinner
  this.emitMessage({
    id: `tg-${Date.now()}`,
    channel: 'telegram',
    userId: fromId,
    username: ctx.from?.username ?? fromId,
    chatId,
    text,
    timestamp: Date.now(),
  });
});
```

- [ ] **Step 3: Type-check**

Run: `cd packages/gateway && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/channels/telegram.ts
git commit -m "feat(channels): telegram inline keyboard buttons for [ASK_USER:choice]"
```

---

## Task 9: Discord buttons + interaction handler

**Files:**
- Modify: `packages/gateway/src/channels/discord.ts`

- [ ] **Step 1: Render buttons on send**

At the top of `packages/gateway/src/channels/discord.ts`, ensure imports include:

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Interaction, Message, TextChannel } from 'discord.js';
```

In `sendMessage(response: GatewayResponse)`, locate the call that sends `response.text` to a Discord channel. Adapt:

```ts
async sendMessage(response: GatewayResponse): Promise<void> {
  // ...resolve channel...
  const components: any[] = [];
  if (response.choices && response.choices.length > 0) {
    // Discord: max 5 buttons per row, 5 rows = 25 total. Our cap is 8.
    const buttons = response.choices.slice(0, 25).map((label, idx) =>
      new ButtonBuilder()
        // customId must be <= 100 chars; option labels are short by convention.
        // Use index-based id to keep it bounded and to allow remapping on click.
        .setCustomId(`ask_user:${idx}`)
        .setLabel(label.length > 80 ? label.slice(0, 77) + '…' : label)
        .setStyle(ButtonStyle.Secondary)
    );
    for (let i = 0; i < buttons.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5));
      components.push(row);
    }
  }
  await channel.send({ content: response.text, components });
}
```

- [ ] **Step 2: Wire interaction handler**

In `start(config)`, after the existing `messageCreate` handler, add:

```ts
this.client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isButton()) return;
  const m = interaction.customId.match(/^ask_user:(\d+)$/);
  if (!m) return;
  const idx = parseInt(m[1], 10);
  // Emit the digit form so the gateway resolves via lastAskedOptions/pendingTeam.options.
  const text = String(idx + 1);
  await interaction.update({ components: [] }).catch(() => { /* already updated */ });
  this.emitMessage({
    id: `dc-${interaction.id}`,
    channel: 'discord',
    userId: interaction.user.id,
    username: interaction.user.username,
    chatId: interaction.channelId,
    text,
    timestamp: Date.now(),
  });
});
```

- [ ] **Step 3: Type-check**

Run: `cd packages/gateway && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/channels/discord.ts
git commit -m "feat(channels): discord buttons for [ASK_USER:choice]"
```

---

## Task 10: Mac app — pipe choices through IPC and render buttons

**Files:**
- Modify: `codey-mac/electron/main.ts`
- Modify: `codey-mac/electron/preload.ts`
- Modify: `codey-mac/src/hooks/useChats.tsx`
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Pass choices through IPC `chat:done`**

In `codey-mac/electron/main.ts`, locate the `sendToRenderer('chat:done', { ... })` call inside the `chat:send` handler (around line 633). Update:

```ts
if (result?.response) {
  sendToRenderer('chat:done', {
    conversationId: convId,
    response: result.response,
    tokens: result.tokens,
    durationSec: result.durationSec,
    choices: (result as any).choices,   // forward when present
  })
}
```

Also confirm `processPromptHttp` in `packages/gateway/src/gateway.ts` returns `choices` in its result object. If it doesn't yet, locate the return statement (search `return { response: output` in gateway.ts) and add `choices: plainAsk?.options ?? undefined` (reusing the `plainAsk` from Task 6, or by re-parsing if `plainAsk` is out of scope).

- [ ] **Step 2: Expose in preload**

In `codey-mac/electron/preload.ts`, find the `chat.onDone` registration (search `chat:done`) and ensure the forwarded payload type includes `choices?: string[]`. Add to the inline type if it's typed explicitly.

- [ ] **Step 3: Persist choices on the assistant message in the chat store**

In `codey-mac/src/hooks/useChats.tsx`, locate where `done` events from `chat.onDone` (or the equivalent stream listener for `done` event type) update the assistant message. Add `choices: msg.choices` to the message update so the message in state carries `choices?: string[]`.

(The `ChatMessage` core type already has `choices?: string[]` from Task 2.)

- [ ] **Step 4: Render buttons in ChatTab**

In `codey-mac/src/components/ChatTab.tsx`, locate the message-rendering JSX (look for where assistant messages are rendered with `<Markdown>` or similar). Add, beneath the message bubble:

```tsx
{msg.role === 'assistant'
  && msg.choices
  && msg.choices.length > 0
  && idx === messages.length - 1
  && messages[messages.length - 1]?.role !== 'user'
  && (
    <div style={styles.choiceRow}>
      {msg.choices.map((label, i) => (
        <button
          key={i}
          style={styles.choiceButton}
          disabled={isSending || !!flight}
          onClick={() => {
            // Send the option text as a normal user message.
            void sendMessage(chat.id, label)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
```

Add styles near the existing styles object:

```ts
choiceRow: {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: 8,
  marginTop: 8,
  marginLeft: 12,
},
choiceButton: {
  padding: '6px 12px',
  borderRadius: 6,
  border: `1px solid ${C.fg3}`,
  background: C.bg2,
  color: C.fg1,
  cursor: 'pointer',
  fontSize: 13,
},
```

(Adapt `C` palette names to whatever the file actually imports — check existing button styles in the same file.)

- [ ] **Step 5: Build the Mac app**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/hooks/useChats.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): render choice buttons under assistant messages with [ASK_USER:choice]"
```

---

## Task 11: Worker prompt updates

**Files:**
- Modify: `packages/core/src/workers.ts`

- [ ] **Step 1: Read the three prompt sites**

Run: `grep -n "ASK_USER" packages/core/src/workers.ts`

Three prompts mention `[ASK_USER]`: solo worker (~line 203), sequential member (~line 242), auto-routed worker (~line 284).

- [ ] **Step 2: Append the choice-marker instruction at each site**

In each prompt, locate the existing line about `[ASK_USER]: <your question>` and immediately after it, add:

```ts
'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
```

Match the surrounding array/string-concat style of each prompt. Keep wording identical across the three so the LLM behavior is consistent.

- [ ] **Step 3: Update existing manager-prompt tests if they snapshot prompt text**

Run: `cd packages/core && npx vitest run`
Expected: pass. If any snapshot tests fail, update them to include the new line.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workers.ts packages/core/src/manager-prompt.test.ts
git commit -m "feat(workers): teach workers to emit [ASK_USER:choice] for yes/no questions"
```

---

## Task 12: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

Run: `npm run build` from the repo root (or build per package if no root script).
Expected: clean build.

- [ ] **Step 2: Spawn a test team with a worker that emits a choice marker**

Create a temporary worker `workspaces/<test-workspace>/workers/choice-asker.md`:

```markdown
You are a tester. On your first turn, output exactly:

[ASK_USER:choice]: Should I proceed with plan A? | yes | no | tell me more

Then stop.
```

Register the worker via the Mac app Workers tab and add it to a single-member team `choice-test`.

- [ ] **Step 3: Mac app — verify buttons**

In the Mac app, run `/team choice-test do anything`. Expected:
- The worker output renders as a message
- Three buttons "yes" / "no" / "tell me more" appear below it
- Clicking "yes" sends "yes" as a user message, resumes the team, buttons disappear

- [ ] **Step 4: Telegram — verify inline keyboard**

Pair the chat to a Telegram channel. Repeat. Expected: inline keyboard with three buttons appears. Tapping sends the selection.

- [ ] **Step 5: Discord — verify buttons**

Pair to Discord. Repeat. Expected: three button row appears under the message.

- [ ] **Step 6: iMessage / TUI — verify numbered list + digit reply**

Pair to iMessage (or use the TUI channel). Repeat. Expected:
- Message ends with `1) yes\n2) no\n3) tell me more`
- Replying `2` resolves to "no" and resumes the team

- [ ] **Step 7: Verify plain-chat (non-team) coverage**

In a non-team chat (selection: none), prompt the agent: "Ask me with [ASK_USER:choice]: do you want coffee? | yes | no". Expected: agent emits the marker, buttons appear in Mac app, tapping sends the answer as the next user message.

- [ ] **Step 8: Verify graceful degradation**

Trigger a worker to output `[ASK_USER:choice]: only one? | yes` (one option). Expected: rendered as a plain free-text ASK_USER (no buttons), team pauses, user can reply with anything.

- [ ] **Step 9: Cleanup**

Delete the test worker and team.

```bash
# No commit — manual verification only.
```

---

## Self-Review

Spec coverage:
- Protocol with `:choice` suffix, `|` separator, 2–8 options, graceful degradation → Task 1 ✓
- Worker prompt update (3 sites) → Task 11 ✓
- Render helper returning `{ text, choices? }` → Task 3 ✓
- `PendingTeamState.options`, `Chat.lastAskedOptions`, `ChatMessage.choices`, `GatewayResponse.choices` → Task 2 ✓
- Gateway threading through pause sites → Task 4 ✓
- Plain-chat ASK_USER parsing → Task 6 ✓
- Digit→option mapping → Task 5 ✓
- Text-fallback channels (imessage, tui) → Task 7 ✓
- Telegram buttons + callback → Task 8 ✓
- Discord buttons + interaction → Task 9 ✓
- Mac app rendering → Task 10 ✓
- Tests for parser, render, digit mapping → Tasks 1, 3, 5 ✓
- E2E manual verification → Task 12 ✓

Risks called out in spec:
- 64-byte Telegram `callback_data` limit → handled in Task 8 with `opt:N` indexed fallback
- 100-char Discord customId + 80-char label → handled in Task 9
- Race between button click and free-text reply → existing single-flight handles it (no extra code)

Type consistency: `options: string[]` used uniformly across `AskUser`, `PendingTeamState`, `ChatMessage.choices` (renamed to `choices` at presentation boundary), `GatewayResponse.choices`, `Chat.lastAskedOptions.options`. The "options vs choices" naming split is intentional: `options` = the parsed marker payload internal to gateway/core; `choices` = the user-facing presentation field on the response/message.
