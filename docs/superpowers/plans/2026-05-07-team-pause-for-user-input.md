# Team Pause-for-User-Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause a running team when a worker emits `[ASK_USER]: <question>`, persist pending state on the chat, and resume from the user's next reply (sequential re-runs the asker; auto feeds clarification to the Manager).

**Architecture:** Add a small marker parser in `@codey/core`. Extend `Chat` with optional `pendingTeam` state. Both the sequential team runner (`runAllMembersInOrder`, chat-stream loop) and the auto Manager loop (`runManagerLoop`) check each worker's output for the marker after every step, persist pending state and surface the question if found. A new pre-dispatch hook in the gateway message handler treats the next non-command message as the answer and resumes.

**Tech Stack:** TypeScript (ES2020 / CommonJS / strict). Vitest for tests (matches existing `*.test.ts` files). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-07-team-pause-for-user-input-design.md`

---

## File Structure

**Create:**
- `packages/core/src/utils/ask-user.ts` — `parseAskUser` helper.
- `packages/core/src/utils/ask-user.test.ts` — unit tests.
- `packages/core/src/types/pending-team.ts` — `PendingTeamState` type.
- `packages/gateway/src/team-pause.ts` — shared pause-state helpers (build + render question message).

**Modify:**
- `packages/core/src/types/index.ts` — re-export `PendingTeamState`.
- `packages/core/src/types/chat.ts` — add `pendingTeam?: PendingTeamState` to `Chat`.
- `packages/core/src/index.ts` — export new modules.
- `packages/core/src/manager.ts` — add `userClarification` to `ManagerInput`; render in `buildManagerPrompt`.
- `packages/core/src/manager.test.ts` — tests for new field.
- `packages/core/src/workers.ts` — append ASK_USER instruction line to `buildWorkerPrompt`.
- `packages/gateway/src/gateway.ts` — pre-dispatch hook in `handleMessage`; refactor sequential and auto team runners to detect marker + support resume.
- `packages/gateway/src/chats.ts` — no behavior change; verify the new optional `pendingTeam` round-trips JSON (covered by chats.test.ts test).
- `packages/gateway/src/chats.test.ts` — round-trip test for `pendingTeam`.

---

## Task 1: parseAskUser helper

**Files:**
- Create: `packages/core/src/utils/ask-user.ts`
- Test: `packages/core/src/utils/ask-user.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/utils/ask-user.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAskUser } from './ask-user';

