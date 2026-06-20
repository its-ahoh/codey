# Team Runs as Per-Worker Chat Messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a team run in the Mac app as one assistant chat message *per worker* (team-chat style), each scoped to that worker's output / tool calls / thinking, grouped under a collapsible team-run header.

**Architecture:** A backend-authoritative `messageId` is minted per worker and delivered to the renderer via new `team_start` / `worker_start` / `worker_end` stream events; existing `stream` / `thinking` / `tool_*` events gain that `messageId` so concurrent (parallel) events route correctly. A new gateway `WorkerMessageEmitter` owns the per-worker message lifecycle (append stub on begin, patch on end) so live, reload, and `[ASK_USER]` resume share one identity model. The Mac reducer routes events by `messageId` instead of a single per-turn id; `ChatTab` groups messages sharing a `teamTurnId`. Channel surfaces (Telegram/Discord/iMessage) are untouched — they keep the combined transcript string.

**Tech Stack:** TypeScript (ES2020, CommonJS, strict), Vitest, React (codey-mac/Electron). Three workspaces: `@codey/core`, `@codey/gateway`, `codey-mac`.

**Spec:** `docs/superpowers/specs/2026-06-20-team-per-worker-messages-design.md`

**Pre-req:** Use Node `v22.17.1` (`nvm use 22.17.1`); default v16 cannot run vitest/tsc. Build order: `npm run build -w @codey/core && npm run build -w @codey/gateway`.

---

## File Map

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/core/src/types/chat.ts` | `ChatMessage` shape | **Modify**: add team/worker fields |
| `packages/gateway/src/chat-runner.ts` | `ChatStreamEvent` union | **Modify**: add `team_start`/`worker_start`/`worker_end`; add `messageId`/`step` to stream/thinking/tool events |
| `packages/gateway/src/chats.ts` | Chat store | **Modify**: add `updateMessage` |
| `packages/gateway/src/worker-message-emitter.ts` | Per-worker message lifecycle | **Create** |
| `packages/gateway/src/team-emitter.ts` | `ChatEmitter` / `TeamEmitter` | **Modify**: route worker-scoped events through `WorkerMessageEmitter` |
| `packages/gateway/src/gateway.ts` | `runTeamForChat` + per-mode runners + resume + finalization | **Modify**: wire begin/end worker; bypass single-append for team-on-chat |
| `packages/gateway/src/parallel-team.ts` | Parallel runner | **Modify**: per-worker stream tagging |
| `codey-mac/src/hooks/useChats.tsx` | Reducer + event dispatch | **Modify**: route by `messageId`; new actions |
| `codey-mac/src/components/teamRunModel.ts` | Derive runs | **Modify**: build runs from message group |
| `codey-mac/src/components/ChatContextPanel.tsx` | Context panel Tools/flow | **Modify**: per-worker scoping |
| `codey-mac/src/components/ChatTab.tsx` | Chat stream rendering | **Modify**: group by `teamTurnId` |
| `codey-mac/src/components/teamGroup.ts` | Group consecutive worker messages | **Create** (pure helper + test) |

---

## Phase 1 — Core types

### Task 1: Add team/worker fields to `ChatMessage`

**Files:**
- Modify: `packages/core/src/types/chat.ts:21-52`

- [ ] **Step 1: Add the fields**

In `packages/core/src/types/chat.ts`, inside `interface ChatMessage`, after the `thinkingByStep` field (line 42), add:

```typescript
  /** Groups the per-worker messages of one team run. Absent on single-agent
   *  turns and on legacy combined team turns (which use the parseTeamMessage
   *  fallback renderer). */
  teamTurnId?: string;
  /** Team name for a worker message (for the group header). */
  teamName?: string;
  /** Dispatch mode of the owning team run. */
  teamMode?: 'sequential' | 'graph' | 'auto' | 'parallel';
  /** 1-based step / run index of this worker within the team run. */
  step?: number;
  /** Worker name that produced this message. */
  worker?: string;
  /** Live status of this worker's run. */
  workerStatus?: 'running' | 'done' | 'failed' | 'askedUser';
  /** Advisor's routing reason, shown as a caption on the bubble. */
  advisorReason?: string;
```

- [ ] **Step 2: Build core to verify the type compiles**

Run: `nvm use 22.17.1 && npm run build -w @codey/core`
Expected: exits 0, no type errors. (`codey-mac` re-exports `ChatMessage` from `@codey/core` via `codey-mac/src/types/index.ts`, so the new fields propagate automatically.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/chat.ts
git commit -m "feat(core): add per-worker fields to ChatMessage"
```

---

## Phase 2 — Stream event contract

### Task 2: Extend `ChatStreamEvent`

**Files:**
- Modify: `packages/gateway/src/chat-runner.ts:33-49`

- [ ] **Step 1: Add `messageId`/`step` to worker-scoped events and the three new variants**

In `packages/gateway/src/chat-runner.ts`, replace the `tool_start`, `tool_end`, `stream`, `thinking` lines and add the new variants so the union reads:

```typescript
export type ChatStreamEvent =
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'tool_start'; chatId: string; tool?: string; message: string; input?: Record<string, unknown>; messageId?: string; step?: number }
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string; messageId?: string; step?: number }
  | { type: 'info'; chatId: string; message: string }
  | { type: 'stream'; chatId: string; token: string; messageId?: string; step?: number }
  | { type: 'thinking'; chatId: string; token: string; step?: number; messageId?: string }
  // --- team per-worker lifecycle ---
  | { type: 'team_start'; chatId: string; teamTurnId: string; teamName: string; mode: 'sequential' | 'graph' | 'auto' | 'parallel'; workers?: Array<{ messageId: string; step: number; worker: string; agent?: string; model?: string }> }
  | { type: 'worker_start'; chatId: string; teamTurnId: string; messageId: string; step: number; worker: string; agent?: string; model?: string; reason?: string }
  | { type: 'worker_end'; chatId: string; messageId: string; step: number; status: 'done' | 'failed' | 'askedUser'; tokens?: number; durationSec?: number }
  | { type: 'done'; chatId: string; response: string; thinking?: string; tokens?: number; durationSec?: number; title?: string; choices?: string[]; userQuestion?: { question: string; options: Array<{ label: string; description?: string }> }; fallback?: { from: string; to: string }; teamTurnId?: string }
  | { type: 'stopped'; chatId: string; userMessageId: string; text: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'permission_denials'; chatId: string; denials: Array<{ toolName: string; toolInput?: Record<string, unknown> }> };
```

- [ ] **Step 2: Build gateway**

Run: `npm run build -w @codey/gateway`
Expected: exits 0. Existing `sink({ type: 'stream', ... })` callers stay valid because the new fields are optional.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chat-runner.ts
git commit -m "feat(gateway): add team per-worker stream events"
```

---

## Phase 3 — Chat store `updateMessage`

### Task 3: `ChatManager.updateMessage`

**Files:**
- Modify: `packages/gateway/src/chats.ts` (next to `appendMessage`, ~line 298)
- Test: `packages/gateway/src/chats.updateMessage.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/chats.updateMessage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatManager } from './chats';

