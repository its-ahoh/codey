# Thinking-Effort Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set a reasoning-effort level (low/medium/high/xhigh/max) per chat, per worker, and per agent default, forwarded to whichever coding-agent CLI runs the turn.

**Architecture:** One `ThinkingEffort` union type stored at three layers (chat override > worker config > per-agent global default), carried on `AgentRequest.effort`, and turned into agent-specific argv by pure builders in `packages/core/src/agents/effort.ts`. codex validates the level server-side and hard-fails, so the codex adapter retries once without the flag and prepends a note to the output.

**Tech Stack:** TypeScript (ES2020/CommonJS, strict), Vitest, React (codey-mac renderer), Electron IPC.

---

## Environment setup (do this first)

The repo's default `node` is v16, which cannot run `vitest` or `tsc` here. Every
command in this plan assumes Node 22:

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
node -v   # must print v22.17.1
```

Single-file test runs use, from the repo root:

```bash
cd packages/core && npx vitest run src/agents/<file>.test.ts
```

## Spec

`docs/superpowers/specs/2026-08-09-thinking-effort-control-design.md`

**One refinement over the spec:** the spec named the helper file
`effort-retry.ts` holding only `isEffortRejection`. This plan uses
`packages/core/src/agents/effort.ts` and also puts the three argv builders there.
Reason: the adapters spawn real subprocesses and are not directly unit-testable
(see `packages/core/src/agents/claude-code.test.ts`, which tests the extracted
pure function `classifyClaudeRunResult` rather than the adapter). Extracting the
argv logic as pure functions is the only way to test it in this codebase's style,
and it keeps all effort knowledge in one file.

**Second refinement:** the spec did not say *where* the global default tier is
applied. `runWithFallback` (`packages/gateway/src/gateway.ts:5063`) is the single
choke point through which ~20 agent-run call sites pass. Applying the global
default there means only the chat and worker tiers need explicit wiring.

## File Structure

**Create:**
- `packages/core/src/agents/effort.ts` — the `ThinkingEffort` argv builders, the codex rejection detector, and the retry marker type. All pure.
- `packages/core/src/agents/effort.test.ts` — tests for the above.
- `packages/gateway/src/effort-resolve.ts` — pure precedence resolver (chat > worker > global).
- `packages/gateway/src/effort-resolve.test.ts` — tests for the resolver.

**Modify:**
- `packages/core/src/types/index.ts` — `ThinkingEffort`, `AgentRequest.effort`, `AgentModelConfig.defaultEffort`.
- `packages/core/src/types/chat.ts` — `Chat.effort`.
- `packages/core/src/workers.ts` — `WorkerConfig.effort`, `getWorkerEffort()`.
- `packages/core/src/agents/claude-code.ts` — append `--effort`.
- `packages/core/src/agents/opencode.ts` — append `--variant`.
- `packages/core/src/agents/codex.ts` — append `-c model_reasoning_effort`, degrade-retry.
- `packages/gateway/src/chats.ts` — `updateEffort()`.
- `packages/gateway/src/gateway.ts` — global-default injection, chat/worker wiring, `/effort` command.
- `codey-mac/electron/preload.ts`, `codey-mac/electron/main.ts`, `codey-mac/src/codey-api.d.ts` — `chats:updateEffort` IPC.
- `codey-mac/src/components/ChatTab.tsx` — Effort select in the run-settings row.
- `codey-mac/src/components/AgentsTab.tsx` — per-agent `Default effort`.
- `codey-mac/src/components/WorkersTab.tsx` — worker Effort select.

---

### Task 1: The `ThinkingEffort` type and its three storage fields

**Files:**
- Modify: `packages/core/src/types/index.ts:60` (near `ModelConfig`), `:117` (`AgentRequest`), `:267` (`AgentModelConfig`)
- Modify: `packages/core/src/types/chat.ts:145` (`Chat`)
- Modify: `packages/core/src/workers.ts:11` (`WorkerConfig`)

- [ ] **Step 1: Add the union type to `packages/core/src/types/index.ts`**

Insert immediately above `export interface ModelConfig {` (line 60):

```ts
/**
 * Reasoning-effort level, forwarded verbatim to every agent CLI.
 *
 * These five values are claude-code's `--effort` enum and are a strict subset
 * of codex's `model_reasoning_effort` enum, so no per-agent translation is
 * needed — only the flag syntax differs. `undefined` means "pass no flag" and
 * lets each CLI use its own default; there is deliberately no 'default'
 * literal, so there is exactly one representation of "unset".
 */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Runtime guard for values arriving from JSON config or chat commands. */
export function isThinkingEffort(v: unknown): v is ThinkingEffort {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max';
}
```

- [ ] **Step 2: Add `effort` to `AgentRequest`**

In `packages/core/src/types/index.ts`, inside `interface AgentRequest` (starts
line 117), add after the `model?: ModelConfig;` line:

```ts
  /**
   * Reasoning-effort level for this single invocation. Deliberately NOT part of
   * ModelConfig: effort is per-call intent, not a property of a model
   * definition, and storing it there would pollute the gateway.json catalog.
   */
  effort?: ThinkingEffort;
```

- [ ] **Step 3: Add `defaultEffort` to `AgentModelConfig`**

In the same file, `interface AgentModelConfig` (line 267) becomes:

```ts
export interface AgentModelConfig {
  enabled?: boolean;
  provider?: 'anthropic' | 'openai' | 'google';
  defaultModel?: string;
  models?: string[];  // model names only, provider determined by agent.provider
  /**
   * Per-agent default reasoning effort. Per-agent rather than one global value
   * because codex's valid subset varies by model, and `max` costs a different
   * order of magnitude across agents — a single value would force everyone onto
   * the most conservative agent's ceiling.
   */
  defaultEffort?: ThinkingEffort;
}
```

- [ ] **Step 4: Add `effort` to `Chat`**

In `packages/core/src/types/chat.ts`, after the `model?: string;` line (line 145):

```ts
  /** Per-chat reasoning-effort override. Falls back to the worker's effort, then the agent's defaultEffort. */
  effort?: ThinkingEffort;
```

Add `ThinkingEffort` to the existing import from `./index` at the top of the
file. If `chat.ts` has no import from `./index` yet, add:

```ts
import type { ThinkingEffort } from './index';
```

- [ ] **Step 5: Add `effort` to `WorkerConfig`**

In `packages/core/src/workers.ts`, `interface WorkerConfig` (line 11) becomes:

```ts
export interface WorkerConfig {
  codingAgent: 'claude-code' | 'opencode' | 'codex';
  model: string;
  tools: string[];
  /**
   * Optional one-line summary fed to the auto-dispatcher when this worker
   * appears in a team with `dispatch: 'auto'`. When unset, the dispatcher
   * uses the first line of `personality.role` truncated to 120 chars.
   * `personality.soul` and `.instructions` are never sent to the dispatcher.
   */
  dispatchHint?: string;
  /** Optional per-worker reasoning effort. Overridden by a chat-level effort. */
  effort?: ThinkingEffort;
}
```

Add the import at the top of `workers.ts`:

```ts
import type { ThinkingEffort } from './types';
```

Verify the existing import style in that file first — if it already imports from
`'./types'`, add `ThinkingEffort` to that import instead of adding a new line.

- [ ] **Step 6: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w @codey/core`
Expected: exits 0, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types/index.ts packages/core/src/types/chat.ts packages/core/src/workers.ts
git commit -m "Add ThinkingEffort type and its three storage fields"
```

---

### Task 2: Pure effort helpers (argv builders + codex rejection detector)

**Files:**
- Create: `packages/core/src/agents/effort.ts`
- Test: `packages/core/src/agents/effort.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/agents/effort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  claudeEffortArgs,
  codexEffortArgs,
  opencodeEffortArgs,
  isEffortRejection,
} from './effort';