describe('parseAskUser', () => {
  it('returns null when no marker is present', () => {
    expect(parseAskUser('hello world\nno marker here')).toBeNull();
  });

  it('parses a standalone marker line', () => {
    const out = parseAskUser('[ASK_USER]: should I use postgres or sqlite?');
    expect(out).toEqual({
      preamble: '',
      question: 'should I use postgres or sqlite?',
    });
  });

  it('parses a marker after preamble content', () => {
    const text = [
      'I started looking at the schema.',
      'Two options exist.',
      '[ASK_USER]: which database should I target?',
      'I will wait.',
    ].join('\n');
    const out = parseAskUser(text);
    expect(out).toEqual({
      preamble: 'I started looking at the schema.\nTwo options exist.',
      question: 'which database should I target?',
    });
  });

  it('uses the first marker when multiple exist', () => {
    const text = '[ASK_USER]: first?\n[ASK_USER]: second?';
    const out = parseAskUser(text);
    expect(out?.question).toBe('first?');
  });

  it('tolerates leading whitespace before the marker', () => {
    const out = parseAskUser('   [ASK_USER]:   trim me  ');
    expect(out).toEqual({ preamble: '', question: 'trim me' });
  });

  it('returns null when the question is empty after trim', () => {
    expect(parseAskUser('[ASK_USER]:    ')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/core && npx vitest run src/utils/ask-user.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement parseAskUser**

Create `packages/core/src/utils/ask-user.ts`:

```ts
export interface AskUser {
  /** Worker output before the marker line (joined with \n, trimmed of trailing whitespace). */
  preamble: string;
  /** The question text after `[ASK_USER]:`, trimmed. */
  question: string;
}

const MARKER_RE = /^\s*\[ASK_USER\]\s*:\s*(.*)$/;

/**
 * Detect a `[ASK_USER]: <question>` marker line in worker output.
 * Returns null when no marker is present or the question is blank.
 */
export function parseAskUser(output: string): AskUser | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_RE);
    if (!m) continue;
    const question = m[1].trim();
    if (!question) return null;
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { preamble, question };
  }
  return null;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/core && npx vitest run src/utils/ask-user.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Export from core barrel**

Edit `packages/core/src/index.ts` — add this line in the export list:

```ts
export * from './utils/ask-user';
```

- [ ] **Step 6: Build core to confirm exports compile**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/utils/ask-user.ts packages/core/src/utils/ask-user.test.ts packages/core/src/index.ts
git commit -m "feat(core): parseAskUser helper for [ASK_USER] marker"
```

---

## Task 2: PendingTeamState type on Chat

**Files:**
- Create: `packages/core/src/types/pending-team.ts`
- Modify: `packages/core/src/types/chat.ts`
- Modify: `packages/core/src/types/index.ts`

- [ ] **Step 1: Create the type module**

Create `packages/core/src/types/pending-team.ts`:

```ts
import { ManagerHistoryEntry } from '../manager';

/** Recorded part of a Manager-driven run, kept while the team is paused. */
export interface PendingPart {
  step: number;
  worker: string;
  output: string;
  isRevision: boolean;
}

/** State persisted on a Chat while a team run is paused waiting for user input. */
export type PendingTeamState =
  | {
      teamName: string;
      task: string;
      mode: 'sequential';
      memberIndex: number;
      carry: string;
      askingWorker: string;
      question: string;
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
      askedAt: number;
    };
```

- [ ] **Step 2: Add to Chat type**

Edit `packages/core/src/types/chat.ts` — add the import and field. The current file ends at line 55 with the closing `}` of `Chat`. Replace the `Chat` interface block:

```ts
import { ChatRoute } from './route';
import { PendingTeamState } from './pending-team';

// ...existing FileAttachment, ToolCallEntry, ChatMessage, ChatSelection unchanged...

export interface Chat {
  id: string;
  title: string;
  workspaceName: string;
  selection: ChatSelection;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  agent?: 'claude-code' | 'opencode' | 'codex';
  model?: string;
  routes?: ChatRoute[];
  /** Set while a /team run is paused waiting for the user to answer a worker's question. */
  pendingTeam?: PendingTeamState;
}
```

(Keep the existing JSDoc comments on `agent`, `model`, and `routes` exactly as they are — only the import line and the new `pendingTeam` field are added.)

- [ ] **Step 3: Re-export from types barrel**

Edit `packages/core/src/types/index.ts` — add (alongside the other `export *` lines):

```ts
export * from './pending-team';
```

- [ ] **Step 4: Compile to confirm**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/pending-team.ts packages/core/src/types/chat.ts packages/core/src/types/index.ts
git commit -m "feat(core): PendingTeamState type on Chat"
```

---

## Task 3: chats.ts round-trip test for pendingTeam

**Files:**
- Modify: `packages/gateway/src/chats.test.ts`

- [ ] **Step 1: Add a round-trip test**

Open `packages/gateway/src/chats.test.ts` and add this test inside the existing top-level `describe` (or append a new `describe` if the file doesn't have one). Use the same test framework and store-construction pattern already present in the file — adapt the example below to match. If the file uses a `tmpdir` helper, reuse it; otherwise inline `fs.mkdtempSync`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { ChatStore } from './chats'; // adapt to existing import
import { PendingTeamState } from '@codey/core';

describe('ChatStore pendingTeam round-trip', () => {
  it('persists and reloads pendingTeam unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-test-'));
    const store = new ChatStore(dir); // adapt constructor to existing signature
    const chat = store.create({ workspaceName: 'ws', title: 't' }); // adapt
    const pending: PendingTeamState = {
      mode: 'sequential',
      teamName: 'review',
      task: 'audit pr',
      memberIndex: 1,
      carry: 'previous output',
      askingWorker: 'reviewer',
      question: 'should I include style nits?',
      askedAt: 1_700_000_000_000,
    };
    store.update(chat.id, { pendingTeam: pending });

    const reloaded = new ChatStore(dir);
    const got = reloaded.get(chat.id);
    expect(got?.pendingTeam).toEqual(pending);
  });
});
```

If the existing `ChatStore` API uses different method names (`save`, `load`, `setChat`, etc.), use those — the goal is one round-trip assertion. Look at the first 100 lines of `chats.ts` to confirm the API and adapt.

- [ ] **Step 2: Run tests to confirm pass**

Run: `cd packages/gateway && npx vitest run src/chats.test.ts`
Expected: PASS — including the new round-trip test (no implementation change needed; JSON serialization already handles the new optional field).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chats.test.ts
git commit -m "test(gateway): pendingTeam round-trips through chats store"
```

---

## Task 4: ManagerInput.userClarification

**Files:**
- Modify: `packages/core/src/manager.ts`
- Modify: `packages/core/src/manager.test.ts`

- [ ] **Step 1: Write failing test**

Open `packages/core/src/manager.test.ts` and add:

```ts
import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from './manager';

describe('buildManagerPrompt userClarification', () => {
  it('omits the section when not provided', () => {
    const out = buildManagerPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }],
      history: [],
      lastWorker: null,
      lastOutput: null,
    });
    expect(out).not.toContain('## User Clarification');
  });

  it('renders the section when provided', () => {
    const out = buildManagerPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }],
      history: [],
      lastWorker: 'a',
      lastOutput: '[ASK_USER]: which db?',
      userClarification: { worker: 'a', question: 'which db?', answer: 'postgres' },
    });
    expect(out).toContain('## User Clarification');
    expect(out).toContain('Worker a asked: which db?');
    expect(out).toContain('User answered: postgres');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd packages/core && npx vitest run src/manager.test.ts`
Expected: FAIL — `userClarification` not on `ManagerInput` type, second assertion fails.

- [ ] **Step 3: Implement**

Edit `packages/core/src/manager.ts`. In the `ManagerInput` interface (lines 14–22), add the optional field:

```ts
export interface ManagerInput {
  task: string;
  members: ManagerMember[];
  history: ManagerHistoryEntry[];
  lastWorker: string | null;
  lastOutput: string | null;
  /** When true, return only done:true with a final_summary; do not pick next. */
  finalize?: boolean;
  /** Set on the turn immediately after a paused run resumes. */
  userClarification?: { worker: string; question: string; answer: string };
}
```

In `buildManagerPrompt` (after the `## Last Output` block, before the `if (input.finalize)` block at line 77), add:

```ts
  if (input.userClarification) {
    const u = input.userClarification;
    lines.push('## User Clarification');
    lines.push(`Worker ${u.worker} asked: ${u.question}`);
    lines.push(`User answered: ${u.answer}`);
  }
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd packages/core && npx vitest run src/manager.test.ts`
Expected: PASS — all manager tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manager.ts packages/core/src/manager.test.ts
git commit -m "feat(core): ManagerInput.userClarification rendered in prompt"
```

---

## Task 5: Worker prompt instruction for ASK_USER

**Files:**
- Modify: `packages/core/src/workers.ts`

- [ ] **Step 1: Update buildWorkerPrompt**

Edit `packages/core/src/workers.ts`, replace the `buildWorkerPrompt` body (lines 191–205):

```ts
  buildWorkerPrompt(name: string, task: string): string {
    const worker = this.getWorker(name);
    if (!worker) return task;
    return [
      `# Worker: ${worker.name}`,
      `## Role`,
      worker.personality.role,
      `## Personality`,
      worker.personality.soul,
      `## Instructions`,
      worker.personality.instructions,
      `## Pause for user input`,
      'If you cannot proceed without information from the user, output a single line `[ASK_USER]: <your question>` and stop. Do not guess. Do not continue the work.',
      `## Task`,
      task,
    ].join('\n\n');
  }
```

- [ ] **Step 2: Compile**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/workers.ts
git commit -m "feat(core): instruct workers to emit [ASK_USER] when blocked"
```

---

## Task 6: team-pause shared helpers

**Files:**
- Create: `packages/gateway/src/team-pause.ts`

- [ ] **Step 1: Implement helpers**

Create `packages/gateway/src/team-pause.ts`:

```ts
import { PendingTeamState } from '@codey/core';

/** User-visible message rendered when a team pauses on a worker question. */
export function renderQuestionMessage(
  workerName: string,
  preamble: string,
  question: string,
  truncate = 500,
): string {
  const head = preamble.trim();
  const trimmedHead = head.length > truncate ? head.substring(0, truncate) + '…' : head;
  const intro = `❓ **${workerName}** needs your input:`;
  const body = `${question}`;
  const footer = '_Reply with your answer to continue, or send a slash command to cancel._';
  return [trimmedHead, intro, body, footer].filter(Boolean).join('\n\n');
}

/** Notice shown when a slash command arrives while a team is paused. */
export function renderCancelNotice(pending: PendingTeamState): string {
  return `Cancelled paused team \`${pending.teamName}\` (was waiting on: ${pending.question}).`;
}
```

- [ ] **Step 2: Compile**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/team-pause.ts
git commit -m "feat(gateway): renderQuestionMessage / renderCancelNotice helpers"
```