describe('ChatManager.updateMessage', () => {
  let root: string;
  let mgr: ChatManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
    mgr = new ChatManager(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('patches a message in place and persists', () => {
    const chat = mgr.createChat('ws', { type: 'team', name: 't' });
    mgr.appendMessage(chat.id, { id: 'm1', role: 'assistant', content: '', timestamp: 1, toolCalls: [], workerStatus: 'running' });

    mgr.updateMessage(chat.id, 'm1', { content: 'hello', workerStatus: 'done', isComplete: true });

    const after = mgr.getChat(chat.id)!;
    const m = after.messages.find(x => x.id === 'm1')!;
    expect(m.content).toBe('hello');
    expect(m.workerStatus).toBe('done');
    expect(m.isComplete).toBe(true);

    // persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'ws', 'chats', `${chat.id}.json`), 'utf8'));
    expect(onDisk.messages.find((x: any) => x.id === 'm1').content).toBe('hello');
  });

  it('is a no-op when the message id is unknown', () => {
    const chat = mgr.createChat('ws', { type: 'team', name: 't' });
    expect(() => mgr.updateMessage(chat.id, 'nope', { content: 'x' })).not.toThrow();
  });
});
```

> NOTE: confirm `ChatManager`'s constructor + `createChat`/`getChat` names by reading the top of `packages/gateway/src/chats.ts`. If `createChat` requires different args or `getChat` is named `requireChat`/`get`, adjust the test calls to match — do not change the production API to fit the test.

- [ ] **Step 2: Run the test, expect failure**

Run: `npx vitest run packages/gateway/src/chats.updateMessage.test.ts`
Expected: FAIL — `mgr.updateMessage is not a function`.

- [ ] **Step 3: Implement `updateMessage`**

In `packages/gateway/src/chats.ts`, directly after the `appendMessage` method (ends ~line 307), add:

```typescript
  /** Shallow-merge a patch into an existing message and persist. No-op if the
   *  message id is not found. Used by team runs to fill a worker's stub on
   *  completion. Does NOT trigger compaction (that fires on appendMessage). */
  updateMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>): Chat {
    const chat = this.requireChat(chatId);
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return chat;
    chat.messages[idx] = { ...chat.messages[idx], ...patch };
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }
```

- [ ] **Step 4: Run the test, expect pass**

Run: `npx vitest run packages/gateway/src/chats.updateMessage.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chats.ts packages/gateway/src/chats.updateMessage.test.ts
git commit -m "feat(gateway): ChatManager.updateMessage for in-place message patch"
```

---

## Phase 4 — `WorkerMessageEmitter`

This is the single object through which every worker-scoped event flows, so the `messageId` tag is consistent across all four modes. It supports two routing styles: **serial** (`beginWorker` sets the active message) and **parallel** (`teamStart` pre-creates messages keyed by worker name; events carry the worker name).

### Task 4: Create `WorkerMessageEmitter` with a unit test

**Files:**
- Create: `packages/gateway/src/worker-message-emitter.ts`
- Test: `packages/gateway/src/worker-message-emitter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/worker-message-emitter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { WorkerMessageEmitter } from './worker-message-emitter';
import type { ChatStreamEvent } from './chat-runner';

function harness() {
  const events: ChatStreamEvent[] = [];
  const appended: any[] = [];
  const patched: Array<{ id: string; patch: any }> = [];
  const store = {
    appendMessage: (_c: string, m: any) => { appended.push(m); },
    updateMessage: (_c: string, id: string, patch: any) => { patched.push({ id, patch }); },
  };
  let n = 0;
  const newId = () => `id-${++n}`;
  const em = new WorkerMessageEmitter(
    (e) => events.push(e), store, 'chat1',
    { teamTurnId: 'tt1', teamName: 'team', mode: 'auto' }, newId,
  );
  return { em, events, appended, patched };
}

describe('WorkerMessageEmitter — serial', () => {
  it('begin appends a running stub and emits worker_start with the same id', () => {
    const h = harness();
    const id = h.em.beginWorker({ step: 1, worker: 'pm', reason: 'kickoff' });
    expect(id).toBe('id-1');
    expect(h.appended[0]).toMatchObject({ id: 'id-1', role: 'assistant', workerStatus: 'running', teamTurnId: 'tt1', step: 1, worker: 'pm', advisorReason: 'kickoff' });
    expect(h.events[0]).toMatchObject({ type: 'worker_start', messageId: 'id-1', step: 1, worker: 'pm', reason: 'kickoff' });
  });

  it('routes stream/thinking/tool to the active worker and tags messageId', () => {
    const h = harness();
    const id = h.em.beginWorker({ step: 1, worker: 'pm' });
    h.em.onStream('hello ');
    h.em.onStream('world');
    h.em.onThinking('hmm', 1);
    h.em.onTool({ type: 'tool_start', tool: 'Read', message: 'Read(a)', input: { file_path: 'a' } });
    expect(h.events.filter(e => e.type === 'stream').every(e => (e as any).messageId === id)).toBe(true);
    expect(h.events.find(e => e.type === 'thinking')).toMatchObject({ messageId: id, step: 1 });
    expect(h.events.find(e => e.type === 'tool_start')).toMatchObject({ messageId: id, tool: 'Read' });
  });

  it('end patches the message with the accumulated buffers + status and emits worker_end', () => {
    const h = harness();
    const id = h.em.beginWorker({ step: 1, worker: 'pm' });
    h.em.onStream('out');
    h.em.onTool({ type: 'tool_start', tool: 'Read', message: 'Read(a)' });
    h.em.endWorker('done', { tokens: 42, durationSec: 3 });
    expect(h.patched[0].id).toBe(id);
    expect(h.patched[0].patch).toMatchObject({ content: 'out', workerStatus: 'done', isComplete: true, tokens: 42, durationSec: 3 });
    expect(h.patched[0].patch.toolCalls).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: 'worker_end', messageId: id, status: 'done' });
  });

  it('beginWorker auto-finalizes a still-active previous worker as done', () => {
    const h = harness();
    h.em.beginWorker({ step: 1, worker: 'a' });
    h.em.beginWorker({ step: 2, worker: 'b' });
    expect(h.patched[0].patch.workerStatus).toBe('done'); // a flushed
    expect(h.appended).toHaveLength(2);
  });
});