// The real error text codex emits when the API rejects the level. Captured from
// `codex exec -c model_reasoning_effort="bogus"` against codex v0.145.0.
const REAL_REJECTION =
  `ERROR: {"type":"error","error":{"type":"invalid_request_error","message":` +
  `"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'max'. ` +
  `Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'."}}`;

describe('argv builders', () => {
  it('emits nothing when effort is unset', () => {
    expect(claudeEffortArgs(undefined)).toEqual([]);
    expect(codexEffortArgs(undefined)).toEqual([]);
    expect(opencodeEffortArgs(undefined)).toEqual([]);
  });

  it('emits each agent flag verbatim', () => {
    expect(claudeEffortArgs('xhigh')).toEqual(['--effort', 'xhigh']);
    expect(codexEffortArgs('xhigh')).toEqual(['-c', 'model_reasoning_effort="xhigh"']);
    expect(opencodeEffortArgs('xhigh')).toEqual(['--variant', 'xhigh']);
  });
});

describe('isEffortRejection', () => {
  it('detects the real codex rejection for the effort that was passed', () => {
    expect(isEffortRejection(REAL_REJECTION, 'max')).toBe(true);
  });

  it('does not fire when the rejected value is a different effort', () => {
    // The run passed 'low' but the error quotes 'max' — this is some other
    // request's error text, not ours.
    expect(isEffortRejection(REAL_REJECTION, 'low')).toBe(false);
  });

  it('does not fire on invalid_enum_value alone', () => {
    expect(isEffortRejection("[invalid_enum_value] Invalid value: 'max'.", 'max')).toBe(false);
  });

  it('does not fire on reasoning.effort alone', () => {
    expect(isEffortRejection('adjusting reasoning.effort for max throughput', 'max')).toBe(false);
  });

  it('does not fire on empty text', () => {
    expect(isEffortRejection('', 'max')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/agents/effort.test.ts`
Expected: FAIL — `Failed to resolve import "./effort"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/agents/effort.ts`:

```ts
import type { ThinkingEffort } from '../types';

/**
 * Per-agent argv for a reasoning-effort level.
 *
 * All three agents take the same five level strings, so these are verbatim
 * passthroughs that differ only in flag syntax. Verified against claude-code
 * 2.1.221, codex v0.145.0 and opencode:
 *
 *   claude-code  --effort <L>                      lenient (warns, uses default)
 *   codex        -c model_reasoning_effort="<L>"   STRICT (API rejects the run)
 *   opencode     --variant <L>                     lenient (silently ignored)
 */
export function claudeEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['--effort', effort] : [];
}

export function codexEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
}

export function opencodeEffortArgs(effort?: ThinkingEffort): string[] {
  return effort ? ['--variant', effort] : [];
}

/** Marker set on a retried request so a degrade can never loop. */
export interface EffortRetryable {
  __effortRetried?: boolean;
}

/**
 * True when a codex run failed *because of* the effort flag it was given.
 *
 * Requires all three markers: the enum-error code, the parameter path, and the
 * exact level this run passed out. The three-way AND is what stops a user
 * prompt that happens to quote this error text from being misread as a degrade
 * signal — all three appearing together, with our own value quoted, is not
 * something arbitrary output produces.
 */
export function isEffortRejection(text: string, passedEffort: string): boolean {
  if (!text) return false;
  return text.includes('invalid_enum_value')
    && text.includes('reasoning.effort')
    && text.includes(`'${passedEffort}'`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/agents/effort.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/effort.ts packages/core/src/agents/effort.test.ts
git commit -m "Add pure effort argv builders and codex rejection detector"
```

---

### Task 3: Forward effort from the claude-code adapter

**Files:**
- Modify: `packages/core/src/agents/claude-code.ts:66-71`

- [ ] **Step 1: Add the import**

At the top of `packages/core/src/agents/claude-code.ts`, alongside the existing
imports:

```ts
import { claudeEffortArgs } from './effort';
```

- [ ] **Step 2: Append the flag**

The block at line 66 currently reads:

```ts
      const args = [
        '--verbose',
        '--output-format', 'stream-json',
        '--include-partial-messages',
      ];
```

Add immediately after it:

```ts
      args.push(...claudeEffortArgs(request.effort));
```

- [ ] **Step 3: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w @codey/core`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/agents/claude-code.ts
git commit -m "Forward thinking effort to the claude-code CLI"
```

---

### Task 4: Forward effort from the opencode adapter

**Files:**
- Modify: `packages/core/src/agents/opencode.ts:67-82`

- [ ] **Step 1: Add the import**

At the top of `packages/core/src/agents/opencode.ts`:

```ts
import { opencodeEffortArgs } from './effort';
```

- [ ] **Step 2: Append the flag**

The adapter currently has, around line 80:

```ts
      if (request.model) {
        args.push('--model', request.model.model);
      }
```

Add immediately after that `if` block (still before `args.push(request.prompt)`
at line 91 — the prompt must stay last):

```ts
      args.push(...opencodeEffortArgs(request.effort));
```

- [ ] **Step 3: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w @codey/core`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/agents/opencode.ts
git commit -m "Forward thinking effort to the opencode CLI"
```

---

### Task 5: Forward effort from codex, with a one-shot degrade retry

**Files:**
- Modify: `packages/core/src/agents/codex.ts:128-135` (argv), `:271-305` (retry)

- [ ] **Step 1: Add the import**

At the top of `packages/core/src/agents/codex.ts`:

```ts
import { codexEffortArgs, isEffortRejection, type EffortRetryable } from './effort';
```

- [ ] **Step 2: Append the flag**

The block at line 128 currently reads:

```ts
      args.push(
        '--json',
        '--skip-git-repo-check',
      );
```

Add immediately after it:

```ts
      args.push(...codexEffortArgs(request.effort));
```

- [ ] **Step 3: Add the degrade retry**

In the `childProcess.on('close', ...)` handler, the code at line 290 currently
reads:

```ts
        const response: AgentResponse = {
          success: code === 0 && !errorMessage && !!output,
```

Insert this block immediately BEFORE that `const response` declaration (it must
come after `output` is computed at line 288):

```ts
        // codex validates model_reasoning_effort server-side and fails the whole
        // run on a level the current model doesn't accept. Retry once without
        // the flag so a stale effort setting can never wedge the user.
        const attempted = request.effort;
        const retryable = request as AgentRequest & EffortRetryable;
        if (attempted && !retryable.__effortRetried
            && isEffortRejection(`${errorMessage ?? ''}\n${stderr}\n${output}`, attempted)) {
          const retryReq: AgentRequest & EffortRetryable = { ...request, effort: undefined };
          retryReq.__effortRetried = true;
          // resumeSessionId is carried through unchanged: the first attempt
          // failed at parameter validation, so the session state is untouched.
          void this.run(retryReq).then(retried => {
            safeResolve(retried.success
              ? {
                  ...retried,
                  output: `> Effort \`${attempted}\` isn't accepted by the current codex model — reran with the model's default effort.\n\n${retried.output}`,
                }
              : retried);
          });
          return;
        }
```

Note: `safeResolve` (line 177) unlinks the *outer* run's `outFile` and guards
double-resolution, so calling it with the retried response is correct — the
retry created and cleaned up its own tempfile.

- [ ] **Step 4: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w @codey/core`
Expected: exits 0.

- [ ] **Step 5: Run the whole core suite for regressions**

Run: `cd packages/core && npx vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agents/codex.ts
git commit -m "Forward thinking effort to codex and degrade once on rejection"
```

---

### Task 6: Pure precedence resolver

**Files:**
- Create: `packages/gateway/src/effort-resolve.ts`
- Test: `packages/gateway/src/effort-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/effort-resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveEffort } from './effort-resolve';

describe('resolveEffort', () => {
  it('prefers the chat override over everything', () => {
    expect(resolveEffort({ chat: 'low', worker: 'high', global: 'max' })).toBe('low');
  });

  it('falls back to the worker effort when the chat has none', () => {
    expect(resolveEffort({ worker: 'high', global: 'max' })).toBe('high');
  });

  it('falls back to the global default when neither is set', () => {
    expect(resolveEffort({ global: 'max' })).toBe('max');
  });

  it('returns undefined when nothing is set, so no flag is passed', () => {
    expect(resolveEffort({})).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && npx vitest run src/effort-resolve.test.ts`
Expected: FAIL — `Failed to resolve import "./effort-resolve"`.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/effort-resolve.ts`:

```ts
import type { ThinkingEffort } from '@codey/core';

/**
 * Reasoning-effort precedence: chat override > worker config > per-agent
 * global default. Mirrors the model chain in ChatTab's `effectiveModel`.
 * `undefined` propagates as "pass no flag".
 */
export function resolveEffort(tiers: {
  chat?: ThinkingEffort;
  worker?: ThinkingEffort;
  global?: ThinkingEffort;
}): ThinkingEffort | undefined {
  return tiers.chat ?? tiers.worker ?? tiers.global;
}
```

No barrel change is needed: `packages/core/src/index.ts:2` is
`export * from './types'`, so `ThinkingEffort` and `isThinkingEffort` are already
public once Task 1 lands.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/gateway && npx vitest run src/effort-resolve.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/effort-resolve.ts packages/gateway/src/effort-resolve.test.ts
git commit -m "Add pure thinking-effort precedence resolver"
```

---

### Task 7: Persist the per-chat effort override

**Files:**
- Modify: `packages/gateway/src/chats.ts:303` (next to `updateAgentModel`)

- [ ] **Step 1: Add the setter**

In `packages/gateway/src/chats.ts`, immediately after the closing brace of
`updateAgentModel` (which ends at line 314), add:

```ts
  /**
   * Set or clear the per-chat reasoning-effort override. Pass null/undefined to
   * clear and fall back to the worker/global tiers.
   *
   * Deliberately separate from updateAgentModel: that setter's session-anchor
   * behavior is tied to agent/model identity, and changing effort must NOT
   * rotate the session — raising effort and continuing the same thread is the
   * primary use case, and rotating would drop the conversation context.
   */
  updateEffort(chatId: string, effort?: ThinkingEffort | null): Chat {
    const chat = this.requireChat(chatId);
    if (effort === null || effort === undefined) delete chat.effort;
    else chat.effort = effort;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }
```

Add `ThinkingEffort` to the existing `@codey/core` type import at the top of
`chats.ts`.

- [ ] **Step 2: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w @codey/gateway`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chats.ts
git commit -m "Add per-chat thinking-effort override setter"
```

---

### Task 8: Apply the global default centrally, and the chat tier on the chat path

**Files:**
- Modify: `packages/gateway/src/gateway.ts:5063` (`runWithFallback`), `:5398` (quick question), `:5681` (`sendToChat`)

- [ ] **Step 1: Add the imports**

At the top of `packages/gateway/src/gateway.ts`, add to the existing imports:

```ts
import { resolveEffort } from './effort-resolve';
```

and add `ThinkingEffort` to the existing `@codey/core` type import.

- [ ] **Step 2: Inject the global default in `runWithFallback`**

`runWithFallback` (line 5063) is the single choke point every agent run passes
through. Replace its first line:

```ts
  private async runWithFallback(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    const response = await this.runAgentWithNetworkRetry(agent, request);
```

with:

```ts
  private async runWithFallback(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    // Global tier: any caller that didn't set an explicit chat/worker effort
    // inherits the agent's configured default. Applied here rather than at each
    // of the ~20 call sites.
    if (request.effort === undefined) {
      request = { ...request, effort: this.getDefaultEffort(agent) };
    }
    const response = await this.runAgentWithNetworkRetry(agent, request);
```

Note the effort is intentionally NOT re-resolved per fallback agent: the level is
a verbatim passthrough, and if a fallback lands on codex with an unsupported
level, Task 5's degrade-retry handles it.

- [ ] **Step 3: Add the `getDefaultEffort` accessor**

Add this method next to `getDefaultModelConfig` (line 419):

```ts
  /** The per-agent configured default effort, if any. */
  private getDefaultEffort(agent: CodingAgent): ThinkingEffort | undefined {
    return this.config.agents?.[agent]?.defaultEffort;
  }
```

- [ ] **Step 4: Pass the chat override on the `sendToChat` path**

At line 5678 the chat path reads:

```ts
    // Per-chat override takes precedence over the gateway default.
    const agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
```

Add immediately after that line:

```ts
    const chatEffort = resolveEffort({ chat: chat.effort });
```

Then, at each `this.runWithFallback(agent, { ... })` call inside this method
(lines 5885 and 5912), add `effort: chatEffort,` to the request object literal,
directly after the existing `model,` property.

- [ ] **Step 5: Pass the chat override on the quick-question path**

At line 5397, inside the `else` branch:

```ts
        agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
        model = chat.model
          ? this.getModelConfig(agent, chat.model)
          : this.getDefaultModelConfig(agent);
```

Then at the `this.runWithFallback(agent, { ... })` call at line 5429, add to the
request object literal, after `model,`:

```ts
        effort: resolveEffort({ chat: chat.effort }),
```

- [ ] **Step 6: Verify it compiles and the gateway suite passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w @codey/gateway && cd packages/gateway && npx vitest run`
Expected: build exits 0, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "Resolve global and per-chat thinking effort on the run paths"
```

---

### Task 9: Worker-tier effort

**Files:**
- Modify: `packages/core/src/workers.ts:181` (next to `getWorkerModel`)
- Modify: `packages/gateway/src/gateway.ts` — worker run sites at `:3573`, `:3974`, `:4091`, `:4206`, `:4431`

- [ ] **Step 1: Add the worker accessor**

In `packages/core/src/workers.ts`, `getWorkerModel` at line 181 reads:

```ts
    return this.getWorker(name)?.config.model || '';
```

Add this method immediately after that method's closing brace:

```ts
  /** The worker's configured reasoning effort, or undefined when unset. */
  getWorkerEffort(name: string): ThinkingEffort | undefined {
    return this.getWorker(name)?.config.effort;
  }
```

- [ ] **Step 2: Preserve `effort` through worker writes**

In `packages/core/src/workers.ts`, the validation at line 111 reads:

```ts
    if (!config.codingAgent || !config.model) {
```

Leave that check as-is — `effort` is optional. But confirm the write path
persists unknown-to-required fields: search the file for where `config` is
serialized into `workspace.json` and make sure it writes the whole `config`
object rather than picking named fields. If it picks fields explicitly, add
`effort` to that pick list.

- [ ] **Step 3: Pass worker effort at each worker run site**

At each of `packages/gateway/src/gateway.ts:3573`, `:3974`, `:4091`, `:4206`,
`:4431`, the surrounding code resolves a worker's model via
`wm.getWorkerModel(memberName)` (or a local `workerModelName`) and then builds a
`runWithFallback` request. In each of those request object literals, add after
the `model` property:

```ts
        effort: resolveEffort({
          chat: chatEffort,
          worker: wm.getWorkerEffort(memberName),
        }),
```

Adjust the two variable names per site: use whatever local holds the worker name
at that site (`memberName`, `workerName`, or `opts.worker`), and pass
`chat: undefined` at sites that have no chat in scope. Do not invent a chat
variable where none exists — the global tier still applies via Task 8 Step 2.

- [ ] **Step 4: Verify it compiles and both suites pass**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build && npm test`
Expected: build exits 0, all workspace tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workers.ts packages/gateway/src/gateway.ts
git commit -m "Apply per-worker thinking effort on team and worker runs"
```

---

### Task 10: The `/effort` chat command

**Files:**
- Modify: `packages/gateway/src/gateway.ts:2378` (dispatch), `:2566` (next to `cmdModel`)

**Context the implementer needs:** channel-side `/model` (line 2566) is an
informational stub that persists nothing, and `/agent` (line 2584) writes the
*global* default via `configManager`. Channel chats have no `Chat` record, so
`/effort` follows `/agent`: it sets the per-agent global default. That is the
only tier reachable from Telegram/Discord.

- [ ] **Step 1: Add the dispatch case**

In the command `switch` block, immediately after the `case 'model':` block that
ends at line 2380, add:

```ts
      case 'effort':
        await this.cmdEffort(args, chatId, channel);
        break;
```

- [ ] **Step 2: Add the command handler**

Add this method immediately after `cmdModel` (which ends at line 2582):

```ts
  private async cmdEffort(args: string[], chatId: string, channel: ChannelType): Promise<void> {
    const agent = this.getDefaultAgent() as CodingAgent;
    const current = this.getDefaultEffort(agent);

    if (args.length === 0) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Current effort for **${agent}**: ${current ?? 'unset (CLI default)'}\n\n` +
          `Set with: /effort <low|medium|high|xhigh|max>\nClear with: /effort clear`,
      });
      return;
    }

    const raw = args[0].toLowerCase();
    if (raw === 'clear') {
      this.configManager?.setAgentDefaultEffort(agent, undefined);
      await this.sendResponse({
        chatId,
        channel,
        text: `✅ Cleared effort for **${agent}** — using the CLI default.`,
      });
      return;
    }

    if (!isThinkingEffort(raw)) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Unknown effort: ${raw}\n\nAvailable: low, medium, high, xhigh, max`,
      });
      return;
    }

    this.configManager?.setAgentDefaultEffort(agent, raw);
    await this.sendResponse({
      chatId,
      channel,
      text: `✅ Effort for **${agent}** set to **${raw}**.`,
    });
  }
```

Add `isThinkingEffort` to the existing `@codey/core` value import at the top of
`gateway.ts` (it is a function, so it must be a value import, not `import type`).

- [ ] **Step 3: Add the config setter**

In `packages/gateway/src/config.ts`, next to the existing agent accessors around
line 334, add:

```ts
  /** Set or clear an agent's default reasoning effort and persist gateway.json. */
  setAgentDefaultEffort(agent: CodingAgent, effort?: ThinkingEffort): void {
    if (!this.config.agents) this.config.agents = {};
    const slot = this.config.agents[agent] ?? {};
    if (effort === undefined) delete slot.defaultEffort;
    else slot.defaultEffort = effort;
    this.config.agents[agent] = slot;
    this.save();
  }
```

Check the file's existing persistence method name — if it is not `save()`, use
whatever `setDefaultAgent` calls to write `gateway.json`, and match the same
import style for `ThinkingEffort` / `CodingAgent`.

- [ ] **Step 4: Register the command in the help text**

Search `packages/gateway/src/gateway.ts` for the `/model` entry in the help
listing (`cmdHelp` or a `HELP_TEXT` constant) and add a matching line:

```
/effort <level> — Set reasoning effort (low/medium/high/xhigh/max)
```

- [ ] **Step 5: Verify it compiles and tests pass**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build && npm test`
Expected: build exits 0, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/config.ts
git commit -m "Add /effort chat command"
```

---

### Task 11: IPC for the per-chat effort override

**Files:**
- Modify: `codey-mac/electron/main.ts:3508`, `codey-mac/electron/preload.ts:161`, `codey-mac/src/codey-api.d.ts:293`

- [ ] **Step 1: Add the main-process handler**

In `codey-mac/electron/main.ts`, the handler at line 3508 reads:

```ts
ipcMain.handle('chats:updateAgentModel', async (_e, id: string, agent: string | null, model: string | null) =>
```

Add a sibling handler immediately after that handler's closing `)`:

```ts
ipcMain.handle('chats:updateEffort', async (_e, id: string, effort: string | null) =>
  withGateway(() =>
    inProcessGateway!.getChatManager().updateEffort(id, effort as any)
  ))
```

Match the exact wrapper the neighbouring handler uses (line 3509-3511 shows the
`withGateway`/guard style in this file) rather than the sketch above — copy that
handler's structure verbatim and swap the method and arguments.

- [ ] **Step 2: Add the preload binding**

In `codey-mac/electron/preload.ts`, after line 162:

```ts
    updateEffort: (id: string, effort: string | null) =>
      ipcRenderer.invoke('chats:updateEffort', id, effort),
```

- [ ] **Step 3: Add the type declaration**

In `codey-mac/src/codey-api.d.ts`, after line 293:

```ts
        updateEffort: (id: string, effort: string | null) => Promise<IpcResult<Chat>>
```

- [ ] **Step 4: Expose it from the chats hook**

Find the `useChats` hook (imported at `codey-mac/src/components/ChatTab.tsx:841`)
and add a `setEffort` action next to the existing `setAgentModel`, following that
action's exact shape — it calls `window.codey.chats.updateAgentModel` and merges
the returned `Chat` into state. The new one calls
`window.codey.chats.updateEffort(chatId, effort)` and merges the same way.

- [ ] **Step 5: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w codey-mac`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts codey-mac/src/hooks
git commit -m "Add chats:updateEffort IPC"
```

---

### Task 12: Effort select in the chat run-settings row

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx:841`, `:1311-1313`, `:1357`, `:1885`

- [ ] **Step 1: Pull `setEffort` out of the hook**

At line 841, add `setEffort` to the destructured actions:

```ts
  const { state, sendMessage, stopChat, clearRestore, setSelection, setAgentModel, setEffort, setWorkingDir: setChatWorkingDir, setContextPanelOpen, setSoloAdvisor, linkChannel, unlinkChannel, resolvePermission, generateTaskBrief } = useChats()
```

- [ ] **Step 2: Derive the effective effort**

`agentDefaultModels` (line 875) is built from `fallback.order`, which carries no
effort, so the defaults must be fetched from the agents config instead.

Add the state next to line 875:

```ts
  const [agentDefaultEfforts, setAgentDefaultEfforts] = useState<Record<string, string | undefined>>({})
```

Populate it inside the same `useEffect` that ends at line 1119, immediately after
the `setAgentDefaultModels(defaults)` call at line 1115:

```ts
          try {
            const ag = await window.codey.agents.get()
            if (ag.ok) {
              const slots = (ag.data ?? {}) as Record<string, { defaultEffort?: string }>
              const efforts: Record<string, string | undefined> = {}
              for (const n of AGENT_NAMES) efforts[n] = slots[n]?.defaultEffort
              setAgentDefaultEfforts(efforts)
            }
          } catch { /* falls back to "CLI default" in the dropdown */ }
```

Then, after line 1313 (`const effectiveModel = ...`), add:

```ts
  const workerEffort = selectedWorker?.config.effort
  const effectiveEffort: string | undefined = chat.effort ?? workerEffort ?? agentDefaultEfforts[effectiveAgent]
```

- [ ] **Step 3: Add the change handler**

After `onModelChange` (line 1357-1359), add:

```ts
  const onEffortChange = async (v: string) => {
    // '' is the Inherit option — clears the chat override.
    await setEffort(chat.id, v === '' ? null : v)
  }
```

- [ ] **Step 4: Add the select**

After the Model `</label>` at line 1885 and before the Advisor `<button>` at
line 1886, insert:

```tsx
                    <label style={styles.runSettingGroup}>
                      <span style={styles.runSettingLabel}>Effort</span>
                      <select
                        value={chat.effort ?? ''}
                        onChange={e => void onEffortChange(e.target.value)}
                        style={styles.runSettingSelect}
                        title={`Effort: ${effectiveEffort ?? 'CLI default'}${chat.effort ? ' (override)' : workerEffort ? ` (worker: ${selectedWorker!.name})` : ' (default)'}`}
                      >
                        <option value="">Inherit ({effectiveEffort ?? 'CLI default'})</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="xhigh">xhigh</option>
                        <option value="max">max</option>
                      </select>
                    </label>
```

This sits inside the non-team branch that opens at line 1856, so the team case
(line 1853, "Teams choose their own agent routing.") already hides it.

- [ ] **Step 5: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w codey-mac`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "Add Effort select to the chat run-settings row"
```

---

### Task 13: Per-agent default effort in Settings

**Files:**
- Modify: `codey-mac/src/components/AgentsTab.tsx:16`, and the agent card near `:85`

- [ ] **Step 1: Extend the slot type**

Line 16 becomes:

```ts
type AgentSlot = { enabled?: boolean; defaultModel?: string; defaultEffort?: string; env?: Record<string, string> }
```

- [ ] **Step 2: Add the select to each agent card**

Find the `Default model` control inside the per-agent card (the code around line
85 that calls `window.codey.agents.set({ [a]: updated[a] })`). Add a sibling
control next to it:

```tsx
<label style={{ display: 'block', marginTop: 10 }}>
  <span style={{ fontSize: 11, color: C.fg3 }}>Default effort</span>
  <select
    value={agents[a]?.defaultEffort ?? ''}
    onChange={async e => {
      const v = e.target.value
      const updated = { ...agents, [a]: { ...agents[a], defaultEffort: v === '' ? undefined : v } }
      setAgents(updated)
      // agents:set merges shallowly, so sending just this agent's slot is enough.
      await unwrap(await window.codey.agents.set({ [a]: updated[a] }))
    }}
  >
    <option value="">Unset (CLI default)</option>
    <option value="low">low</option>
    <option value="medium">medium</option>
    <option value="high">high</option>
    <option value="xhigh">xhigh</option>
    <option value="max">max</option>
  </select>
</label>
```

Match the surrounding control's exact styling props rather than the minimal
inline styles above — copy them from the adjacent `Default model` control.

- [ ] **Step 3: Verify it compiles**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build -w codey-mac`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/AgentsTab.tsx
git commit -m "Add per-agent default effort to Settings"
```

---

### Task 14: Worker effort in the worker editor

**Files:**
- Modify: `codey-mac/src/components/WorkersTab.tsx:40`, `:100`, `:114`, `:128`, and the Model field near `:180`

- [ ] **Step 1: Add editor state**

After line 100 (`const [model, setModel] = useState(worker.config.model)`), add:

```ts
  const [effort, setEffort] = useState(worker.config.effort ?? '')
```

- [ ] **Step 2: Reset it when the selected worker changes**

Line 114 currently reads:

```ts
    setCodingAgent(worker.config.codingAgent); setModel(worker.config.model); setToolsText(worker.config.tools.join(', '))
```

Append to that line:

```ts
    setEffort(worker.config.effort ?? '')
```

- [ ] **Step 3: Persist it on save**

Line 128 currently reads:

```ts
        config: { codingAgent, model, tools: toolsText.split(',').map(s => s.trim()).filter(Boolean) },
```

becomes:

```ts
        config: {
          codingAgent,
          model,
          tools: toolsText.split(',').map(s => s.trim()).filter(Boolean),
          ...(effort ? { effort } : {}),
        },
```

The spread keeps `effort` out of the JSON entirely when unset, so `workspace.json`
stays clean for workers that never use it.

- [ ] **Step 4: Add the field**

After the Model field (the `<label style={labelStyle}>Model</label>` block that
starts at line 180) add:

```tsx
      <label style={labelStyle}>Effort</label>
      <select value={effort} onChange={e => setEffort(e.target.value)} style={fieldStyle}>
        <option value="">Unset (inherit)</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh</option>
        <option value="max">max</option>
      </select>
```

- [ ] **Step 5: Show it in the list row**

Line 40 currently reads:

```tsx
              <div style={{ fontSize: 10, color: C.fg3, marginTop: 2 }}>{w.config.codingAgent} · {w.config.model}</div>
```

becomes:

```tsx
              <div style={{ fontSize: 10, color: C.fg3, marginTop: 2 }}>{w.config.codingAgent} · {w.config.model}{w.config.effort ? ` · ${w.config.effort}` : ''}</div>
```

- [ ] **Step 6: Verify the whole repo builds and every suite passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run build && npm test && npm run lint`
Expected: build exits 0, all tests pass, lint reports no non-English characters.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/WorkersTab.tsx
git commit -m "Add worker-level thinking effort to the worker editor"
```

---

### Task 15: Real-agent smoke test

Every prior task is verified by unit tests and the type checker, but nothing so
far has actually spawned a CLI with the flag. This task is manual and required —
the argv builders being correct does not prove the CLIs accept the result.

- [ ] **Step 1: claude-code accepts the flag**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd /tmp && claude -p "reply with the single word ok" --effort xhigh --output-format stream-json --verbose 2>&1 | tail -3
```

Expected: a `result` event with `is_error: false`. Specifically, NO line
containing `Unknown --effort value` — that warning means the level string is
being mangled somewhere in the argv builder.

- [ ] **Step 2: codex accepts a supported level**

```bash
cd /tmp && codex exec --skip-git-repo-check -c model_reasoning_effort="high" "reply with the single word ok" 2>&1 | tail -5
```

Expected: normal completion, and the banner line reads `reasoning effort: high`.

- [ ] **Step 3: codex degrade-retry fires end to end**

Set a chat's effort to `max` in the Mac app, switch that chat's agent to codex
with a model that rejects `max`, and send "hi".

Expected: the reply arrives successfully and begins with the note
`> Effort \`max\` isn't accepted by the current codex model — reran with the model's default effort.`
Expected NOT: a raw `invalid_enum_value` error surfaced to the user.

If no available model rejects `max`, verify the path by temporarily changing the
`codexEffortArgs` return to `['-c', 'model_reasoning_effort="bogus"']`, running
one turn, confirming the note appears, then reverting that edit.

- [ ] **Step 4: opencode tolerates the flag**

```bash
cd /tmp && opencode run --variant high "reply with the single word ok" 2>&1 | tail -3
```

Expected: normal completion. opencode ignores unknown variants silently, so the
only failure mode worth catching here is a crash or an argv parse error.

- [ ] **Step 5: Precedence works in the app**

Set a global default of `low` for claude-code in Settings, `high` on a worker,
and `max` on a chat. Run one turn per configuration and confirm via the
gateway log that the argv carries `max` (chat), then `high` (chat cleared), then
`low` (chat and worker cleared).

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found in thinking-effort smoke test"
```

---

## Self-review notes

Checked against the spec:

- Spec §1 (data model, three tiers, `AgentRequest.effort`, not in `ModelConfig`) → Tasks 1, 7, 9, 13, 14.
- Spec §2 (three argv insertions, `isEffortRejection` three-way AND, single retry, `__effortRetried`, output-prepended note, session carried through) → Tasks 2, 3, 4, 5.
- Spec §3a (chat select, Inherit clears) → Tasks 11, 12. §3b → Task 13. §3c → Task 14. §3d (`/effort`) → Task 10.
- Spec test plan (rejection detector, argv presence/absence, retry-once, precedence, command) → Tasks 2, 6, 10, 15.

**Deviation from the spec worth flagging to the reviewer:** the spec's §3d said
`/effort clear` clears "the chat override". Task 10 instead sets and clears the
*per-agent global default*, because channel chats have no `Chat` record —
channel-side `/model` persists nothing and `/agent` writes the global default
(`gateway.ts:2584`). Changing the global from a chat command is the only tier
actually reachable from Telegram/Discord. The command's reply text says which
agent it changed so this is not silently surprising.