---

## Task 7: Detect marker and pause in sequential team runner

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

This task wires the marker detection into `runAllMembersInOrder` (gateway.ts:1890) and persists pending state. The chat-stream sibling path (`runTeamForChat` sequential branch, gateway.ts:2015) is handled in Task 9.

- [ ] **Step 1: Add imports at top of gateway.ts**

Find the existing `import { ... } from '@codey/core';` line near the top of `gateway.ts` and add `parseAskUser`, `PendingTeamState` to the import list. Also add a new line:

```ts
import { renderQuestionMessage } from './team-pause';
```

- [ ] **Step 2: Add a chat-store accessor helper**

Inside the `Gateway` class (place near other private helpers around `runOneWorker`), add:

```ts
  /** Persist pendingTeam for a chat. Returns silently if the chat does not exist. */
  private async setPendingTeam(chatId: string, pending: PendingTeamState | null): Promise<void> {
    const chat = this.chatStore.get(chatId); // adapt to existing chat store API used elsewhere in this file
    if (!chat) return;
    if (pending) chat.pendingTeam = pending;
    else delete chat.pendingTeam;
    this.chatStore.update(chat.id, { pendingTeam: chat.pendingTeam ?? undefined });
  }
```

If gateway.ts already accesses chats via a different helper (search for existing `chatStore` or `chats.` usage), reuse that pattern. Do NOT introduce a second chat-access path.