describe('WorkerMessageEmitter — parallel', () => {
  it('teamStart pre-creates one stub per worker and emits team_start with their ids', () => {
    const h = harness();
    h.em.teamStart([{ step: 1, worker: 'a' }, { step: 2, worker: 'b' }]);
    expect(h.appended.map(m => m.worker)).toEqual(['a', 'b']);
    const ev = h.events.find(e => e.type === 'team_start') as any;
    expect(ev.workers.map((w: any) => w.worker)).toEqual(['a', 'b']);
    expect(ev.workers[0].messageId).toBe(h.appended[0].id);
  });

  it('routes events to a named worker message (concurrent-safe)', () => {
    const h = harness();
    h.em.teamStart([{ step: 1, worker: 'a' }, { step: 2, worker: 'b' }]);
    const idA = h.appended[0].id, idB = h.appended[1].id;
    h.em.onStream('from-a', 'a');
    h.em.onStream('from-b', 'b');
    h.em.endWorker('done', undefined, 'a');
    expect(h.events.filter(e => e.type === 'stream').map(e => (e as any).messageId)).toEqual([idA, idB]);
    expect(h.patched[0]).toMatchObject({ id: idA, patch: { content: 'from-a', workerStatus: 'done' } });
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `npx vitest run packages/gateway/src/worker-message-emitter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the emitter**

Create `packages/gateway/src/worker-message-emitter.ts`:

```typescript
import { randomUUID } from 'crypto';
import type { ChatMessage, ToolCallEntry } from '@codey/core';
import type { ChatStreamEvent } from './chat-runner';

type Sink = (e: ChatStreamEvent) => void;

/** Minimal store surface the emitter needs (satisfied by ChatManager). */
export interface WorkerMessageStore {
  appendMessage(chatId: string, m: ChatMessage): unknown;
  updateMessage(chatId: string, id: string, patch: Partial<ChatMessage>): unknown;
}

interface Buf { messageId: string; step: number; worker: string; content: string; toolCalls: ToolCallEntry[]; thinking: string; }

export interface BeginWorkerArgs { step: number; worker: string; reason?: string; agent?: string; model?: string; }

/**
 * Owns the per-worker chat-message lifecycle for a single team run. All
 * worker-scoped events (stream/thinking/tool) flow through here so they carry a
 * stable, backend-authoritative `messageId`. Serial modes use `beginWorker`
 * (active message); parallel uses `teamStart` (pre-created, routed by worker
 * name).
 */
export class WorkerMessageEmitter {
  private active: Buf | null = null;
  private byWorker = new Map<string, Buf>();

  constructor(
    private sink: Sink,
    private store: WorkerMessageStore,
    private chatId: string,
    private meta: { teamTurnId: string; teamName: string; mode: ChatMessage['teamMode'] },
    private newId: () => string = randomUUID,
  ) {}

  /** Pre-create one stub per worker (parallel). Emits team_start. */
  teamStart(workers: Array<{ step: number; worker: string; agent?: string; model?: string }>): void {
    const list = workers.map(w => {
      const buf = this.createStub(w.step, w.worker);
      this.byWorker.set(w.worker, buf);
      return { messageId: buf.messageId, step: w.step, worker: w.worker, agent: w.agent, model: w.model };
    });
    this.sink({ type: 'team_start', chatId: this.chatId, teamTurnId: this.meta.teamTurnId, teamName: this.meta.teamName, mode: this.meta.mode!, workers: list });
  }

  /** Start a worker (serial). Flushes any still-active worker as done first. */
  beginWorker(args: BeginWorkerArgs): string {
    if (this.active) this.endWorker('done');
    const buf = this.createStub(args.step, args.worker);
    this.active = buf;
    this.sink({ type: 'worker_start', chatId: this.chatId, teamTurnId: this.meta.teamTurnId, messageId: buf.messageId, step: args.step, worker: args.worker, reason: args.reason, agent: args.agent, model: args.model });
    return buf.messageId;
  }

  onStream(token: string, worker?: string): void {
    const buf = this.target(worker);
    if (!buf) return;
    buf.content += token;
    this.sink({ type: 'stream', chatId: this.chatId, token, messageId: buf.messageId, step: buf.step });
  }

  onThinking(token: string, step: number, worker?: string): void {
    const buf = this.target(worker);
    if (!buf) return;
    buf.thinking += token;
    this.sink({ type: 'thinking', chatId: this.chatId, token, step, messageId: buf.messageId });
  }

  onTool(entry: { type: 'tool_start' | 'tool_end'; tool?: string; message?: string; input?: Record<string, unknown>; output?: string }, worker?: string): void {
    const buf = this.target(worker);
    if (!buf) return;
    const tc: ToolCallEntry = { id: this.newId(), type: entry.type, tool: entry.tool, message: entry.message ?? '', input: entry.input, output: entry.output };
    buf.toolCalls.push(tc);
    if (entry.type === 'tool_start') this.sink({ type: 'tool_start', chatId: this.chatId, tool: entry.tool, message: entry.message ?? '', input: entry.input, messageId: buf.messageId, step: buf.step });
    else this.sink({ type: 'tool_end', chatId: this.chatId, tool: entry.tool, message: entry.message ?? '', output: entry.output, messageId: buf.messageId, step: buf.step });
  }

  /** Finalize a worker. For parallel pass `worker`; for serial it finalizes the active one. */
  endWorker(status: 'done' | 'failed' | 'askedUser', extra?: { tokens?: number; durationSec?: number }, worker?: string): void {
    const buf = worker ? this.byWorker.get(worker) : this.active;
    if (!buf) return;
    this.store.updateMessage(this.chatId, buf.messageId, {
      content: buf.content,
      toolCalls: buf.toolCalls,
      thinking: buf.thinking || undefined,
      workerStatus: status,
      isComplete: true,
      ...(extra?.tokens != null ? { tokens: extra.tokens } : {}),
      ...(extra?.durationSec != null ? { durationSec: extra.durationSec } : {}),
    });
    this.sink({ type: 'worker_end', chatId: this.chatId, messageId: buf.messageId, step: buf.step, status, tokens: extra?.tokens, durationSec: extra?.durationSec });
    if (buf === this.active) this.active = null;
  }

  /** The message id of the currently-active serial worker (for resume mapping). */
  get activeMessageId(): string | null { return this.active?.messageId ?? null; }

  private target(worker?: string): Buf | null {
    return worker ? (this.byWorker.get(worker) ?? null) : this.active;
  }

  private createStub(step: number, worker: string): Buf {
    const messageId = this.newId();
    const buf: Buf = { messageId, step, worker, content: '', toolCalls: [], thinking: '' };
    const stub: ChatMessage = {
      id: messageId, role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [], isComplete: false,
      teamTurnId: this.meta.teamTurnId, teamName: this.meta.teamName, teamMode: this.meta.mode,
      step, worker, workerStatus: 'running',
    };
    this.store.appendMessage(this.chatId, stub);
    return buf;
  }
}
```

> The `advisorReason` caption is set via the `reason` on `worker_start`; persist it on the stub too by adding `advisorReason: args.reason` — adjust `createStub` to accept an optional `reason` and set it. (The test asserts `advisorReason: 'kickoff'` on the appended stub, so thread `reason` from `beginWorker` into `createStub`.)

- [ ] **Step 4: Thread `reason` into the stub so the test passes**

Update `beginWorker` to call `this.createStub(args.step, args.worker, args.reason)` and change `createStub(step, worker, reason?)` to set `advisorReason: reason` on the stub.

- [ ] **Step 5: Run the test, expect pass**

Run: `npx vitest run packages/gateway/src/worker-message-emitter.test.ts`
Expected: PASS (all serial + parallel cases).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/worker-message-emitter.ts packages/gateway/src/worker-message-emitter.test.ts
git commit -m "feat(gateway): WorkerMessageEmitter owns per-worker message lifecycle"
```

---

## Phase 5 — Wire the gateway run path

`runTeamForChat` builds a `runOneWorker` closure and dispatches by mode. We add a `WorkerMessageEmitter` and route worker-scoped events through it, while keeping the existing transcript accumulation (returned for channels). The single combined-message append at `gateway.ts:4268` is bypassed when the run produced per-worker messages.

### Task 5: Construct the emitter and expose it to the run

**Files:**
- Modify: `packages/gateway/src/gateway.ts` `runTeamForChat` (signature/top ~3112-3135, runOneWorker ~3131-3172)

- [ ] **Step 1: Mint `teamTurnId` and build the emitter at the top of `runTeamForChat`**

Immediately after the team is resolved and before `runOneWorker` is defined (just before line ~3131), add:

```typescript
    const teamTurnId = randomUUID();
    const workerMsgs = new WorkerMessageEmitter(
      sink,
      this.chatManager,
      chatId,
      { teamTurnId, teamName, mode: (useAdvisor ? 'auto' : team.graph ? 'graph' : team.dispatch === 'parallel' ? 'parallel' : 'sequential') },
    );
```

Import at the top of `gateway.ts`:

```typescript
import { WorkerMessageEmitter } from './worker-message-emitter';
```

> `useAdvisor` / `team.graph` / `team.dispatch` are computed lower in the function today. Hoist the `mode` decision: compute a `const teamMode = ...` near the existing dispatch detection and pass it into the emitter constructor. Read lines 3174-3240 to see where `useAdvisor` and the parallel/graph branches are decided, and lift the boolean checks up so `teamMode` is known before the emitter is built.

- [ ] **Step 2: Route the serial `runOneWorker` stream/tool/thinking through the emitter**

In the `runOneWorker` closure (lines 3131-3172), replace the direct `sink(...)` calls so worker output is tagged:

- `onStream: (text: string) => sink({ type: 'stream', chatId, token: text })`
  → `onStream: (text: string) => workerMsgs.onStream(text)`
- In `onStatus`, replace the two `sink({ type: 'tool_start'/'tool_end', ... })` calls with:
  ```typescript
  if (parsed?.type === 'tool_start') {
    workerMsgs.onTool({ type: 'tool_start', tool: parsed.tool, message: parsed.message ?? '', input: parsed.input });
  } else if (parsed?.type === 'tool_end') {
    workerMsgs.onTool({ type: 'tool_end', tool: parsed.tool, message: parsed.message ?? '', output: parsed.output });
  }
  ```
- The `onThinking` passed by callers should funnel to `workerMsgs.onThinking(text, step)` (wired per-mode in Task 6/7).

- [ ] **Step 3: Build**

Run: `npm run build -w @codey/gateway`
Expected: exits 0 (the per-mode begin/end calls come next; output may currently route to a not-yet-active worker, which is a safe no-op).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): build WorkerMessageEmitter in runTeamForChat"
```

### Task 6: Wire auto/advisor mode boundaries

**Files:**
- Modify: `packages/gateway/src/gateway.ts` auto branch (3279-3303) and `runAdvisorLoop` thinking hook

- [ ] **Step 1: Begin/end a worker per advisor step**

In the auto branch `perStep` callback (lines 3288-3300), in the `kind === 'route'` arm, after the existing `info`/`stream` sinks, add a begin:

```typescript
            workerMsgs.beginWorker({ step: msg.step, worker: msg.worker, reason: msg.reason });
```

Keep the existing `### Step N` stream-token sink (it feeds the channel transcript / combined `output`), but note its `token` now also lands in the worker message buffer because `onStream` is routed — to avoid the `### Step` heading polluting the bubble, change that specific heading emit to go straight to the raw `sink` (not through `workerMsgs`). It already calls `sink(...)` directly, so leave it; only the *worker agent* output goes through `workerMsgs.onStream`.

- [ ] **Step 2: End the worker when its step output is known**

`runAdvisorLoop` pushes `parts.push({ step, worker: turnNext, output: cleanOutput, isRevision })` at line ~2248 after the worker runs. Add an `onStepDone` callback to `runAdvisorLoop`'s options (alongside `perStep`) invoked right after that push with `{ step, worker: turnNext, failed: !response.success }`, and in the auto branch implement it as:

```typescript
        (done) => workerMsgs.endWorker(done.failed ? 'failed' : 'done', undefined),
```

Route per-step thinking: where `runAdvisorLoop` records `thinkingByStep[step] = response.thinking`, also stream it live — pass an `onThinking` into the worker run that calls `workerMsgs.onThinking(text, step)`. (Confirm whether `runWorker`/`runOneWorker` is invoked with an `onThinking` in the advisor loop; if not, thread one through using the same pattern as `runAllMembersInOrder`'s `(t) => emitter.onThinking(t, i + 1)`.)

- [ ] **Step 3: Build + manual smoke**

Run: `npm run build -w @codey/gateway`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): per-worker messages for auto/advisor team mode"
```

### Task 7: Wire sequential (`runAllMembersInOrder`) and graph (`continueGraphRun`) boundaries

**Files:**
- Modify: `packages/gateway/src/gateway.ts` `runAllMembersInOrder` (2765-2855), `continueGraphRun` (2948-3073), `runSequentialGraphForChatSink` (3081-3110)
- Modify: `packages/gateway/src/team-emitter.ts` (`ChatEmitter` gains an optional worker emitter)

These two modes go through `ChatEmitter`. Give `ChatEmitter` an optional `WorkerMessageEmitter` and `beginWorker`/`endWorker` passthroughs so the worker boundaries are expressed on the emitter the runners already hold.

- [ ] **Step 1: Extend `TeamEmitter` / `ChatEmitter`**

In `packages/gateway/src/team-emitter.ts`, add to the `TeamEmitter` interface:

```typescript
  beginWorker?(args: { step: number; worker: string; reason?: string }): void;
  endWorker?(status: 'done' | 'failed' | 'askedUser'): void;
```

In `ChatEmitter`, accept an optional emitter and route worker-scoped output through it:

```typescript
  constructor(private sink: SinkLike, private chatId: string, private workerMsgs?: WorkerMessageEmitter) {}
  // ...
  onStream(token: string): void {
    this.parts.push(token);
    if (this.workerMsgs) { this.workerMsgs.onStream(token); return; }
    try { this.sink({ type: 'stream', chatId: this.chatId, token }); } catch { /* swallow */ }
  }
  onThinking(token: string, step: number): void {
    if (this.workerMsgs) { this.workerMsgs.onThinking(token, step); return; }
    try { this.sink({ type: 'thinking', chatId: this.chatId, token, step }); } catch { /* swallow */ }
  }
  beginWorker(args: { step: number; worker: string; reason?: string }): void { this.workerMsgs?.beginWorker(args); }
  endWorker(status: 'done' | 'failed' | 'askedUser'): void { this.workerMsgs?.endWorker(status); }
```

> `status()` (the `🔄 Worker … is working` markers and `↪️ next step` reasons) still go to the raw `sink` as `info` — those drive the legacy/team-flow narration and must NOT enter worker buffers. Leave `status()`/`notify()` unchanged.

- [ ] **Step 2: Pass the worker emitter when constructing `ChatEmitter`**

In `runSequentialGraphForChatSink` (line 3099) change `new ChatEmitter(sink, chatId)` → `new ChatEmitter(sink, chatId, workerMsgs)`. The non-graph sequential path constructs `ChatEmitter` at `gateway.ts:3242` (`const emitter = new ChatEmitter(sink, chatId)`) — change it the same way. Thread `workerMsgs` into `runSequentialGraphForChatSink`'s parameters (add a trailing `workerMsgs: WorkerMessageEmitter` arg and pass it at the call site ~line 3240).

- [ ] **Step 3: Call begin/end at the boundaries**

In `runAllMembersInOrder`, replace the start marker (line ~2801):

```typescript
      await emitter.status(`🔄 Worker **${worker.name}** is working...`);
      emitter.beginWorker?.({ step: i + 1, worker: worker.name });
```

After a successful worker (`results.push(\`**${worker.name}**: ${cleanOutput}\`)`, line ~2846) add `emitter.endWorker?.('done');`. On the failure `break` (line ~2810) add `emitter.endWorker?.('failed');` before breaking. On the `[ASK_USER]` pause (`return { thinkingByStep }`) add `emitter.endWorker?.('askedUser');` before returning.

In `continueGraphRun`, mirror it: after `await emitter.status(\`🔄 Step ${++stepIndex}: ...\`)` (line ~3009) add `emitter.beginWorker?.({ step: stepIndex, worker: worker.name });`; after `results.push(\`**${worker.name}**:\n${ingested.stripped}\`)` (line ~3027) add `emitter.endWorker?.('done');`; on `not found` / `Failed` breaks add `emitter.endWorker?.('failed');`; on the `[ASK_USER]` `return emitter.transcript` add `emitter.endWorker?.('askedUser');` before returning. The judge's `↪️ ${reason}` status stays a raw `info`.

- [ ] **Step 4: Build**

Run: `npm run build -w @codey/gateway`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/team-emitter.ts
git commit -m "feat(gateway): per-worker messages for sequential and graph team modes"
```

### Task 8: Wire parallel mode (pre-created bubbles, routed by worker)

**Files:**
- Modify: `packages/gateway/src/parallel-team.ts` (constructor options 38-51, `runWorkerLoop` 109-161)
- Modify: `packages/gateway/src/gateway.ts` parallel branch (~3186-3275)

- [ ] **Step 1: Add a per-worker event callback to `ParallelTeamRunner`**

In `ParallelTeamRunnerOptions` (parallel-team.ts:38-51), add:

```typescript
  /** Called when a worker's agent produces stream/tool/thinking output. The
   *  `worker` name lets the chat surface route it to that worker's message. */
  onWorkerEvent?: (worker: string, ev: { kind: 'stream'; token: string } | { kind: 'thinking'; token: string } | { kind: 'tool_start' | 'tool_end'; tool?: string; message?: string; input?: Record<string, unknown>; output?: string }) => void;
```

In `runWorkerLoop`, the `worker` name is in scope. Build the per-worker runner so its stream/status flows to `onWorkerEvent(worker, …)`. Where the runner is constructed for this worker (the `workerRunner`/`AgentRunner` wiring), bind its `onStream`/`onStatus`/`onThinking` to call `this.opts.onWorkerEvent?.(worker, …)`. (Read how `workerRunner` is created in gateway's parallel branch — lines ~3186-3260 build `runner = new ParallelTeamRunner({ workerRunner: … })`; the `workerRunner` there wraps `runWorkerStep` whose `onStream`/`onStatus` currently feed the shared `sink`. Move that wiring so each invocation knows its `worker`.)

- [ ] **Step 2: Pre-create bubbles + route in the gateway parallel branch**

In the parallel branch of `runTeamForChat` (before starting the runner), call:

```typescript
        workerMsgs.teamStart(team.members.map((w, i) => ({ step: i + 1, worker: w })));
```

Pass `onWorkerEvent` into the `ParallelTeamRunner` options:

```typescript
        onWorkerEvent: (worker, ev) => {
          if (ev.kind === 'stream') workerMsgs.onStream(ev.token, worker);
          else if (ev.kind === 'thinking') workerMsgs.onThinking(ev.token, 0, worker);
          else workerMsgs.onTool({ type: ev.kind, tool: ev.tool, message: ev.message, input: ev.input, output: ev.output }, worker);
        },
```

Replace the shared `onStream: (text) => sink({ type: 'stream', ... })` (line ~3102 area in the parallel options) — the roundtable *narration*/`onFinal` summary stays on the raw `sink` (it is not worker-scoped), but per-worker agent output now goes through `onWorkerEvent`.

When the runner reports a worker finished (the `worker_done`/`worker_failed` transcript append in `runWorkerLoop`), surface it via a new optional `onWorkerDone?(worker, ok)` option and call `workerMsgs.endWorker(ok ? 'done' : 'failed', undefined, worker)` in the gateway. Add `onWorkerDone` to the options and invoke it right after the `appendTranscript(..., { kind: 'worker_done'|'worker_failed' })` calls (lines ~127-134).

- [ ] **Step 3: Build**

Run: `npm run build -w @codey/gateway`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/parallel-team.ts packages/gateway/src/gateway.ts
git commit -m "feat(gateway): per-worker messages for parallel team mode"
```

### Task 9: Bypass the single combined-message append for team-on-chat runs

**Files:**
- Modify: `packages/gateway/src/gateway.ts` finalization (4268-4302)

The finalization currently always appends ONE `assistantMessage` (line 4268) and emits `done`. For team-on-chat runs the worker messages are already appended by the emitter, so the combined append must be skipped — but the combined `output` string is still needed for channel mirroring and `done.response`.

- [ ] **Step 1: Detect a per-worker run**

`runTeamForChat` already returns `{ response, choices, thinkingByStep }`. Extend its return with `teamTurnId?: string` and set it when at least one worker message was emitted (e.g. return `teamTurnId` whenever the run went through `workerMsgs`). Capture it where `runTeamForChat`'s result is consumed (search for the call site assembling `output`/`teamThinkingByStep`, near the team dispatch around line ~4100-4200).

- [ ] **Step 2: Guard the append**

At the finalization (line ~4283), wrap the combined append:

```typescript
      if (!teamTurnId) {
        const updated = this.chatManager.appendMessage(chatId, assistantMessage);
        // ...existing lastAskedOptions/title handling that depends on `updated`...
      }
```

For the team case, the title/`done` handling still needs to run. Refactor so the title-application and `sink({ type: 'done', ... })` happen regardless, but `appendMessage` only runs for non-team turns. Emit `done` with `teamTurnId` set for team runs:

```typescript
      sink({ type: 'done', chatId, response: output, thinking: singleAgentResponse?.thinking, tokens, durationSec, title: finalTitle, choices: surfacedChoices, userQuestion: agentUserQuestion, fallback: singleAgentResponse?.fallback, ...(teamTurnId ? { teamTurnId } : {}) });
```

> The channel-mirror block below (`originChannel`/`originUserId`) consumes `output` — leave it untouched so Telegram/Discord/iMessage still receive the combined transcript.

- [ ] **Step 3: Build + full gateway test suite**

Run: `npm run build -w @codey/gateway && npm test -w @codey/gateway`
Expected: build 0; existing tests pass (no regression in single-agent finalization).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): skip combined append for per-worker team runs"
```

### Task 10: Resume / `[ASK_USER]` continues the asking worker's message

**Files:**
- Modify: `packages/gateway/src/gateway.ts` `resumeTeamFromAnswer` (2530-2641) and its call site (~4088-4096)

At pause, the asking worker's stub already exists with `workerStatus: 'askedUser'` (Tasks 6/7/8 end it as `askedUser`). On resume we continue subsequent workers as new messages within the same `teamTurnId`.

- [ ] **Step 1: Thread a `WorkerMessageEmitter` into resume**

`resumeTeamFromAnswer(chatId, convBase, pending, answer, emitter)` receives a `TeamEmitter`. At the call site (~4088), the resume builds an emitter; construct a `WorkerMessageEmitter` reusing the **same** `teamTurnId` the paused run used. Persist `teamTurnId` into `PendingTeamState` so resume can recover it:
  - Add `teamTurnId: string` to all three `PendingTeamState` variants in `packages/core/src/types/pending-team.ts`.
  - Set it wherever `persistPendingTeam`/`this.chatManager.setPendingTeam` records a pause (sequential ~runAllMembersInOrder ask block, graph ~continueGraphRun ask block, auto ~runAdvisorLoop ask block). The `teamTurnId` is in scope from `runTeamForChat`.
  - In resume, build `new ChatEmitter(sink, chatId, new WorkerMessageEmitter(sink, this.chatManager, chatId, { teamTurnId: pending.teamTurnId, teamName: pending.teamName, mode: pending.mode === 'graph' ? 'graph' : pending.mode }))` and pass `beginWorker`/`endWorker` calls for each resumed worker (same pattern as Task 7).

- [ ] **Step 2: Mark the paused worker resolved**

Before running the next worker on resume, patch the asking worker's message from `askedUser` → `done` (its output is already persisted). Locate the asking message by `teamTurnId` + `askingWorker` + highest `step`; call `this.chatManager.updateMessage(chatId, id, { workerStatus: 'done' })`.

- [ ] **Step 3: Build**

Run: `npm run build -w @codey/core && npm run build -w @codey/gateway`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/pending-team.ts packages/gateway/src/gateway.ts
git commit -m "feat(gateway): resume continues the team run's per-worker messages"
```

---

## Phase 6 — Mac renderer

### Task 11: Reducer — route by `messageId`; new team actions

**Files:**
- Modify: `codey-mac/src/hooks/useChats.tsx` (Action union 29-53, `InFlight` 6-13, reducer cases 197-245)
- Test: `codey-mac/src/hooks/useChats.reducer.test.ts` (create)

- [ ] **Step 1: Write the failing reducer test**

Create `codey-mac/src/hooks/useChats.reducer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reducer, type State } from './useChats';

function baseState(): State {
  return {
    chats: { c1: { id: 'c1', title: 't', workspaceName: 'ws', selection: { type: 'team', name: 'team' }, messages: [], createdAt: 0, updatedAt: 0 } },
    order: ['c1'], selectedChatId: 'c1',
    inFlight: { c1: { assistantMessageId: 'asst-x', userMessageId: 'u1', agentStatus: 'thinking' } },
    collapsedWorkspaces: {}, workspaces: ['ws'], pendingRestores: {}, unreadChats: {}, pendingPermissions: {},
  };
}

describe('team reducer routing', () => {
  it('workerStart appends a running worker message with the backend id', () => {
    let s = baseState();
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w1', step: 1, worker: 'pm', reason: 'kickoff' });
    const m = s.chats.c1.messages.find(x => x.id === 'w1')!;
    expect(m).toMatchObject({ id: 'w1', role: 'assistant', teamTurnId: 'tt1', worker: 'pm', workerStatus: 'running', advisorReason: 'kickoff' });
  });

  it('streamToken/toolCall route to the event messageId, not the single inFlight id', () => {
    let s = baseState();
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w1', step: 1, worker: 'a', reason: '' });
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w2', step: 2, worker: 'b', reason: '' });
    s = reducer(s, { type: 'streamToken', chatId: 'c1', token: 'hi', messageId: 'w1' });
    s = reducer(s, { type: 'toolCall', chatId: 'c1', entry: { id: 't', type: 'tool_start', tool: 'Read', message: 'Read(a)' }, status: 'working', messageId: 'w2' });
    expect(s.chats.c1.messages.find(x => x.id === 'w1')!.content).toBe('hi');
    expect(s.chats.c1.messages.find(x => x.id === 'w2')!.toolCalls).toHaveLength(1);
    expect(s.chats.c1.messages.find(x => x.id === 'w1')!.toolCalls ?? []).toHaveLength(0);
  });

  it('workerEnd sets status', () => {
    let s = baseState();
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w1', step: 1, worker: 'a', reason: '' });
    s = reducer(s, { type: 'workerEnd', chatId: 'c1', messageId: 'w1', step: 1, status: 'done' });
    expect(s.chats.c1.messages.find(x => x.id === 'w1')!.workerStatus).toBe('done');
  });
});
```

> Verify `reducer` and `State` are exported from `useChats.tsx`. They are (`export function reducer`, `export interface State`). If `createChat`-style helpers are needed they are not — the test builds state literally.

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run codey-mac/src/hooks/useChats.reducer.test.ts`
Expected: FAIL — unknown action types / routing uses `fl.assistantMessageId`.

- [ ] **Step 3: Add actions and routing**

In the `Action` union (line 29-53) add:

```typescript
  | { type: 'teamStart'; chatId: string; teamTurnId: string; teamName: string; mode: 'sequential' | 'graph' | 'auto' | 'parallel'; workers?: Array<{ messageId: string; step: number; worker: string }> }
  | { type: 'workerStart'; chatId: string; teamTurnId: string; messageId: string; step: number; worker: string; reason?: string }
  | { type: 'workerEnd'; chatId: string; messageId: string; step: number; status: 'running' | 'done' | 'failed' | 'askedUser' }
```

Add an optional `messageId?: string` to the existing `streamToken`, `thinkingToken`, and `toolCall` action variants (lines 41-43).

Add reducer cases (near the other team handling):

```typescript
    case 'teamStart': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const stubs = (action.workers ?? []).map(w => mkWorkerStub(action.teamTurnId, action.teamName, action.mode, w.messageId, w.step, w.worker))
      if (stubs.length === 0) return state
      const existing = new Set(chat.messages.map(m => m.id))
      const messages = [...chat.messages, ...stubs.filter(s => !existing.has(s.id))]
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } } }
    }
    case 'workerStart': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      if (chat.messages.some(m => m.id === action.messageId)) return state
      const teamName = chat.messages.find(m => m.teamTurnId === action.teamTurnId)?.teamName ?? (chat.selection.type === 'team' ? chat.selection.name ?? '' : '')
      const mode = chat.messages.find(m => m.teamTurnId === action.teamTurnId)?.teamMode ?? 'auto'
      const stub = mkWorkerStub(action.teamTurnId, teamName, mode, action.messageId, action.step, action.worker, action.reason)
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages: [...chat.messages, stub], updatedAt: Date.now() } } }
    }
    case 'workerEnd': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const messages = chat.messages.map(m => m.id === action.messageId ? { ...m, workerStatus: action.status, isComplete: action.status !== 'running' } : m)
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } } }
    }
