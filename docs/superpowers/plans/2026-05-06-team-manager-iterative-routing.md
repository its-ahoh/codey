# Team Manager Iterative Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot `runDispatcher` with an iterative `runManager` that picks the next worker per turn, supports loop-back for revisions, and emits per-step instructions plus a final summary.

**Architecture:** A new `manager.ts` module exposes a per-turn contract: each call takes `{ task, members, history, lastWorker, lastOutput, finalize? }` and returns `{ summary_of_last, next, instruction, reason, done, final_summary?, fallback, fallbackReason? }`. The gateway loops up to `clamp(2*members.length, 4, 12)` times, calling the Manager between each worker run. On any Manager failure, the gateway falls back to the legacy "run all members in input order" path. Output is rendered chronologically with a leading `🧭 Manager summary` block and `(revision)` markers on repeat workers.

**Tech Stack:** TypeScript (ES2020/CommonJS), Node `assert`, `ts-node` test runner (no formal test framework — matches `packages/core/src/context.test.ts`).

**Spec:** `docs/superpowers/specs/2026-05-06-team-manager-iterative-routing-design.md`

---

## File Structure

**Created:**
- `packages/core/src/manager.ts` — replaces `dispatcher.ts`. Exports `runManager`, `buildManagerPrompt`, `extractJsonObject` (re-located), and the new types.
- `packages/core/src/manager-personality.ts` — replaces `dispatcher-personality.ts`. New iterative-orchestrator prompt.
- `packages/core/src/manager.test.ts` — unit tests using `assert` + `ts-node` pattern.

**Modified:**
- `packages/core/src/index.ts` — swap `dispatcher` exports for `manager`.
- `packages/gateway/src/gateway.ts` — rewrite the team execution bodies in `runTeamTask` (~line 1317) and `runTeamForChat` (~line 1434); update `/help` strings.

**Deleted:**
- `packages/core/src/dispatcher.ts`
- `packages/core/src/dispatcher-personality.ts`

---

## Task 1: Create `manager-personality.ts` with the iterative-orchestrator prompt

**Files:**
- Create: `packages/core/src/manager-personality.ts`

- [ ] **Step 1: Create `packages/core/src/manager-personality.ts`**

```ts
/**
 * Built-in personality used when running the iterative team Manager.
 * Not user-editable. The Manager is a routing role; it does not write code.
 */
export const MANAGER_PERSONALITY = {
  role: 'Iterative team manager that decides which worker should run next, when to loop back for revisions, and when the task is done.',
  instructions: [
    'You manage a small team of specialized workers running one at a time.',
    'On each turn you receive:',
    '- TASK: the original user task.',
    '- ROSTER: the workers available, each with a one-line hint. You may ONLY pick names from this roster.',
    '- HISTORY: an ordered list of prior steps as {worker, summary}, oldest first. Empty on the first turn.',
    '- LAST OUTPUT: the full output of the most recently run worker, or null on the first turn.',
    '- FINALIZE: when true, return only `done: true` with a `final_summary` of the whole run; do not pick a next worker.',
    '',
    'Your job each turn:',
    '1. Summarize LAST OUTPUT in one to three sentences (`summary_of_last`). Use "" on the first turn.',
    '2. Decide whether the task is satisfied.',
    '   - If yes: set `done: true`, `next: null`, `instruction: ""`, and write `final_summary` describing what the team produced.',
    '   - If no: pick the worker most likely to advance the task next from the ROSTER, set `done: false`.',
    '3. When picking a worker, looping back to a worker who already ran is ENCOURAGED when their earlier output should be revised based on later findings. Cite what to change in `instruction`.',
    '4. Write a concrete `instruction` for the next worker (e.g. "tighten the data model based on reviewer feedback about idempotency"). Required when `next` is non-null; "" otherwise.',
    '5. Provide one short sentence in `reason` explaining why this routing choice is right; this is shown to the user.',
    '',
    'Rules:',
    '- Never invent worker names; only use names from ROSTER.',
    '- When unsure whether the task is done, prefer routing to a reviewer or looping back over declaring done.',
    '- Output JSON ONLY. No prose. No markdown fences.',
    '',
    'Output schema:',
    '{"summary_of_last": "<string>", "next": "<worker name or null>", "instruction": "<string>", "reason": "<one short sentence>", "done": <boolean>, "final_summary": "<string, only when done is true>"}',
  ].join('\n'),
};
```