- [ ] **Step 3: Refactor `runAllMembersInOrder` to detect the marker and pause**

Replace the loop body in `runAllMembersInOrder` (gateway.ts:1907–1930). The new version checks each worker's output for `[ASK_USER]:`, persists pending state, sends the question, and returns early. It also accepts an optional `startIndex` and `startCarry` so resume can jump back in:

```ts
  private async runAllMembersInOrder(
    message: UserMessage,
    teamName: string,
    members: string[],
    task: string,
    runOneWorker: (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
    ) => Promise<{ success: boolean; output: string; error?: string }>,
    opts: { startIndex?: number; startCarry?: string; priorResults?: string[] } = {},
  ): Promise<void> {
    const { chatId, channel } = message;
    const workerManager = this.workspaceManager.getWorkerManager();
    const results: string[] = opts.priorResults ? [...opts.priorResults] : [];
    let currentTask = opts.startCarry ?? task;

    for (let i = opts.startIndex ?? 0; i < members.length; i++) {
      const memberName = members[i];
      const worker = workerManager.getWorker(memberName);
      if (!worker) {
        results.push(`**${memberName}**: ❌ not found in global library`);
        break;
      }
      const codingAgent = workerManager.getWorkerCodingAgent(memberName) as CodingAgent;
      const model = workerManager.getWorkerModel(memberName);
      await this.sendResponse({
        chatId,
        channel,
        text: `🔄 Worker **${worker.name}** is working...`,
      });
      const prompt = workerManager.buildWorkerPrompt(memberName, currentTask);
      const modelConfig = this.getModelConfig(codingAgent, model);
      const response = await runOneWorker(memberName, prompt, codingAgent, modelConfig);
      if (!response.success) {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        break;
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        await this.setPendingTeam(chatId, {
          mode: 'sequential',
          teamName,
          task,
          memberIndex: i,
          carry: currentTask,
          askingWorker: memberName,
          question: ask.question,
          askedAt: Date.now(),
        });
        await this.sendResponse({
          chatId,
          channel,
          text: renderQuestionMessage(worker.name, ask.preamble, ask.question),
        });
        return;
      }
      results.push(`**${worker.name}**: ${response.output.substring(0, 500)}`);
      currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
    }

    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`,
    });
  }