```

Add a helper near the top of the reducer module:

```typescript
function mkWorkerStub(teamTurnId: string, teamName: string, mode: ChatMessage['teamMode'], id: string, step: number, worker: string, reason?: string): ChatMessage {
  return { id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [], isComplete: false, teamTurnId, teamName, teamMode: mode, step, worker, workerStatus: 'running', advisorReason: reason }
}
```

Update the three routed cases to honor an explicit `messageId`:

- `thinkingToken` (line 207): `const targetId = action.messageId ?? fl.assistantMessageId` and map on `m.id === targetId`.
- `streamToken` (line 222): `const targetId = action.messageId ?? fl.assistantMessageId` and map on `m.id === targetId`.
- `toolCall` (line 235): `const targetId = action.messageId ?? fl.assistantMessageId` and map on `m.id === targetId`.

> Keep the `fl` guard but do not bail when only `messageId` is provided and the message exists — for team turns the routed message exists independent of `fl.assistantMessageId`. Adjust the early `if (!chat || !fl) return state` to `if (!chat) return state` for these three cases, then resolve `targetId` (falling back to `fl?.assistantMessageId`).

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run codey-mac/src/hooks/useChats.reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx codey-mac/src/hooks/useChats.reducer.test.ts
git commit -m "feat(codey-mac): reducer routes team events by messageId"
```

