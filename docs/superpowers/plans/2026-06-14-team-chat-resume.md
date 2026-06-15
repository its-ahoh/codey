# Team Chat Resume (Emitter Abstraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mid-flow `[ASK_USER]` resume work on the chat / Mac-app surface for `sequential`, `auto`, and `graph` team modes, by routing team continuations through a `TeamEmitter` abstraction shared by the channel (`sendResponse`) and chat (`sink`) surfaces.

**Architecture:** Introduce `TeamEmitter` with `ChannelEmitter`/`ChatEmitter` implementations that mirror today's exact emit calls. Refactor the team continuation executors (`continueGraphRun`, `runAllMembersInOrder`, the auto resume tail) and `resumeTeamFromAnswer` to emit through a `TeamEmitter`, collapsing the duplicated void/sink graph + sequential executors into single emitter-parameterized ones with thin wrappers. Wire pending-team detection + assistant-message persistence into `sendToChat`.

**Tech Stack:** TypeScript (ES2020, CommonJS), Vitest, the Codey gateway (`packages/gateway`).

**Spec:** `docs/superpowers/specs/2026-06-14-team-chat-resume-design.md`

**Node note:** All `npm`/`vitest`/`tsc` commands require Node v22.17.1 — prefix with `source ~/.nvm/nvm.sh && nvm use 22.17.1 >/dev/null &&`. Gateway type-check: `cd packages/gateway && npx tsc -p . --noEmit`. Gateway tests: `cd packages/gateway && npx vitest run`. The core package is prebuilt to `dist/`; if you change core, run `npm run build -w @codey/core` first.

**Working directory:** `/Users/jackou/Documents/projects/codey/.worktrees/sequential-flow-graph` (branch `feat/sequential-flow-graph` — this builds directly on the flow-graph work).

---

## Background the implementer must know (read these regions first)