```

- [ ] **Step 4: Compile**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): pause sequential team on [ASK_USER] marker"
```

---

## Task 8: Detect marker and pause in auto Manager loop

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Extend runManagerLoop return type**

Edit the return type of `runManagerLoop` (gateway.ts:1650-1657) to add a `paused` variant:

```ts
  ): Promise<
    | { fallback: true; fallbackReason: string }
    | {
        fallback: false;
        paused?: undefined;
        parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
        finalSummary: string;
        fallbackMidRun?: { reason: string };
      }
    | {
        fallback: false;
        paused: {
          history: ManagerHistoryEntry[];
          lastWorker: string;
          lastOutput: string;
          parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
          seenWorkers: string[];
          step: number;
          askingWorker: string;
          question: string;
        };
      }
  > {
```

- [ ] **Step 2: Pause inside the loop on marker**

Inside `runManagerLoop`, after `if (!response.success) { ... }` and before `parts.push({...})` (around gateway.ts:1715), add:

```ts
      const ask = parseAskUser(response.output);
      if (ask) {
        return {
          fallback: false,
          paused: {
            history,
            lastWorker: turn.next,
            lastOutput: response.output,
            parts,
            seenWorkers: Array.from(seenWorkers),
            step: step + 1,
            askingWorker: turn.next,
            question: ask.question,
          },
        };
      }
```

- [ ] **Step 3: Handle paused result in `runTeamTask`**

In `runTeamTask` where `runManagerLoop` is called (gateway.ts:1837), after the existing `result.fallback` and before formatting parts, add:

```ts
      if ('paused' in result && result.paused) {
        const p = result.paused;
        await this.setPendingTeam(message.chatId, {
          mode: 'auto',
          teamName,
          task,
          history: p.history,
          lastWorker: p.lastWorker,
          lastOutput: p.lastOutput,
          partsSoFar: p.parts,
          seenWorkers: p.seenWorkers,
          step: p.step,
          askingWorker: p.askingWorker,
          question: p.question,
          askedAt: Date.now(),
        });
        const askWorkerName =
          this.workspaceManager.getWorkerManager().getWorker(p.askingWorker)?.name ?? p.askingWorker;
        // The asking worker's output already passed through perStep; surface only the question.
        await this.sendResponse({
          chatId: message.chatId,
          channel: message.channel,
          text: renderQuestionMessage(askWorkerName, '', p.question),
        });
        return;
      }
```

- [ ] **Step 4: Compile**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors. (If TS complains about narrowing on the union, add a `paused: false` discriminator on the non-paused success branch — adjust the type accordingly.)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): pause auto team on [ASK_USER] marker"
```

---

## Task 9: Apply same pause logic to chat-stream paths

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

`runTeamForChat` (gateway.ts:1939) duplicates both the auto and sequential loops for the streaming chat path. Apply the same marker detection.

- [ ] **Step 1: Pause auto branch in runTeamForChat**

In `runTeamForChat`, the auto branch (gateway.ts:1976-2009) calls `runManagerLoop`. After the call, before the `formatManagerParts` returns, handle the paused variant:

```ts
      if ('paused' in result && (result as any).paused) {
        const p = (result as any).paused;
        await this.setPendingTeam(chatId, {
          mode: 'auto',
          teamName,
          task: prompt,
          history: p.history,
          lastWorker: p.lastWorker,
          lastOutput: p.lastOutput,
          partsSoFar: p.parts,
          seenWorkers: p.seenWorkers,
          step: p.step,
          askingWorker: p.askingWorker,
          question: p.question,
          askedAt: Date.now(),
        });
        const wm = this.workspaceManager.getWorkerManager();
        const askWorkerName = wm.getWorker(p.askingWorker)?.name ?? p.askingWorker;
        const text = renderQuestionMessage(askWorkerName, '', p.question);
        sink({ type: 'stream', chatId, token: text });
        return { response: text };
      }