### Task 12: Dispatch the new events in `onEvent`

**Files:**
- Modify: `codey-mac/src/hooks/useChats.tsx` `onEvent` (400-480)

- [ ] **Step 1: Handle `team_start` / `worker_start` / `worker_end` and forward `messageId`**

In the `switch (ev.type)` (line 425), add cases and thread `messageId`:

```typescript
        case 'team_start':
          dispatch({ type: 'teamStart', chatId: ev.chatId, teamTurnId: ev.teamTurnId, teamName: ev.teamName, mode: ev.mode, workers: ev.workers })
          break
        case 'worker_start':
          dispatch({ type: 'workerStart', chatId: ev.chatId, teamTurnId: ev.teamTurnId, messageId: ev.messageId, step: ev.step, worker: ev.worker, reason: ev.reason })
          break
        case 'worker_end':
          dispatch({ type: 'workerEnd', chatId: ev.chatId, messageId: ev.messageId, step: ev.step, status: ev.status })
          break
```

In `tool_start`, `tool_end`, `info`, `stream`, `thinking` cases (lines 429-457), pass `messageId: (ev as any).messageId` into each dispatch (and `step` where relevant). E.g. `dispatch({ type: 'streamToken', chatId: ev.chatId, token: ev.token, messageId: ev.messageId })`.