`packages/gateway/src/gateway.ts`:
- **`sendResponse`** (~3719): `const handler = this.handlers.get(response.channel); if (!handler) return;` — drops everything when no channel handler (the Mac/chat case). This is why channel-style resume is invisible on chat.
- **`resumeTeamFromAnswer`** (~2485): called only from `handleMessage` (~947). Builds a `runOneWorker` closure that streams via `handler?.streamText`, rehydrates anchors via `rehydrateWorkerAnchors(teamConv, pending.workerAnchors)` where `teamConv = this.workerConversationId(\`${message.channel}-${message.chatId}\`, { team })`, then switches on `pending.mode`: `'sequential'` (~2539, re-runs the asking worker with the answer injected, then `runAllMembersInOrder(... startIndex)`), `'graph'` (~2614, restores `GraphRunState` and calls `continueGraphRun`), `'auto'` (~2625, one `runAdvisor` turn + one worker). Every emit is `this.sendResponse(...)`.
- **`continueGraphRun`** (~2941, void) and **`runSequentialGraphForChat`**/**`runSequentialGraphForChatSink`** (the two graph fresh executors). The sink one duplicates the walk.
- **`runAllMembersInOrder`** (~2741, void) and **`runTeamForChat`**'s inline linear loop (~3293, sink) — duplicate sequential walks. `runTeamForChat` signature at ~3155.
- **`runOneWorker`** closures take `(workerName, prompt, codingAgent, modelConfig, blackboard, onThinking?)` and stream via either `handler.streamText` (void) or `sink` (chat).
- **`sendToChat`** (~3982): loads `chat`, appends the user message via `appendMessage(chatId, userMessage)` (~4106), runs the turn inside a `try` (team branch at `chat.selection.type === 'team'` ~4153 → `runTeamForChat`), and later builds + appends an `assistantMessage` (`role:'assistant'`) and emits `done`. The `sink` param is wrapped (~4007) to tee to `chatEventListener`.
- **`handleMessage`** pending handling (~900-950): captures `pending = chat.pendingTeam`, resolves a choice digit via `resolveChoiceDigit(text, options)` (~925), on slash clears pending + `renderCancelNotice`, else clears pending + `resumeTeamFromAnswer`. Imports: `renderCancelNotice` from `./team-pause` (line 18), `resolveChoiceDigit` from `./digit-mapping` (line 19).

---

## Task 1: `TeamEmitter` + `ChannelEmitter` + `ChatEmitter`

**Files:**
- Create: `packages/gateway/src/team-emitter.ts`
- Test: `packages/gateway/src/team-emitter.test.ts`

- [ ] **Step 1: Write the failing test** — Create `packages/gateway/src/team-emitter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ChannelEmitter, ChatEmitter } from './team-emitter';

describe('ChatEmitter', () => {
  it('accumulates notify text into the transcript and streams it', () => {
    const events: any[] = [];
    const e = new ChatEmitter((ev) => events.push(ev), 'c1');
    e.onStream('hello ');
    return e.notify('world').then(() => {
      expect(e.transcript).toContain('world');
      expect(events.some(v => v.type === 'stream' && v.token === 'world')).toBe(true);
    });
  });

  it('captures the latest choices from notify', async () => {
    const e = new ChatEmitter(() => {}, 'c1');
    await e.notify('pick one', ['a', 'b']);
    expect(e.choices).toEqual(['a', 'b']);
  });

  it('forwards thinking tokens to the sink', () => {
    const events: any[] = [];
    const e = new ChatEmitter((ev) => events.push(ev), 'c1');
    e.onThinking('pondering', 2);
    expect(events.some(v => v.type === 'thinking' && v.token === 'pondering' && v.step === 2)).toBe(true);
  });
});

describe('ChannelEmitter', () => {
  it('routes notify through the provided sendResponse and keeps transcript empty', async () => {
    const sent: any[] = [];
    const e = new ChannelEmitter(
      async (r) => { sent.push(r); },
      (text) => { sent.push({ stream: text }); },
      'c1', 'telegram' as any,
    );
    e.onStream('tok');
    await e.notify('done', ['x']);
    expect(sent).toContainEqual({ chatId: 'c1', channel: 'telegram', text: 'done', choices: ['x'] });
    expect(sent).toContainEqual({ stream: 'tok' });
    expect(e.transcript).toBe('');
  });
});
```

- [ ] **Step 2: Run it, confirm it FAILS** — `cd packages/gateway && npx vitest run src/team-emitter.test.ts` → module not found. (If vitest's config needs the file allowlisted, check `packages/gateway/vitest.config.ts`; if it globs `src/**/*.test.ts`, no change needed — confirm and adjust like the core package's allowlist if present.)

- [ ] **Step 3: Implement** — Create `packages/gateway/src/team-emitter.ts`:

```ts
import { ChannelType } from '@codey/core';

/** Surface-agnostic sink for team continuation output. */
export interface TeamEmitter {
  /** A discrete status / result / ASK_USER message to the user. */
  notify(text: string, choices?: string[]): Promise<void>;
  /** Per-worker streamed output token. */
  onStream(token: string): void;
  /** Per-worker streamed thinking token. */
  onThinking(token: string, step: number): void;
  /** Accumulated assistant transcript (chat surface); '' for channels. */
  readonly transcript: string;
  /** Latest choices passed to notify (for the chat return contract). */
  readonly choices: string[] | undefined;
}

type SinkLike = (ev: any) => void;

/** Emits to a chat sink and accumulates a transcript for persistence/return. */
export class ChatEmitter implements TeamEmitter {
  private parts: string[] = [];
  private _choices: string[] | undefined;
  constructor(private sink: SinkLike, private chatId: string) {}
  async notify(text: string, choices?: string[]): Promise<void> {
    this._choices = choices;
    this.parts.push(text);
    try { this.sink({ type: 'stream', chatId: this.chatId, token: text }); } catch { /* swallow */ }
  }
  onStream(token: string): void {
    this.parts.push(token);
    try { this.sink({ type: 'stream', chatId: this.chatId, token }); } catch { /* swallow */ }
  }
  onThinking(token: string, step: number): void {
    try { this.sink({ type: 'thinking', chatId: this.chatId, token, step }); } catch { /* swallow */ }
  }
  get transcript(): string { return this.parts.join('\n\n'); }
  get choices(): string[] | undefined { return this._choices; }
}