```

- [ ] **Step 2: Pause sequential branch in runTeamForChat**

Replace the sequential loop (gateway.ts:2013-2027) so it parses each response for the marker and persists pending state:

```ts
    // dispatch === 'all', forceAll, or auto-routing fallback
    let carry = prompt;
    const parts: string[] = [];
    for (let i = 0; i < team.members.length; i++) {
      if (signal?.aborted) break;
      const memberName = team.members[i];
      sink({ type: 'info', chatId, message: `Step ${i + 1}/${team.members.length}: ${memberName}` });
      const stepPrompt = workerManager.buildWorkerPrompt(memberName, carry);
      const codingAgent = (workerManager.getWorkerCodingAgent(memberName) ?? chatAgent ?? this.getDefaultAgent()) as CodingAgent;
      const workerModel = workerManager.getWorkerModel(memberName);
      const modelConfig = workerModel ? this.getModelConfig(codingAgent, workerModel) : chatModel ?? this.getDefaultModelConfig(codingAgent);
      const response = await runOneWorker(memberName, stepPrompt, codingAgent, modelConfig);
      if (!response.success) {
        parts.push(`### ${memberName}\n\n`);
        break;
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        await this.setPendingTeam(chatId, {
          mode: 'sequential',
          teamName,
          task: prompt,
          memberIndex: i,
          carry,
          askingWorker: memberName,
          question: ask.question,
          askedAt: Date.now(),
        });
        const askWorkerName = workerManager.getWorker(memberName)?.name ?? memberName;
        const text = renderQuestionMessage(askWorkerName, ask.preamble, ask.question);
        sink({ type: 'stream', chatId, token: text });
        return { response: parts.length ? parts.join('\n\n---\n\n') + '\n\n' + text : text };
      }
      parts.push(`### ${memberName}\n\n${response.output}`);
      carry = response.output;
    }
```

(Match indentation/format of surrounding code; only the loop body changed.)

- [ ] **Step 3: Compile**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): pause team on marker in chat-stream paths"
```

---

## Task 10: Resume entry points

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

Add `resumeTeamFromAnswer` that branches on `pending.mode`. Sequential resumes by re-running the asker with answer appended; auto resumes by injecting `userClarification` into the next Manager turn.

- [ ] **Step 1: Add resume method**

Add a private method to `Gateway` (place near `runTeamTask`):