- [ ] **Step 2: Verify it builds**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/manager-personality.ts
git commit -m "feat(core): add Manager personality for iterative team routing"
```

---

## Task 2: Write failing tests for `runManager`

**Files:**
- Create: `packages/core/src/manager.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// Run: npx ts-node packages/core/src/manager.test.ts
import * as assert from 'assert';
import { runManager, ManagerInput, ManagerTurn, ManagerRunner } from './manager';
import { AgentRequest, AgentResponse } from './types';

function makeRunner(replies: string[]): ManagerRunner {
  let i = 0;
  return async (_req: AgentRequest): Promise<AgentResponse> => {
    const output = replies[Math.min(i, replies.length - 1)];
    i++;
    return { success: true, output, agent: 'claude-code' } as AgentResponse;
  };
}

function failingRunner(error: string): ManagerRunner {
  return async () => ({ success: false, output: '', error, agent: 'claude-code' } as AgentResponse);
}

const baseInput: ManagerInput = {
  task: 'Audit and improve the auth flow',
  members: [
    { name: 'architect', hint: 'Designs systems' },
    { name: 'reviewer', hint: 'Critiques designs' },
  ],
  history: [],
  lastWorker: null,
  lastOutput: null,
};

async function testFirstTurnPicksWorker() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: 'architect',
    instruction: 'Draft the auth flow',
    reason: 'Architect should start',
    done: false,
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, false, 'should not fallback on valid response');
  assert.strictEqual(turn.next, 'architect');
  assert.strictEqual(turn.done, false);
  assert.strictEqual(turn.instruction, 'Draft the auth flow');
  assert.strictEqual(turn.summary_of_last, '');
}

async function testMidRunWithHistory() {
  const input: ManagerInput = {
    ...baseInput,
    history: [{ worker: 'architect', summary: 'Drafted v1 of auth flow' }],
    lastWorker: 'architect',
    lastOutput: 'Here is the v1 draft of the auth flow...',
  };
  const runner = makeRunner([JSON.stringify({
    summary_of_last: 'Architect drafted v1.',
    next: 'reviewer',
    instruction: 'Critique v1',
    reason: 'Need a review pass',
    done: false,
  })]);
  const turn = await runManager(input, { agent: 'claude-code', runner });
  assert.strictEqual(turn.next, 'reviewer');
  assert.strictEqual(turn.summary_of_last, 'Architect drafted v1.');
  assert.strictEqual(turn.done, false);
}

async function testDoneTermination() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: 'Reviewer signed off.',
    next: null,
    instruction: '',
    reason: 'Task complete',
    done: true,
    final_summary: 'Architect drafted, reviewer approved.',
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.done, true);
  assert.strictEqual(turn.next, null);
  assert.strictEqual(turn.final_summary, 'Architect drafted, reviewer approved.');
}

async function testFinalizeMode() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: null,
    instruction: '',
    reason: 'cap reached',
    done: true,
    final_summary: 'Final wrap-up.',
  })]);
  const turn = await runManager({ ...baseInput, finalize: true }, { agent: 'claude-code', runner });
  assert.strictEqual(turn.done, true);
  assert.strictEqual(turn.final_summary, 'Final wrap-up.');
}

async function testUnknownWorkerFallsBack() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: 'designer', // not in roster
    instruction: 'do design',
    reason: 'r',
    done: false,
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, true, 'unknown worker should fallback');
}