/** Emits to a channel via the gateway's sendResponse + handler.streamText. */
export class ChannelEmitter implements TeamEmitter {
  private _choices: string[] | undefined;
  constructor(
    private send: (r: { chatId: string; channel: ChannelType; text: string; choices?: string[] }) => Promise<void>,
    private streamText: ((text: string) => void) | undefined,
    private chatId: string,
    private channel: ChannelType,
  ) {}
  async notify(text: string, choices?: string[]): Promise<void> {
    this._choices = choices;
    await this.send({ chatId: this.chatId, channel: this.channel, text, choices });
  }
  onStream(token: string): void { this.streamText?.(token); }
  onThinking(_token: string, _step: number): void { /* channels don't render thinking today */ }
  get transcript(): string { return ''; }
  get choices(): string[] | undefined { return this._choices; }
}
```

(Confirm `ChannelType` is exported from `@codey/core`; it is imported in `gateway.ts:3`. If the sink event shapes differ from `{ type:'stream', chatId, token }` / `{ type:'thinking', chatId, token, step }`, match the real `ChatStreamSink` event union used elsewhere in `gateway.ts`.)

- [ ] **Step 4: Run the test, confirm PASS** (6 tests).
- [ ] **Step 5: Commit:**
```bash
git add packages/gateway/src/team-emitter.ts packages/gateway/src/team-emitter.test.ts
git commit -m "feat(gateway): TeamEmitter abstraction (channel + chat)"
```

---

## Task 2: Route `continueGraphRun` through the emitter; collapse the graph executors

**Files:** Modify `packages/gateway/src/gateway.ts`.

- [ ] **Step 1: Change `continueGraphRun` to take a `TeamEmitter`.** Replace its `message`-based signature with `(emitter: TeamEmitter, teamName, graph, task, state, blackboard, results, runOneWorker, resume?)`. Inside, replace every `await this.sendResponse({ chatId, channel, text })` with `await emitter.notify(text)`, and the ASK_USER pause's `sendResponse({ ..., text: rendered.text, choices: rendered.choices })` with `await emitter.notify(rendered.text, rendered.choices)`. The pause still calls `persistPendingTeam(chatId, { mode:'graph', ... })` — take `chatId` and `convBase` as params too (for `persistPendingTeam` and `snapshotWorkerAnchors(convBase)`), since the emitter doesn't carry them. Final signature:

```ts
private async continueGraphRun(
  emitter: TeamEmitter,
  chatId: string,
  convBase: string,
  teamName: string,
  graph: TeamGraph,
  task: string,
  state: GraphRunState,
  blackboard: TeamBlackboard,
  results: string[],
  runOneWorker: (workerName: string, prompt: string, codingAgent: CodingAgent, modelConfig: ModelConfig | undefined, blackboard: TeamBlackboard) => Promise<{ success: boolean; output: string; error?: string }>,
  resume?: { question: string; answer: string },
): Promise<string>
```

Return `emitter.transcript` at the end. The per-worker run should stream via the emitter: where `runOneWorker` is invoked, pass `(text) => emitter.onStream(text)` as its `onThinking`/stream hook as appropriate (match the existing call's optional args). The `teamConv` used for `snapshotWorkerAnchors` becomes `convBase`. Move the trailing capped/results emit to use `emitter.notify`.

- [ ] **Step 2: Make `runSequentialGraphForChat` (channel) a thin wrapper.** It builds a `ChannelEmitter` and delegates:

```ts
private async runSequentialGraphForChat(
  message: UserMessage, teamName: string, graph: TeamGraph, task: string,
  runOneWorker: (...same...) => Promise<{ success: boolean; output: string; error?: string }>,
): Promise<void> {
  const handler = this.handlers.get(message.channel);
  const emitter = new ChannelEmitter(
    (r) => this.sendResponse(r),
    handler?.streamText ? (t: string) => handler.streamText!(t) : undefined,
    message.chatId, message.channel,
  );
  const convBase = this.workerConversationId(`${message.channel}-${message.chatId}`, { team: teamName }).replace(/-team-.*/, '');
  // NOTE: pass the SAME base string the void path used for snapshotWorkerAnchors.
  const blackboard = new TeamBlackboard();
  const state = startRun(graph);
  if (state.status !== 'running') { await emitter.notify(`⚠️ Team **${teamName}** flow could not start (${state.status}).`); return; }
  await emitter.notify(`🧭 Running flow for team **${teamName}**\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`);
  await this.continueGraphRun(emitter, message.chatId, `${message.channel}-${message.chatId}`, teamName, graph, task, state, blackboard, [], runOneWorker);
}
```

IMPORTANT: `convBase` must be exactly the string previously passed to `workerConversationId(...)` BEFORE the `{ team }` suffix was applied — i.e. `${message.channel}-${message.chatId}`. `snapshotWorkerAnchors`/`rehydrateWorkerAnchors` expect the `workerConversationId(base, {team})` form, so inside `continueGraphRun` compute `const teamConv = this.workerConversationId(convBase, { team: teamName })` for the snapshot call (do NOT pre-resolve it). Remove the `.replace(...)` line above — just pass `convBase = \`${message.channel}-${message.chatId}\``. (The snippet's replace was illustrative; use the plain base.)

- [ ] **Step 3: Make `runSequentialGraphForChatSink` (chat) a thin wrapper and DELETE its duplicated walk.** Replace its body with:

```ts
private async runSequentialGraphForChatSink(
  teamName: string, graph: TeamGraph, prompt: string, sink: ChatStreamSink, chatId: string,
  runOneWorker: (...same...) => Promise<{ success: boolean; output: string; error?: string }>,
  _chatAgent?: CodingAgent, _chatModel?: ModelConfig, _signal?: AbortSignal,
): Promise<{ response: string; choices?: string[] }> {
  const emitter = new ChatEmitter(sink, chatId);
  const blackboard = new TeamBlackboard();
  const state = startRun(graph);
  if (state.status !== 'running') { await emitter.notify(`⚠️ Team **${teamName}** flow could not start (${state.status}).`); return { response: emitter.transcript }; }
  await emitter.notify(`Running flow for team ${teamName}`);
  await this.continueGraphRun(emitter, chatId, `chat-${chatId}`, teamName, graph, prompt, state, blackboard, [], runOneWorker);
  return { response: emitter.transcript, choices: emitter.choices };
}
```

Keep the existing call site (`runTeamForChat` ~3290) signature-compatible — if the old method passed `chatAgent`/`chatModel`/`signal`, keep accepting them (prefixed `_` if now unused, OR thread `signal` into `continueGraphRun` if you also add a `signal` param there; abort handling in the graph walk is optional and out of scope — keeping the existing behavior is fine).

- [ ] **Step 4: Update the void resume call site** in `resumeTeamFromAnswer`'s `'graph'` branch (~2621) — it will be rewritten in Task 4; for now make `continueGraphRun`'s new signature compile by updating that one call to pass `(emitter, chatId, convBase, teamName, graph, task, state, blackboard, results, runOneWorker, resume)`. Use a temporary `ChannelEmitter` there built from `message` (Task 4 replaces this with the param emitter).

- [ ] **Step 5: Type-check** — `cd packages/gateway && npx tsc -p . --noEmit` clean. Re-read `continueGraphRun` to confirm: loop still bounded, pause persists `mode:'graph'`, capped/results emit via `emitter.notify`, anchors snapshot under `workerConversationId(convBase,{team})`.

- [ ] **Step 6: Run gateway tests** — `npx vitest run` green.
- [ ] **Step 7: Commit:**
```bash
git add packages/gateway/src/gateway.ts
git commit -m "refactor(gateway): route continueGraphRun through TeamEmitter; collapse graph executors"
```

---

## Task 3: Route `runAllMembersInOrder` through the emitter; collapse the sequential chat loop

**Files:** Modify `packages/gateway/src/gateway.ts`.

- [ ] **Step 1: Add a `TeamEmitter` param to `runAllMembersInOrder`.** Change its signature so the first param is `emitter: TeamEmitter` and add `chatId`/`convBase` params (for the ASK_USER pause's `persistPendingTeam`/`snapshotWorkerAnchors`). Replace each `await this.sendResponse({ chatId, channel, text })` with `await emitter.notify(text)`; the ASK_USER pause's rendered question with `await emitter.notify(rendered.text, rendered.choices)`; and the per-worker `runOneWorker(...)` stream/thinking hook with `emitter.onStream`/`emitter.onThinking`. Return `emitter.transcript`. Keep the `opts` (startIndex/startCarry/priorResults/blackboard/conversationId) intact.

- [ ] **Step 2: Update the channel fresh + resume callers** of `runAllMembersInOrder` (in `runTeamTask` ~2454 and the `'sequential'` resume branch ~2603) to build a `ChannelEmitter` from `message` and pass `(emitter, message.chatId, \`${message.channel}-${message.chatId}\`, teamName, members, task, runOneWorker, opts)`. (The resume branch is finalized in Task 4; a temporary `ChannelEmitter` here keeps it compiling.)

- [ ] **Step 3: Replace `runTeamForChat`'s inline linear loop (~3293) with an emitter call.** Build a `ChatEmitter(sink, chatId)`, then `const r = await this.runAllMembersInOrder(emitter, chatId, \`chat-${chatId}\`, teamName, team.members, prompt, runOneWorker, {}); return { response: emitter.transcript, choices: emitter.choices, thinkingByStep: ... }`. Reconcile the return shape with `runTeamForChat`'s declared return type (`{ response, tokens?, choices?, thinkingByStep? }`). If the inline loop tracked `thinkingByStep`, have `runAllMembersInOrder` accept an optional out-param or return it; simplest: keep `runAllMembersInOrder` returning the transcript and let the chat wrapper read `emitter.transcript`, and drop per-step thinking aggregation if the void path didn't have it (the void `runAllMembersInOrder` is the source of truth for behavior — match it; if the chat path loses `thinkingByStep`, note it as an acceptable simplification consistent with the void executor).

- [ ] **Step 4: Type-check + tests** — `npx tsc -p . --noEmit` clean; `npx vitest run` green. Re-read to confirm the chat sequential fresh run still emits step labels and the ASK_USER pause persists `mode:'sequential'`.

- [ ] **Step 5: Commit:**
```bash
git add packages/gateway/src/gateway.ts
git commit -m "refactor(gateway): route runAllMembersInOrder through TeamEmitter; collapse sequential chat loop"
```

---

## Task 4: `resumeTeamFromAnswer` onto the emitter

**Files:** Modify `packages/gateway/src/gateway.ts`.

- [ ] **Step 1: Change the signature** to take an emitter + explicit ids instead of deriving emission/conv from `message`:

```ts
private async resumeTeamFromAnswer(
  chatId: string,
  convBase: string,          // `${channel}-${chatId}` for channels, `chat-${chatId}` for chat
  pending: PendingTeamState,
  answer: string,
  emitter: TeamEmitter,
): Promise<string>
```

- [ ] **Step 2: Rebuild the internal `runOneWorker`** so it streams via the emitter rather than `handler?.streamText`. Keep using `runWorkerStep`, `wrapPromptWithMemory(prompt, pending.task, workerName)`, `extractWorkerMemories`. The `teamConv` becomes `this.workerConversationId(convBase, { team: pending.teamName })`; `rehydrateWorkerAnchors(teamConv, pending.workerAnchors)` stays. Pass `onThinking: (t) => emitter.onThinking(t, /*step*/ 0)` (step is cosmetic on resume) and stream via `emitter.onStream`.

- [ ] **Step 3: Convert each branch's emits.** Replace every `this.sendResponse({ chatId: message.chatId, channel: message.channel, text, choices? })` with `await emitter.notify(text, choices?)`. For the `'sequential'` branch, after re-running the asking worker call `await this.runAllMembersInOrder(emitter, chatId, convBase, pending.teamName, team.members, pending.task, runOneWorker, { startIndex: pending.memberIndex + 1, startCarry: carryForNext, priorResults, blackboard, conversationId: teamConv })`. For `'graph'`, build the restored `state` and call `await this.continueGraphRun(emitter, chatId, convBase, pending.teamName, team.graph!, pending.task, state, blackboard, pending.results, runOneWorker, { question: pending.question, answer })`. For `'auto'`, convert its inline `sendResponse` emits to `emitter.notify` (no structural change). Return `emitter.transcript`.

- [ ] **Step 4: Update the `handleMessage` call site** (~947) to build a `ChannelEmitter` and pass the new args:

```ts
const handler = this.handlers.get(message.channel);
const emitter = new ChannelEmitter(
  (r) => this.sendResponse(r),
  handler?.streamText ? (t: string) => handler.streamText!(t) : undefined,
  message.chatId, message.channel,
);
await this.resumeTeamFromAnswer(message.chatId, `${message.channel}-${message.chatId}`, pending, message.text, emitter);
```

- [ ] **Step 5: Type-check + tests** — `npx tsc -p . --noEmit` clean; `npx vitest run` green. Confirm the channel resume path still emits via `sendResponse` (through `ChannelEmitter`).

- [ ] **Step 6: Commit:**
```bash
git add packages/gateway/src/gateway.ts
git commit -m "refactor(gateway): resumeTeamFromAnswer emits through TeamEmitter"
```

---

## Task 5: Wire chat resume into `sendToChat`

**Files:** Modify `packages/gateway/src/gateway.ts`.

- [ ] **Step 1: Capture pending + resolve choice BEFORE the user message is persisted.** In `sendToChat`, right after `const chat = this.chatManager.get(chatId); if (!chat) throw...` (~3995), add:

```ts
const pendingTeam = chat.pendingTeam;
const isSlashTurn = userText.trimStart().startsWith('/');
if (pendingTeam && !isSlashTurn) {
  const opts = pendingTeam.options;
  if (opts && opts.length > 0) {
    const resolved = resolveChoiceDigit(userText, opts);
    if (resolved !== null) userText = resolved;
  }
}
```
(Make `userText` reassignable — change its param usage to a local `let` if needed.)

- [ ] **Step 2: Branch into resume as the FIRST arm of the existing turn `if/else`.** Reuse the shared assistant-persist + `done` lifecycle (the block at ~4280-4314 builds `assistantMessage` from the local `output`/`teamThinkingByStep`, sets `surfacedChoices` from `teamChoices`, appends, and emits `done`). So you only need to set the locals `output` and `teamChoices` and let the rest run unchanged. The current shape is `if (chat.selection.type === 'team') { ... output = r.response; teamChoices = ...; } else { ...single agent... }`. Change it to:

```ts
if (pendingTeam && !isSlashTurn) {
  this.chatManager.setPendingTeam(chatId, null);
  const emitter = new ChatEmitter(sink, chatId);
  output = await this.resumeTeamFromAnswer(chatId, `chat-${chatId}`, pendingTeam, userText, emitter);
  teamChoices = emitter.choices;
} else if (chat.selection.type === 'team') {
  // ...existing team branch unchanged...
} else {
  // ...existing single-agent branch unchanged...
}
```

This way the resumed turn flows through the SAME teardown as a normal turn: the abort check (~4251), `surfacedChoices` from `teamChoices` (~4270), the `assistantMessage` persistence (~4280, `content: output`), the `done` event (~4314), and the semaphore release (wherever `sendToChat` already does it). Do NOT add manual teardown/persistence/release. When `resumeTeamFromAnswer` re-pauses (worker asked again), it calls `persistPendingTeam(chatId, ...)`, so `chat.pendingTeam` is set again and `emitter.choices` carries the new question's choices into `teamChoices` → surfaced by the existing `done` path. Verify `output`, `teamChoices`, and `teamThinkingByStep` are the actual local names at ~4147-4150 (they are) and that this `if` sits before/around the existing `chat.selection.type === 'team'` check (~4153).

- [ ] **Step 3: Handle the slash-while-paused case.** Before Step 2's branch (or as part of Step 1), if `pendingTeam && isSlashTurn`, clear pending so the turn proceeds normally: `this.chatManager.setPendingTeam(chatId, null);` (optionally `sink({ type:'info', chatId, message: renderCancelNotice(pendingTeam) });`). Then the normal single-agent/team handling runs as usual.

- [ ] **Step 4: Type-check + tests** — `npx tsc -p . --noEmit` clean; `npx vitest run` green.

- [ ] **Step 5: Add a focused resume test.** In `packages/gateway/src/team-emitter.test.ts` (or a new `src/team-resume.test.ts`, allowlisted if needed), add a test that drives `resumeTeamFromAnswer` for `mode:'graph'` over a `ChatEmitter` with a stubbed team/graph + stubbed worker/judge runners, asserting the returned transcript is non-empty and that a re-pause surfaces `emitter.choices`. If wiring a full gateway instance is too heavy, assert at the `ChatEmitter` level that a scripted sequence of `notify`/`onStream` calls produces the expected transcript (the executor↔emitter contract). Keep it black-box and deterministic.

- [ ] **Step 6: Commit:**
```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/team-emitter.test.ts
git commit -m "feat(gateway): resume paused team flows on the chat/Mac path"
```

---

## Task 6: Full sweep + docs + manual verification

**Files:** verification + `CLAUDE.md`.

- [ ] **Step 1: Build + all suites** —
```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 >/dev/null
npm run build -w @codey/core && npm run build -w @codey/gateway
(cd packages/core && npx vitest run)
(cd packages/gateway && npx vitest run && npx tsc -p . --noEmit)
(cd codey-mac && npx vitest run && npx tsc -p tsconfig.json --noEmit)
```
Expected: all green, all type-checks clean.

- [ ] **Step 2: Update `CLAUDE.md`.** Replace the flow-graph bullet's resume caveat (added by the prior feature) so it states resume now works on the chat/Mac surface too. New wording for the `[ASK_USER]` clause: "Workers can pause mid-flow with `[ASK_USER]`; pause state is persisted and resumed on both the channel (`handleMessage`) and chat/Mac (`sendToChat`) surfaces via the shared `TeamEmitter` continuation path." Confirm no other doc still claims resume is channel-only.

- [ ] **Step 3: Manual smoke (record results in the PR).** In the Mac app: create a Sequential team with a flow where a worker emits `[ASK_USER:choice]`. Run it, confirm the question appears with tappable choices, answer it, confirm the flow resumes in place and the assistant message persists after a chat reload. Repeat for a plain `sequential` team and an `auto` team that pauses.

- [ ] **Step 4: Commit:**
```bash
git add CLAUDE.md
git commit -m "docs: team chat resume now works on the Mac/chat surface"
```

---

## Self-Review Notes

- **Spec coverage:** `TeamEmitter` + impls → Task 1; graph collapse + emitter → Task 2; sequential collapse + emitter → Task 3; `resumeTeamFromAnswer` emitter + channel call site → Task 4; `sendToChat` pending detection + assistant persistence → Task 5; sweep/docs/manual → Task 6. Auto resume converted in Task 4 (the auto *fresh-run* void/sink duplication is pre-existing and NOT required for the resume goal — deliberately left as-is to bound risk; noted here so it isn't mistaken for a gap).
- **Behavior preservation:** every emitter call mirrors the exact prior `sendResponse`/`sink` call; the void executors are the behavioral source of truth when collapsing.
- **Conversation-id consistency:** `convBase` is `${channel}-${chatId}` for channels and `chat-${chatId}` for chat, matching the fresh-run keys so `snapshot`/`rehydrateWorkerAnchors` line up across pause→resume on each surface. This is the load-bearing invariant — verify it in Tasks 2-5.
- **Type consistency:** `continueGraphRun(emitter, chatId, convBase, teamName, graph, task, state, blackboard, results, runOneWorker, resume?)` and `runAllMembersInOrder(emitter, chatId, convBase, teamName, members, task, runOneWorker, opts?)` and `resumeTeamFromAnswer(chatId, convBase, pending, answer, emitter)` are used identically across all call sites in Tasks 2-5.
- **Known integration unknowns to reconcile against real code (named, not invented):** `sendToChat`'s exact teardown (`finally` vs manual release), the real `assistantMessage` field shape (~4250), the `ChatStreamSink` event union, and whether `runTeamForChat` tracked `thinkingByStep` in its linear loop. Each step says to match the real code.