```ts
  /** Resume a paused team. Caller must have already cleared chat.pendingTeam. */
  private async resumeTeamFromAnswer(
    message: UserMessage,
    pending: PendingTeamState,
    answer: string,
  ): Promise<void> {
    const team = this.workspaceManager.getTeam(pending.teamName);
    if (!team) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `Team \`${pending.teamName}\` no longer exists; the paused run was dropped.`,
      });
      return;
    }
    const handler = this.handlers.get(message.channel);
    const runOneWorker = async (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
    ): Promise<{ success: boolean; output: string; error?: string }> => {
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
      const response = await this.runWithFallback(codingAgent, {
        prompt,
        agent: codingAgent,
        model: modelConfig,
        interactive: this.tuiMode,
        onStream,
        context: { workingDir: this.workingDir },
      });
      return response.success
        ? { success: true, output: response.output }
        : { success: false, output: '', error: response.error };
    };

    if (pending.mode === 'sequential') {
      // Re-run the asking worker with the answer appended; if it asks again, repause.
      const wm = this.workspaceManager.getWorkerManager();
      const memberName = team.members[pending.memberIndex];
      const codingAgent = wm.getWorkerCodingAgent(memberName) as CodingAgent;
      const modelConfig = this.getModelConfig(codingAgent, wm.getWorkerModel(memberName));
      const reprompt = wm.buildWorkerPrompt(
        memberName,
        `${pending.carry}\n\n[User answer to your question "${pending.question}"]:\n${answer}`,
      );
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `🔄 Resuming **${memberName}** with your answer…`,
      });
      const response = await runOneWorker(memberName, reprompt, codingAgent, modelConfig);
      if (!response.success) {
        await this.sendResponse({
          chatId: message.chatId,
          channel: message.channel,
          text: `❌ Worker **${memberName}** failed on resume: ${response.error}`,
        });
        return;
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        await this.setPendingTeam(message.chatId, {
          mode: 'sequential',
          teamName: pending.teamName,
          task: pending.task,
          memberIndex: pending.memberIndex,
          carry: pending.carry, // keep original carry; the new answer feeds the next re-run only
          askingWorker: memberName,
          question: ask.question,
          askedAt: Date.now(),
        });
        await this.sendResponse({
          chatId: message.chatId,
          channel: message.channel,
          text: renderQuestionMessage(memberName, ask.preamble, ask.question),
        });
        return;
      }
      // Continue with the remaining members after this one.
      const carryForNext = `Previous worker output:\n${response.output}\n\nYour task: ${pending.task}`;
      const priorResults: string[] = [`**${memberName}**: ${response.output.substring(0, 500)}`];
      await this.runAllMembersInOrder(
        message,
        pending.teamName,
        team.members,
        pending.task,
        runOneWorker,
        { startIndex: pending.memberIndex + 1, startCarry: carryForNext, priorResults },
      );
      return;
    }

    // mode === 'auto'
    const { agent: mAgent, model: mModel } = this.getDispatcherAgentAndModel();
    const wm = this.workspaceManager.getWorkerManager();
    const turn = await runManager(
      {
        task: pending.task,
        members: team.members.map(n => ({ name: n, hint: wm.getDispatchHint(n) })),
        history: pending.history,
        lastWorker: pending.lastWorker,
        lastOutput: pending.lastOutput,
        userClarification: {
          worker: pending.askingWorker,
          question: pending.question,
          answer,
        },
      },
      { agent: mAgent, model: mModel, runner: this.dispatcherRunner },
    );
    if (turn.fallback) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `⚠️ Manager failed on resume (${turn.fallbackReason}). Paused run dropped.`,
      });
      return;
    }
    // Append the clarification to history for any subsequent turns inside the loop.
    const seededHistory: ManagerHistoryEntry[] = [
      ...pending.history,
      { worker: pending.askingWorker, summary: `User clarified: ${pending.question} → ${answer}` },
    ];
    if (turn.done || !turn.next) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: this.formatManagerParts(pending.partsSoFar, turn.final_summary ?? '', 500),
      });
      return;
    }
    // Continue the Manager loop with the seeded state. We re-enter the existing
    // loop by constructing a synthetic team object and running runManagerLoop
    // from a fresh turn — but the loop has no resume input, so apply the
    // routed turn here, then call runManagerLoop with updated lastWorker/lastOutput.
    // Simplest: route the chosen worker now, then hand off to runManagerLoop
    // continuation by re-implementing one iteration inline.
    const isRevision = pending.seenWorkers.includes(turn.next);
    await this.sendResponse({
      chatId: message.chatId,
      channel: message.channel,
      text: `🔄 Step ${pending.step}: **${turn.next}**${isRevision ? ' (revision)' : ''} — ${turn.reason}`,
    });
    const codingAgent = (wm.getWorkerCodingAgent(turn.next) ?? this.getDefaultAgent()) as CodingAgent;
    const workerModelName = wm.getWorkerModel(turn.next);
    const modelConfig = workerModelName
      ? this.getModelConfig(codingAgent, workerModelName)
      : this.getDefaultModelConfig(codingAgent);
    const stepTaskBody = this.composeStepTask(pending.task, turn.instruction, pending.lastWorker, pending.lastOutput);
    const stepPrompt = wm.buildWorkerPrompt(turn.next, stepTaskBody);
    const response = await runOneWorker(turn.next, stepPrompt, codingAgent, modelConfig);
    if (!response.success) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `❌ Worker **${turn.next}** failed on resume: ${response.error}`,
      });
      return;
    }
    const ask = parseAskUser(response.output);
    const newParts = [...pending.partsSoFar, { step: pending.step, worker: turn.next, output: response.output, isRevision }];
    const newSeen = Array.from(new Set([...pending.seenWorkers, turn.next]));
    const newHistory = turn.summary_of_last
      ? [...seededHistory, { worker: pending.askingWorker, summary: turn.summary_of_last }]
      : seededHistory;
    if (ask) {
      await this.setPendingTeam(message.chatId, {
        mode: 'auto',
        teamName: pending.teamName,
        task: pending.task,
        history: newHistory,
        lastWorker: turn.next,
        lastOutput: response.output,
        partsSoFar: newParts,
        seenWorkers: newSeen,
        step: pending.step + 1,
        askingWorker: turn.next,
        question: ask.question,
        askedAt: Date.now(),
      });
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: renderQuestionMessage(turn.next, ask.preamble, ask.question),
      });
      return;
    }
    // Hand off the rest to runManagerLoop by simulating it with the existing implementation.
    // Build a minimal task wrapper that starts where we left off — done by calling
    // runManagerLoop with the seeded history/lastWorker/lastOutput is not currently supported,
    // so finalize here: ask Manager for a final summary using the new state.
    const closing = await runManager(
      {
        task: pending.task,
        members: team.members.map(n => ({ name: n, hint: wm.getDispatchHint(n) })),
        history: newHistory,
        lastWorker: turn.next,
        lastOutput: response.output,
        finalize: true,
      },
      { agent: mAgent, model: mModel, runner: this.dispatcherRunner },
    );
    const finalSummary = closing.fallback ? '' : (closing.final_summary ?? '');
    await this.sendResponse({
      chatId: message.chatId,
      channel: message.channel,
      text: this.formatManagerParts(newParts, finalSummary, 500),
    });
  }