Add `team_start`/`worker_start`/`worker_end` to the adoption guard's event-type list (line 408) so an adopted team turn still opens an inFlight entry.

- [ ] **Step 2: Build the renderer**

Run: `npm run build -w codey-mac` (or `npx tsc -p codey-mac --noEmit`)
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx
git commit -m "feat(codey-mac): dispatch team per-worker stream events"
```

---

## Phase 7 — Rendering

### Task 13: Group consecutive worker messages (pure helper + test)

**Files:**
- Create: `codey-mac/src/components/teamGroup.ts`
- Test: `codey-mac/src/components/teamGroup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/src/components/teamGroup.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { groupMessages } from './teamGroup';
import type { ChatMessage } from '../types';

const m = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'assistant', content: id, timestamp: 0, ...extra });

describe('groupMessages', () => {
  it('wraps a run of same-teamTurnId messages into one team block', () => {
    const msgs = [
      m('u', { role: 'user' }),
      m('w1', { teamTurnId: 'tt', teamName: 'T', teamMode: 'auto', worker: 'a', step: 1 }),
      m('w2', { teamTurnId: 'tt', teamName: 'T', teamMode: 'auto', worker: 'b', step: 2 }),
      m('after'),
    ];
    const out = groupMessages(msgs);
    expect(out.map(x => x.kind)).toEqual(['single', 'team', 'single']);
    const team = out[1];
    expect(team.kind === 'team' && team.teamTurnId).toBe('tt');
    expect(team.kind === 'team' && team.messages.map(mm => mm.id)).toEqual(['w1', 'w2']);
  });

  it('legacy combined team message (no teamTurnId) stays single', () => {
    const out = groupMessages([m('legacy', { content: '### Step 1: a\n\nx' })]);
    expect(out[0].kind).toBe('single');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run codey-mac/src/components/teamGroup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `codey-mac/src/components/teamGroup.ts`:

```typescript
import type { ChatMessage } from '../types'

export type RenderItem =
  | { kind: 'single'; message: ChatMessage }
  | { kind: 'team'; teamTurnId: string; teamName?: string; teamMode?: ChatMessage['teamMode']; messages: ChatMessage[] }

/** Collapse consecutive assistant messages sharing a teamTurnId into one team
 *  block; everything else passes through as a single. */
export function groupMessages(messages: ChatMessage[]): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    const ttid = msg.teamTurnId
    if (ttid) {
      const group: ChatMessage[] = []
      while (i < messages.length && messages[i].teamTurnId === ttid) { group.push(messages[i]); i++ }
      out.push({ kind: 'team', teamTurnId: ttid, teamName: group[0].teamName, teamMode: group[0].teamMode, messages: group })
    } else {
      out.push({ kind: 'single', message: msg })
      i++
    }
  }
  return out
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run codey-mac/src/components/teamGroup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/teamGroup.ts codey-mac/src/components/teamGroup.test.ts
git commit -m "feat(codey-mac): groupMessages helper for team-run blocks"
```

### Task 14: Render team-run groups in `ChatTab`

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx` (message map ~1015-1090, `TeamMessage` 229-275, styles)

- [ ] **Step 1: Map over grouped items**

Where `ChatTab` maps `chat.messages` to bubbles (the `.map(msg => …)` around line 1015), first compute `const items = groupMessages(chat.messages)` (import from `./teamGroup`) and map over `items`. For `kind === 'single'` render the existing bubble unchanged. For `kind === 'team'` render a new `<TeamRunGroup>` (below).

- [ ] **Step 2: Add the `TeamRunGroup` component**

In `ChatTab.tsx` add:

```tsx
const TeamRunGroup: React.FC<{
  item: Extract<import('./teamGroup').RenderItem, { kind: 'team' }>
  isStreaming: boolean
  selectedTurnId: string | null
  panelOpen: boolean
  onSelectTurn: (id: string) => void
}> = ({ item, isStreaming, selectedTurnId, panelOpen, onSelectTurn }) => {
  const [collapsed, setCollapsed] = React.useState(false)
  const lastId = item.messages[item.messages.length - 1]?.id
  return (
    <div style={styles.teamGroup}>
      <div style={styles.teamGroupHeader} onClick={() => setCollapsed(c => !c)}>
        <span style={{ ...styles.teamStepChevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>▶</span>
        <span style={styles.teamGroupTitle}>Team: {item.teamName ?? '—'} · {item.teamMode}</span>
        <span style={styles.teamGroupCount}>{item.messages.length} workers</span>
      </div>
      {!collapsed && item.messages.map(m => {
        const running = isStreaming && m.id === lastId && m.workerStatus === 'running'
        const selected = m.id === selectedTurnId && panelOpen
        return (
          <div key={m.id}
            style={{ ...styles.teamWorkerBubble, ...(selected ? styles.teamWorkerBubbleActive : null) }}
            onClick={() => onSelectTurn(m.id)}>
            <div style={styles.teamWorkerHead}>
              <span style={styles.teamStepLabel}>Step {m.step}: {m.worker}</span>
              {m.workerStatus === 'failed' && <span style={styles.teamWorkerFailed}>failed</span>}
              {running && <span style={styles.teamStepRunning}>● running</span>}
            </div>
            {m.advisorReason && <div style={styles.teamWorkerReason}>{m.advisorReason}</div>}
            <div style={styles.teamStepBody}><Markdown variant="assistant">{m.content || '…'}</Markdown></div>
          </div>
        )
      })}
    </div>
  )
}
```

Add styles to the `styles` object (mirror the existing `teamStepCard`/`teamStepLabel`/`teamStepRunning` values):

```typescript
  teamGroup: { border: `1px solid ${C.border}`, borderRadius: 10, margin: '6px 0', overflow: 'hidden', background: C.surface2 },
  teamGroupHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` },
  teamGroupTitle: { flex: 1, fontSize: 12, fontWeight: 600, color: C.fg },
  teamGroupCount: { fontSize: 11, color: C.fg3 },
  teamWorkerBubble: { padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, cursor: 'pointer' },
  teamWorkerBubbleActive: { background: C.surface3 },
  teamWorkerHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  teamWorkerReason: { fontSize: 11, color: C.fg3, marginBottom: 4 },
  teamWorkerFailed: { fontSize: 10, color: C.red ?? '#e66', textTransform: 'uppercase' },
```

> Confirm the prop names `ChatTab` already uses for turn selection (search for `setSelectedTurnIdState` / `selectedTurnId` / `panelOpen` near line 1015) and pass the matching handler into `onSelectTurn`. Reuse the existing per-message click→select-turn logic so clicking a worker bubble opens the context panel scoped to that message.

- [ ] **Step 3: Keep the legacy `TeamMessage` fallback**

Leave the existing `TeamMessage` (line 229) and its `parseTeamMessage` usage in the `kind === 'single'` path so older persisted combined team turns still render. New per-worker turns never hit it (they render via `TeamRunGroup`).

- [ ] **Step 4: Build + visually confirm**

Run: `npx tsc -p codey-mac --noEmit`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(codey-mac): render team runs as grouped per-worker bubbles"
```

### Task 15: Context panel + flow model from the message group

**Files:**
- Modify: `codey-mac/src/components/teamRunModel.ts` (`deriveWorkerRuns` 36-57, `toolCallsForStep` 62-73)
- Modify: `codey-mac/src/components/ChatContextPanel.tsx` (`ToolTimeline` 394-401, `TeamFlow` 312-370, `TeamRunFlow` props)
- Test: `codey-mac/src/components/teamRunModel.test.ts` (create or extend)

- [ ] **Step 1: Add a group-aware `deriveWorkerRuns` overload**

In `teamRunModel.ts`, add a function that builds runs from a worker-message group (used when `turn.teamTurnId` is set):

```typescript
export function deriveWorkerRunsFromGroup(messages: ChatMessage[]): WorkerRun[] {
  return messages
    .filter(m => m.teamTurnId && m.worker)
    .map(m => ({
      step: m.step ?? 0,
      worker: m.worker!,
      status: (m.workerStatus ?? 'done') as NodeRunStatus,
      output: m.content,
      thinking: m.thinking,
    }))
    .sort((a, b) => a.step - b.step)
}
```

- [ ] **Step 2: Write the failing test**

Create `codey-mac/src/components/teamRunModel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveWorkerRunsFromGroup } from './teamRunModel';
import type { ChatMessage } from '../types';

const w = (step: number, worker: string, status: any, content: string): ChatMessage =>
  ({ id: `w${step}`, role: 'assistant', content, timestamp: 0, teamTurnId: 'tt', worker, step, workerStatus: status });

describe('deriveWorkerRunsFromGroup', () => {
  it('builds ordered runs from the group, carrying status + output', () => {
    const runs = deriveWorkerRunsFromGroup([w(2, 'b', 'running', 'B'), w(1, 'a', 'done', 'A')]);
    expect(runs.map(r => [r.step, r.worker, r.status, r.output])).toEqual([
      [1, 'a', 'done', 'A'], [2, 'b', 'running', 'B'],
    ]);
  });
});
```

Run: `npx vitest run codey-mac/src/components/teamRunModel.test.ts`
Expected: FAIL then (after Step 1 present) PASS. Run again to confirm PASS.

- [ ] **Step 3: Make the context panel pass the group**

`ChatContextPanel` currently receives a single `turn`. When `selectedTurnId` points at a worker message, gather its group: `chat.messages.filter(m => m.teamTurnId === turn.teamTurnId)`. Pass that to `TeamRunFlow` (replace its internal `deriveWorkerRuns(turn, …)` with `deriveWorkerRunsFromGroup(group)` when `turn.teamTurnId` is set; otherwise keep the legacy `deriveWorkerRuns`). The **Tools** section already renders `turn.toolCalls` — since each worker message now carries only its own tool calls, no change is needed there; it is automatically scoped. The `FilesTouched`/Files tab keep aggregating.

In `TeamRunFlow.tsx`, change `deriveWorkerRuns(turn, isStreaming)` (line 25) to prefer the group when available: accept an optional `group?: ChatMessage[]` prop and use `deriveWorkerRunsFromGroup(group)` when present.

- [ ] **Step 4: Build**

Run: `npx tsc -p codey-mac --noEmit`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/teamRunModel.ts codey-mac/src/components/teamRunModel.test.ts codey-mac/src/components/ChatContextPanel.tsx codey-mac/src/components/TeamRunFlow.tsx
git commit -m "feat(codey-mac): derive team flow + tools from per-worker message group"
```

---

## Phase 8 — Verification

### Task 16: Full suite + manual smoke

- [ ] **Step 1: Run every workspace test suite**

Run: `nvm use 22.17.1 && npm test`
Expected: all suites pass (`@codey/core`, `@codey/gateway`, `codey-mac`).

- [ ] **Step 2: Lint (non-English guard)**

Run: `npm run lint`
Expected: no new violations. (The `### Step`/emoji status strings already exist; do not introduce new non-English literals.)

- [ ] **Step 3: Manual smoke in the Mac app**

Run the app (see the `run` skill / project launch). For each mode, send a team prompt and verify:
- **auto / sequential / graph:** each worker appears as its own bubble inside one `Team: …` block, in order, with a running indicator on the active one; clicking a bubble opens the context panel scoped to that worker's tools/files only.
- **parallel:** all worker bubbles pre-appear and fill concurrently; tool/stream output lands in the correct bubble.
- **`[ASK_USER]` pause + resume:** the asking worker bubble shows, you reply, and subsequent workers append to the same block.
- **legacy chat:** open an older team chat persisted before this change — it still renders via the combined `TeamMessage` fallback.
- **channels:** confirm a linked Telegram/Discord chat still receives the combined transcript (unchanged).

- [ ] **Step 4: Final commit (if any smoke fixes)**

```bash
git add -A
git commit -m "fix(codey-mac): per-worker team rendering smoke fixes"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §1 event contract → Task 2; §2 ChatMessage fields → Task 1; §3 backend run path → Tasks 5-9; §4 resume → Task 10; §5 reducer → Tasks 11-12; §6 rendering → Tasks 13-14; §7 context panel/flow → Task 15; §8 keep file rows → no code (Tools list is already per-worker after Task 15).
- **Type consistency:** `WorkerMessageEmitter` method names (`teamStart`/`beginWorker`/`onStream`/`onThinking`/`onTool`/`endWorker`) are used identically in Tasks 4-10. Reducer action names (`teamStart`/`workerStart`/`workerEnd`) match between Tasks 11 and 12. `RenderItem`/`groupMessages` match between Tasks 13 and 14. `deriveWorkerRunsFromGroup` matches between Tasks 15 step 1 and step 3.
- **Known integration risk:** the exact line numbers in `gateway.ts` (a large file) may drift; always re-grep for the quoted code (`🔄 Worker`, `### Step`, `results.push(\`**${worker.name}**`) rather than trusting line numbers. The parallel `workerRunner` wiring (Task 8 step 1) is the least mechanical edit — read `parallel-team.ts` and the gateway parallel branch fully before editing.