async function testMalformedJsonFallsBack() {
  const runner = makeRunner(['not json at all']);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, true);
  assert.ok(turn.fallbackReason && turn.fallbackReason.length > 0);
}

async function testRunnerErrorFallsBack() {
  const turn = await runManager(baseInput, {
    agent: 'claude-code',
    runner: failingRunner('boom'),
  });
  assert.strictEqual(turn.fallback, true);
  assert.ok(turn.fallbackReason!.includes('boom'));
}

async function testEmptyMembersReturnsDone() {
  const turn = await runManager(
    { ...baseInput, members: [] },
    { agent: 'claude-code', runner: makeRunner(['{}']) },
  );
  assert.strictEqual(turn.done, true);
  assert.strictEqual(turn.next, null);
  assert.strictEqual(turn.fallback, false);
}

async function testNullNextWithoutDoneFallsBack() {
  // Manager returned next:null but done:false — invalid, should fallback.
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: null,
    instruction: '',
    reason: 'r',
    done: false,
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, true);
}

async function run() {
  await testFirstTurnPicksWorker();
  await testMidRunWithHistory();
  await testDoneTermination();
  await testFinalizeMode();
  await testUnknownWorkerFallsBack();
  await testMalformedJsonFallsBack();
  await testRunnerErrorFallsBack();
  await testEmptyMembersReturnsDone();
  await testNullNextWithoutDoneFallsBack();
  console.log('manager.test.ts: all tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the tests to verify they fail (module does not yet exist)**

Run: `npx ts-node packages/core/src/manager.test.ts`
Expected: FAIL with `Cannot find module './manager'` or similar.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/manager.test.ts
git commit -m "test(core): failing tests for iterative runManager"
```

---

## Task 3: Implement `manager.ts`

**Files:**
- Create: `packages/core/src/manager.ts`

- [ ] **Step 1: Create the module**

```ts
import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { MANAGER_PERSONALITY } from './manager-personality';

export interface ManagerMember {
  name: string;
  hint: string;
}

export interface ManagerHistoryEntry {
  worker: string;
  summary: string;
}

export interface ManagerInput {
  task: string;
  members: ManagerMember[];
  history: ManagerHistoryEntry[];
  lastWorker: string | null;
  lastOutput: string | null;
  /** When true, return only done:true with a final_summary; do not pick next. */
  finalize?: boolean;
}

export interface ManagerTurn {
  summary_of_last: string;
  next: string | null;
  instruction: string;
  reason: string;
  done: boolean;
  final_summary?: string;
  fallback: boolean;
  fallbackReason?: string;
}

export type ManagerRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface ManagerOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: ManagerRunner;
  /** Hard timeout in ms. Default 30_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildManagerPrompt(input: ManagerInput): string {
  const lines: string[] = [];
  lines.push('# Manager');
  lines.push('## Role');
  lines.push(MANAGER_PERSONALITY.role);
  lines.push('## Instructions');
  lines.push(MANAGER_PERSONALITY.instructions);
  lines.push('## Task');
  lines.push(input.task);
  lines.push('## Roster');
  for (const m of input.members) {
    lines.push(`- ${m.name}: ${m.hint || '(no description)'}`);
  }
  lines.push('## History');
  if (input.history.length === 0) {
    lines.push('(empty — this is the first turn)');
  } else {
    input.history.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.worker}: ${h.summary}`);
    });
  }
  lines.push('## Last Output');
  if (input.lastWorker && input.lastOutput) {
    lines.push(`Worker: ${input.lastWorker}`);
    lines.push('Output:');
    lines.push(input.lastOutput);
  } else {
    lines.push('(none — first turn)');
  }
  if (input.finalize) {
    lines.push('## Finalize');
    lines.push('FINALIZE=true. Return only done:true with a final_summary; do not pick a next worker.');
  }
  return lines.join('\n\n');
}

/**
 * Extract the first balanced {...} object from a string and JSON.parse it.
 * Tolerates leading/trailing prose, markdown fences, and nested objects.
 */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

function fallback(reason: string): ManagerTurn {
  return {
    summary_of_last: '',
    next: null,
    instruction: '',
    reason: '',
    done: false,
    fallback: true,
    fallbackReason: reason,
  };
}

export async function runManager(
  input: ManagerInput,
  opts: ManagerOptions,
): Promise<ManagerTurn> {
  if (input.members.length === 0) {
    return {
      summary_of_last: '',
      next: null,
      instruction: '',
      reason: '',
      done: true,
      final_summary: '',
      fallback: false,
    };
  }

  const prompt = buildManagerPrompt(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: AgentResponse;
  try {
    response = await opts.runner({
      prompt,
      agent: opts.agent,
      model: opts.model,
      signal: ac.signal,
    });
  } catch (err) {
    return fallback(`runner threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort);
  }

  if (!response.success) {
    return fallback(response.error || 'runner returned non-success');
  }

  const obj = extractJsonObject(response.output) as
    | {
        summary_of_last?: unknown;
        next?: unknown;
        instruction?: unknown;
        reason?: unknown;
        done?: unknown;
        final_summary?: unknown;
      }
    | null;
  if (!obj) return fallback('no JSON object in manager output');

  const summary_of_last = typeof obj.summary_of_last === 'string' ? obj.summary_of_last : '';
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  const instruction = typeof obj.instruction === 'string' ? obj.instruction : '';
  const done = obj.done === true;
  const final_summary = typeof obj.final_summary === 'string' ? obj.final_summary : undefined;

  let next: string | null = null;
  if (obj.next === null || obj.next === undefined) {
    next = null;
  } else if (typeof obj.next === 'string' && obj.next.trim().length > 0) {
    next = obj.next.trim();
  } else {
    return fallback('next is not a string or null');
  }

  if (next !== null) {
    const known = new Set(input.members.map(m => m.name));
    if (!known.has(next)) return fallback(`next "${next}" is not in roster`);
  }

  if (input.finalize) {
    return {
      summary_of_last,
      next: null,
      instruction: '',
      reason,
      done: true,
      final_summary: final_summary ?? '',
      fallback: false,
    };
  }

  if (!done && next === null) {
    return fallback('next is null but done is false');
  }

  if (done && next !== null) {
    // Treat done:true as authoritative; ignore next.
    return {
      summary_of_last,
      next: null,
      instruction: '',
      reason,
      done: true,
      final_summary: final_summary ?? '',
      fallback: false,
    };
  }

  return {
    summary_of_last,
    next,
    instruction: next !== null ? instruction : '',
    reason,
    done,
    final_summary,
    fallback: false,
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx ts-node packages/core/src/manager.test.ts`
Expected: `manager.test.ts: all tests passed`

- [ ] **Step 3: Verify TypeScript build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/manager.ts
git commit -m "feat(core): implement iterative runManager with per-turn contract"
```

---

## Task 4: Update core exports and remove legacy dispatcher

**Files:**
- Modify: `packages/core/src/index.ts`
- Delete: `packages/core/src/dispatcher.ts`, `packages/core/src/dispatcher-personality.ts`

- [ ] **Step 1: Update `packages/core/src/index.ts`**

Replace the two dispatcher export lines with manager equivalents.

```ts
// Before:
export * from './dispatcher';
export * from './dispatcher-personality';

// After:
export * from './manager';
export * from './manager-personality';
```

- [ ] **Step 2: Delete the legacy files**

```bash
git rm packages/core/src/dispatcher.ts packages/core/src/dispatcher-personality.ts
```

- [ ] **Step 3: Verify nothing else imports them**

Run: `grep -rn "from.*dispatcher\|require.*dispatcher\|DISPATCHER_PERSONALITY\|runDispatcher\|DispatchResult\|DispatchInput\|DispatcherRunner\|DispatcherOptions\|DispatchMember" packages/ --include="*.ts" | grep -v dist`
Expected: matches only inside `packages/gateway/src/gateway.ts`. No matches from `packages/core/`.

(Gateway is rewritten in Task 5; transient breakage between Task 4 and Task 5 commits is acceptable for a single-developer workflow.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "refactor(core): swap dispatcher exports for manager"
```

---

## Task 5: Rewrite gateway team execution to use the iterative Manager loop

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (import line, `runTeamTask` ~line 1317, `runTeamForChat` ~line 1434, `/help` strings around lines 813–814 and 1157–1158)

- [ ] **Step 1: Update imports**

In `packages/gateway/src/gateway.ts`, replace:

```ts
import { AgentRequest, AgentResponse, FallbackEntry, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig, ChannelType, ChannelConfig, ChatMessage, ToolCallEntry, runDispatcher, DispatchResult } from '@codey/core';
```

with:

```ts
import { AgentRequest, AgentResponse, FallbackEntry, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig, ChannelType, ChannelConfig, ChatMessage, ToolCallEntry, runManager, ManagerTurn, ManagerHistoryEntry } from '@codey/core';
```

If a class member is currently named `dispatcherRunner` (used in the existing `runDispatcher` calls), keep the name as-is — it is still the same `ManagerRunner` shape. Renaming is out of scope.

- [ ] **Step 2: Add a private helper `runManagerLoop` near the existing team helpers**

Add this method to the `Gateway` class (placement: just above `runTeamTask`):

```ts
/**
 * Iteratively drives the team Manager. Returns the chronological run result
 * or `{ fallback: true }` when the Manager fails on turn 1 — caller should
 * fall back to running all members in input order.
 *
 * Mid-run Manager failures (turn 2+) end the loop gracefully: the parts
 * collected so far are returned with `fallbackMidRun: true` so the caller
 * can annotate the user-visible header.
 */
private async runManagerLoop(
  team: { members: string[] },
  task: string,
  workingDir: string,
  signal: AbortSignal | undefined,
  chatAgent: CodingAgent | undefined,
  chatModel: ModelConfig | undefined,
  perStep: (msg: { kind: 'route'; step: number; worker: string; reason: string; isRevision: boolean }) => void,
  runWorker: (worker: string, prompt: string, codingAgent: CodingAgent, modelConfig: ModelConfig | undefined) => Promise<{ success: boolean; output: string; error?: string }>,
): Promise<
  | { fallback: true; fallbackReason: string }
  | {
      fallback: false;
      parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
      finalSummary: string;
      fallbackMidRun?: { reason: string };
    }
> {
  const workerManager = this.workspaceManager.getWorkerManager();
  const members = team.members;
  const cap = Math.max(Math.min(2 * members.length, 12), 4);

  const history: ManagerHistoryEntry[] = [];
  let lastWorker: string | null = null;
  let lastOutput: string | null = null;
  const parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }> = [];
  let finalSummary = '';
  let fallbackMidRun: { reason: string } | undefined;

  const { agent: mAgent, model: mModel } = this.getDispatcherAgentAndModel();
  const seenWorkers = new Set<string>();

  for (let step = 1; step <= cap; step++) {
    if (signal?.aborted) break;
    const turn = await runManager(
      {
        task,
        members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
        history,
        lastWorker,
        lastOutput,
      },
      { agent: mAgent, model: mModel, runner: this.dispatcherRunner, signal },
    );
    if (turn.fallback) {
      if (parts.length === 0) {
        return { fallback: true, fallbackReason: turn.fallbackReason ?? 'unknown' };
      }
      fallbackMidRun = { reason: turn.fallbackReason ?? 'unknown' };
      break;
    }
    if (lastWorker && turn.summary_of_last) {
      history.push({ worker: lastWorker, summary: turn.summary_of_last });
    }
    if (turn.done || !turn.next) {
      finalSummary = turn.final_summary ?? '';
      break;
    }
    const isRevision = seenWorkers.has(turn.next);
    perStep({ kind: 'route', step, worker: turn.next, reason: turn.reason, isRevision });

    const codingAgent = (workerManager.getWorkerCodingAgent(turn.next) ?? chatAgent ?? this.getDefaultAgent()) as CodingAgent;
    const workerModelName = workerManager.getWorkerModel(turn.next);
    const modelConfig = workerModelName
      ? this.getModelConfig(codingAgent, workerModelName)
      : chatModel ?? this.getDefaultModelConfig(codingAgent);

    const stepTaskBody = this.composeStepTask(task, turn.instruction, lastWorker, lastOutput);
    const prompt = workerManager.buildWorkerPrompt(turn.next, stepTaskBody);

    const response = await runWorker(turn.next, prompt, codingAgent, modelConfig);
    if (!response.success) {
      fallbackMidRun = { reason: `worker ${turn.next} failed: ${response.error ?? 'unknown'}` };
      break;
    }
    parts.push({ step, worker: turn.next, output: response.output, isRevision });
    seenWorkers.add(turn.next);
    lastWorker = turn.next;
    lastOutput = response.output;
  }

  // Cap exhausted without explicit done — request a final summary.
  if (!finalSummary && parts.length > 0 && !fallbackMidRun) {
    const closing = await runManager(
      {
        task,
        members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
        history,
        lastWorker,
        lastOutput,
        finalize: true,
      },
      { agent: mAgent, model: mModel, runner: this.dispatcherRunner, signal },
    );
    if (!closing.fallback) finalSummary = closing.final_summary ?? '';
  }

  return { fallback: false, parts, finalSummary, fallbackMidRun };
}

private composeStepTask(
  originalTask: string,
  instruction: string,
  lastWorker: string | null,
  lastOutput: string | null,
): string {
  const sections: string[] = [];
  if (instruction.trim()) sections.push(instruction.trim());
  sections.push(`Original task: ${originalTask}`);
  if (lastWorker && lastOutput) {
    sections.push(`Previous worker (${lastWorker}) output:\n${lastOutput}`);
  }
  return sections.join('\n\n');
}

private formatManagerParts(
  parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>,
  finalSummary: string,
  truncatePerStep?: number,
): string {
  const head = finalSummary ? `🧭 Manager summary: ${finalSummary}\n\n` : '';
  const body = parts
    .map(p => {
      const label = p.isRevision ? `${p.worker} (revision)` : p.worker;
      const out = truncatePerStep ? p.output.substring(0, truncatePerStep) : p.output;
      return `### Step ${p.step}: ${label}\n\n${out}`;
    })
    .join('\n\n---\n\n');
  return head + body;
}
```

- [ ] **Step 3: Rewrite `runTeamTask` body (chat-bridge path)**

Replace the current dispatcher + sequential loop in `runTeamTask` (gateway.ts ~lines 1317–1432) with the Manager loop. The new method body:

```ts
private async runTeamTask(
  message: UserMessage,
  teamName: string,
  task: string,
  opts: { forceAll?: boolean } = {},
): Promise<void> {
  const { chatId, channel } = message;

  if (!teamName || !task.trim()) {
    const teamList = this.workspaceManager.listTeams();
    await this.sendResponse({
      chatId,
      channel,
      text: `Usage: /team <name> [--all] <task>\n\nTeams on this workspace:\n${teamList}`,
    });
    return;
  }

  const team = this.workspaceManager.getTeam(teamName);
  if (!team) {
    const teamList = this.workspaceManager.listTeams();
    await this.sendResponse({
      chatId,
      channel,
      text: `Team "${teamName}" not found on workspace "${this.workspaceManager.getCurrentWorkspace()}".\n\nAvailable teams:\n${teamList}`,
    });
    return;
  }

  const workerManager = this.workspaceManager.getWorkerManager();
  const handler = this.handlers.get(channel);
  const { members, dispatch } = team;

  // Helper to run one worker once, used by both the Manager loop and the
  // legacy "all members in input order" fallback.
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

  const useManager = dispatch === 'auto' && !opts.forceAll;

  if (useManager) {
    await this.sendResponse({
      chatId,
      channel,
      text: `🧭 Manager running team **${teamName}**\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    const result = await this.runManagerLoop(
      team,
      task,
      this.workingDir,
      undefined,
      undefined,
      undefined,
      async ({ step, worker, reason, isRevision }) => {
        await this.sendResponse({
          chatId,
          channel,
          text: `🔄 Step ${step}: **${worker}**${isRevision ? ' (revision)' : ''} — ${reason}`,
        });
      },
      runOneWorker,
    );

    if (result.fallback) {
      await this.sendResponse({
        chatId,
        channel,
        text: `⚠️ Auto-routing failed (${result.fallbackReason}), running all members.`,
      });
      await this.runAllMembersInOrder(message, teamName, members, task, runOneWorker);
      return;
    }

    if (result.fallbackMidRun) {
      await this.sendResponse({
        chatId,
        channel,
        text: `⚠️ Manager halted mid-run: ${result.fallbackMidRun.reason}`,
      });
    }

    const text = this.formatManagerParts(result.parts, result.finalSummary, /*truncatePerStep*/ 500);
    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Team **${teamName}** results\n\n${text}`,
    });
    return;
  }

  // dispatch === 'all' OR forceAll: legacy path
  const headerSuffix = opts.forceAll ? ' [--all override]' : '';
  await this.sendResponse({
    chatId,
    channel,
    text: `👥 Running team **${teamName}** (${members.join(' → ')})${headerSuffix}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
  });
  await this.runAllMembersInOrder(message, teamName, members, task, runOneWorker);
}

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
): Promise<void> {
  const { chatId, channel } = message;
  const workerManager = this.workspaceManager.getWorkerManager();
  const results: string[] = [];
  let currentTask = task;

  for (const memberName of members) {
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
    if (response.success) {
      results.push(`**${worker.name}**: ${response.output.substring(0, 500)}`);
      currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
    } else {
      results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
      break;
    }
  }

  await this.sendResponse({
    chatId,
    channel,
    text: `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`,
  });
}
```

- [ ] **Step 4: Rewrite `runTeamForChat` body (TUI path)**

Replace the dispatcher + sequential loop in `runTeamForChat` (gateway.ts ~lines 1434–1495) with:

```ts
private async runTeamForChat(
  teamName: string,
  team: { members: string[]; dispatch: 'all' | 'auto' },
  prompt: string,
  workingDir: string,
  sink: ChatStreamSink,
  chatId: string,
  signal?: AbortSignal,
  opts: { forceAll?: boolean } = {},
  chatAgent?: CodingAgent,
  chatModel?: ModelConfig,
): Promise<{ response: string; tokens?: number }> {
  if (!team || !team.members || team.members.length === 0) {
    throw new Error(`Team not found or empty: ${teamName}`);
  }
  const workerManager = this.workspaceManager.getWorkerManager();

  const runOneWorker = async (
    workerName: string,
    workerPrompt: string,
    codingAgent: CodingAgent,
    modelConfig: ModelConfig | undefined,
  ): Promise<{ success: boolean; output: string; error?: string }> => {
    const response = await this.runWithFallback(codingAgent, {
      prompt: workerPrompt,
      agent: codingAgent,
      model: modelConfig,
      context: { workingDir },
      onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
      onStatus: (_update: any) => { /* status forwarded via sink elsewhere */ },
      signal,
    });
    return response?.success
      ? { success: true, output: this.formatAgentResponse(response) }
      : { success: false, output: '', error: response?.error };
  };

  const useManager = team.dispatch === 'auto' && !opts.forceAll;

  if (useManager) {
    const result = await this.runManagerLoop(
      team,
      prompt,
      workingDir,
      signal,
      chatAgent,
      chatModel,
      ({ step, worker, reason, isRevision }) => {
        sink({
          type: 'info',
          chatId,
          message: `Step ${step}: ${worker}${isRevision ? ' (revision)' : ''} — ${reason}`,
        });
      },
      runOneWorker,
    );

    if (result.fallback) {
      sink({ type: 'info', chatId, message: `Auto-routing failed (${result.fallbackReason}), running all members` });
      // fall through to all-members path below
    } else {
      if (result.fallbackMidRun) {
        sink({ type: 'info', chatId, message: `Manager halted mid-run: ${result.fallbackMidRun.reason}` });
      }
      return { response: this.formatManagerParts(result.parts, result.finalSummary) };
    }
  }

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
    const output = response.success ? response.output : '';
    parts.push(`### ${memberName}\n\n${output}`);
    carry = output;
    if (!response.success) break;
  }
  return { response: parts.join('\n\n---\n\n') };
}
```

- [ ] **Step 5: Update `/help` strings**

In `gateway.ts` around lines 813–814 and 1157–1158, update the auto-dispatch wording:

Old:
```
- /team <name> [--all] <task> — run a named team. Use --all to bypass auto-dispatch when team mode is "auto".
```

New:
```
- /team <name> [--all] <task> — run a named team. With dispatch:auto the Manager iteratively picks workers and may loop back for revisions; --all bypasses the Manager and runs every member in declared order.
```

Apply the same wording change to the second `/help` block.

- [ ] **Step 6: Build the gateway package**

Run: `npm run build`
Expected: clean TypeScript build, no errors.

- [ ] **Step 7: Re-run core tests**

Run: `npx ts-node packages/core/src/manager.test.ts`
Expected: `manager.test.ts: all tests passed`

- [ ] **Step 8: Manual smoke test**

In a workspace with a 3-worker team configured `dispatch: 'auto'`:

```
/team <teamname> Audit and improve the auth flow
```

Verify:
- "🧭 Manager running team **<teamname>**" header.
- Per-step `🔄 Step N: <worker> — <reason>` messages.
- A repeat worker appears with `(revision)` in the label.
- Final response begins with `🧭 Manager summary: …` and shows chronological `### Step N: <worker>` blocks.

Also run with `--all` to confirm legacy path still works:

```
/team <teamname> --all Some task
```

Expected: today's "👥 Running team … [--all override]" header followed by sequential per-worker output (no Manager involvement).

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): drive team auto mode via iterative Manager loop"
```

---

## Self-Review

**1. Spec coverage:**
- Naming/rename → Tasks 1, 3, 4.
- ManagerTurn contract → Task 3.
- Loop algorithm + cap → Task 5 (`runManagerLoop`).
- Manager prompt → Task 1.
- Output presentation (`🧭 Manager summary`, chronological steps, `(revision)`) → Task 5 (`formatManagerParts`, per-step sink message).
- Roster strictness → Task 3 (filter unknown `next` → fallback).
- Fallback rules (turn 1 vs mid-run) → Task 5 `runManagerLoop` + per-path handling.
- `composeStepTask` shape → Task 5.
- `--all` override unchanged → Task 5 (forceAll path).
- `/help` text update → Task 5 Step 5.
- No `workspace.json` schema change → confirmed (no migration tasks).

**2. Placeholder scan:** No TBDs, "implement later", or "similar to". Each step shows the exact code or command.

**3. Type consistency:** `ManagerTurn`, `ManagerInput`, `ManagerHistoryEntry`, `ManagerRunner`, `ManagerOptions`, `ManagerMember` defined in Task 3 are the same names imported in Task 5. `runManagerLoop` and `composeStepTask` and `formatManagerParts` are defined in the same task they are first called from. `formatManagerParts(parts, finalSummary, truncatePerStep?)` signature matches both call sites (with `500` in `runTeamTask`, omitted in `runTeamForChat`).