```

Note: this auto-resume implementation runs **one** Manager turn after the answer and finalizes. If multi-turn continuation post-clarification is desired in the future, refactor `runManagerLoop` to accept a seed state. For now, keep this scoped — it covers the common case.

- [ ] **Step 2: Compile**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): resumeTeamFromAnswer for sequential and auto modes"
```

---

## Task 11: Pre-dispatch hook in handleMessage

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Add the hook in handleMessage**

In `handleMessage` (gateway.ts:498), after the `processingMessages` guard and rate-limit check, before `parseCommand`, add:

```ts
      // Resume paused team if any
      const pendingChat = this.chatStore.get(message.chatId);
      const pending = pendingChat?.pendingTeam;
      if (pending) {
        const isSlash = message.text.trimStart().startsWith('/');
        if (isSlash) {
          await this.setPendingTeam(message.chatId, null);
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: renderCancelNotice(pending),
          });
          // fall through to normal command handling
        } else {
          await this.setPendingTeam(message.chatId, null);
          this.logger.info(`[INPUT] ${message.channel}/${message.username}: ${message.text}`);
          await this.resumeTeamFromAnswer(message, pending, message.text);
          return;
        }
      }
```

Add `renderCancelNotice` to the existing `import` line from `./team-pause`.

- [ ] **Step 2: Compile**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke test (TUI)**

Run: `npm run dev` in the repo root. In another terminal, send a message that creates a team run — observe a worker output containing `[ASK_USER]:` (you can temporarily add `[ASK_USER]: are you sure?` to a worker's `personality.md` to force the path). Verify:
1. Run pauses after the asking worker.
2. The bot sends the question with the `❓` formatting.
3. Replying continues with the answer in context.
4. Replying with `/help` instead cancels with the cancellation notice.

If the manual test passes, mark this step.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): resume paused team on next user message; cancel on slash"
```

---

## Task 12: Verification

**Files:** none (verification only)

- [ ] **Step 1: Full repo type-check**

Run: `npm run build`
Expected: clean build, `dist/` updated.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run` from repo root (or the appropriate per-package command if no root script exists — check `package.json`).
Expected: all tests pass, including the new `parseAskUser`, manager prompt, and chats round-trip tests.

- [ ] **Step 3: Smoke test sequential pause + resume end-to-end**

(See Task 11 Step 3 manual test recipe.) Confirm both:
- Sequential team: worker N emits marker → pause → user reply → worker N re-runs with answer → continues to N+1.
- Auto team: worker emits marker → pause → user reply → Manager turn with userClarification → finalizes.

- [ ] **Step 4: Final commit (if any cleanup)**

If anything required adjustment during verification, commit it now:

```bash
git add -A
git commit -m "chore: verification fixes for team pause-for-input"
```

---

## Out of scope (per spec)

- Multi-question batching.
- Automatic TTL on pending state.
- Restructuring `runManagerLoop` to accept a seed state for multi-turn auto continuation post-clarification (Task 10 finalizes after one turn — adequate for the target use case).
- Mac UI component changes.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-07-team-pause-for-user-input.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
