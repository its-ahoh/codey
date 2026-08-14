# Automation authoring friction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saving an automation instant by demoting the dry run from a save gate to a persisted, advisory result, and make authoring-chat turns survive a slow model.

**Architecture:** The dry run moves out of the authoring chat session entirely. It is keyed by automation id, runs after the automation is already persisted, and writes an advisory `check` field onto the automation record which the one-pager renders as a banner. The authoring chat keeps only `draftComplete` as its save precondition. Separately, `runAide` grows a bounded retry for transient failures and the chat prompt caps its transcript so long conversations stop growing without limit.

**Tech Stack:** TypeScript (CommonJS, strict), Vitest, Electron + React (codey-mac), npm workspaces (`packages/core`, `packages/gateway`, `codey-mac`).

**Source spec:** `docs/superpowers/specs/2026-08-13-automation-authoring-friction-design.md`

---

## Before you start

This is a fresh git worktree. Node and dependencies must be set up once:

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
npm install
npm run build -w @codey/core && npm run build -w @codey/gateway
```

`node -v` must print `v22.17.1` before running anything else. Every `npm test` command in this plan assumes that shell.

**Expect the TypeScript build to be red in the middle of this plan.** This is one cross-cutting refactor: Task 1 deletes the `chat-check` event that the Mac renderer still uses until Task 13. Vitest does not typecheck, so each task's own unit tests pass in isolation. Task 15 is where `npm run build` must come back green — do not skip it.

## File structure

**Modified — `packages/core`**
- `src/types/automation.ts` — add `AutomationCheck`, `Automation.check`; replace the `chat-check` event variant with `automation-check`.
- `src/aide.ts` — `AideOptions.retries` / `.retryDelayMs`, transient-vs-configuration error classification, retry loop.
- `src/aide-automation.ts` — capped transcript rendering, per-turn time budget, exported `executionFingerprint`, prompt rule 5 edit.

**Modified — `packages/gateway`**
- `src/automations/chat.ts` — all check machinery removed; `finalize()` gated only by `draftComplete`.
- `src/automations/dry-run.ts` — keyed by automation id (documentation and parameter names; mechanics unchanged).
- `src/automations/store.ts` — `setCheck()`, which writes the advisory verdict without bumping `updatedAt`.
- `src/gateway.ts` — post-save check scheduling, verdict persistence + event, `recheckAutomation`, `dismissAutomationCheck`, cancel-on-delete.

**Created — `packages/gateway`**
- `src/automations/check.ts` — two pure helpers: `needsRecheck()` and `verdictToCheck()`. Separate file so the save-time decision is unit-testable without constructing a Gateway.
- `src/automations/check.test.ts`

**Modified — `codey-mac`**
- `electron/main.ts`, `electron/preload.ts`, `src/codey-api.d.ts` — drop `chat:retryCheck` and the `allowUnchecked` argument; add `automations:recheck` and `automations:dismissCheck`.
- `src/components/automationsModel.ts` — `checkLabel` → `checkBanner`.
- `src/components/AutomationChatCreate.tsx` — one save button, no verification concept, honest failure text.
- `src/components/AutomationOnePager.tsx` — check banner.
- `src/components/AutomationsView.tsx` — `gaps` marker on list rows.

## Deviations from the spec (both deliberate, both small)

1. `AutomationEvent`'s `automation-check` variant carries `check?: AutomationCheck` rather than a required `check`. An absent `check` means "cleared", which is what Dismiss needs in order to reach other open windows.
2. `AutomationCheck.status` reuses the existing exported `AutomationCheckStatus` union instead of re-spelling the same four literals inline.
3. The spec asks for a Mac test that "the create footer enables on `draftComplete` alone". `codey-mac` has no jsdom or React Testing Library — its suite is pure-model only — so that assertion lives in the manual smoke test (Task 15, step 6.1) rather than a component test. The banner half of that bullet is covered by a real unit test, because Task 12 moves the branching into a pure helper.

---

### Task 1: Persisted check type and event

**Files:**
- Modify: `packages/core/src/types/automation.ts:164-186`

- [ ] **Step 1: Replace the session-scoped event with the persisted one**

In `packages/core/src/types/automation.ts`, replace everything from the `AutomationCheckStatus` comment (line 164) to the end of the file with:

```ts
/** Status of an automation's advisory dry-run check. */
export type AutomationCheckStatus = 'pending' | 'clean' | 'gaps' | 'error';

/** Advisory result of the last unattended dry run. Never blocks saving:
 *  the automation is already persisted by the time a verdict arrives. */
export interface AutomationCheck {
  status: AutomationCheckStatus;
  /** Present when status === 'gaps'. */
  questions?: string[];
  /** Present when status === 'error'. */
  detail?: string;
  at: number;
}

export type AutomationEvent =
  | {
      type: 'run-started' | 'run-finished' | 'run-parked';
      automationId: string;
      runId: string;
      run?: AutomationRun;
    }
  | {
      /** The automation's advisory check changed. An absent `check` means it
       *  was dismissed and the banner should disappear. */
      type: 'automation-check';
      automationId: string;
      check?: AutomationCheck;
    };
```

- [ ] **Step 2: Add the field to `Automation`**

In the same file, inside `export interface Automation` (after the `chatId` field at line 113), add:

```ts
  /** Advisory verdict from the last background dry run. Absent on records
   *  written before this existed, and after the user dismisses it. */
  check?: AutomationCheck;
```

- [ ] **Step 3: Verify the package still compiles**

Run: `npm run build -w @codey/core`
Expected: exit 0. (`chat-check` had no consumer inside `packages/core`, so this stays green; the gateway and renderer break until Tasks 6 and 13.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/automation.ts
git commit -m "feat(core): persist an advisory dry-run check on the automation"
```

---

### Task 2: Bounded retry in runAide

**Files:**
- Modify: `packages/core/src/aide.ts`
- Test: `packages/core/src/aide.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/aide.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runAide, runAideJson, isConfigError } from './aide';
import type { AideOptions } from './aide';
import type { AgentRequest, AgentResponse } from './types';

/** Aide options whose runner is a caller-supplied mock. Retries are instant
 *  so tests never wait on the real 1s backoff. */
const opts = (runner: AideOptions['runner'], over: Partial<AideOptions> = {}): AideOptions => ({
  agent: 'claude-code', runner, retryDelayMs: 0, ...over,
});

const ok = (output: string): AgentResponse => ({ success: true, output } as AgentResponse);

describe('isConfigError', () => {
  it('flags configuration failures a retry cannot fix', () => {
    expect(isConfigError('Request failed with status 402')).toBe(true);
    expect(isConfigError('unknown model: deepseek-v4-pro')).toBe(true);
    expect(isConfigError('Invalid API key provided')).toBe(true);
  });
  it('does not flag transient failures', () => {
    expect(isConfigError('The operation was aborted')).toBe(false);
    expect(isConfigError('socket hang up')).toBe(false);
  });
});

describe('runAide retries', () => {
  it('does not retry by default', async () => {
    const runner = vi.fn(async (_r: AgentRequest) => { throw new Error('socket hang up'); });
    await expect(runAide('p', opts(runner))).rejects.toThrow('socket hang up');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the second attempt', async () => {
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(ok('  second  '));
    const out = await runAide('p', opts(runner as any, { retries: 1 }));
    expect(out).toBe('second');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not retry a configuration failure', async () => {
    const runner = vi.fn(async (_r: AgentRequest) => { throw new Error('HTTP 402 payment required'); });
    await expect(runAide('p', opts(runner, { retries: 3 }))).rejects.toThrow('402');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the caller aborts', async () => {
    const ac = new AbortController();
    const runner = vi.fn(async (_r: AgentRequest): Promise<AgentResponse> => {
      ac.abort();
      throw new Error('socket hang up');
    });
    await expect(runAide('p', opts(runner, { retries: 2, signal: ac.signal }))).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe('runAideJson', () => {
  it('retries unparseable output, then returns the parsed object', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(ok('sorry, no JSON here'))
      .mockResolvedValueOnce(ok('{"reply":"hi"}'));
    const res = await runAideJson('p', opts(runner as any, { retries: 1 }));
    expect(res).toEqual({ reply: 'hi' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('still returns null when every attempt is unparseable', async () => {
    const runner = vi.fn(async (_r: AgentRequest) => ok('nope'));
    expect(await runAideJson('p', opts(runner, { retries: 1 }))).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/core -- aide.test.ts`
Expected: FAIL — `isConfigError` is not exported.

- [ ] **Step 3: Implement**

Replace the body of `packages/core/src/aide.ts` from the `AideOptions` interface (line 16) to the end of the file with:

```ts
export interface AideOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: AideRunner;
  /** Hard timeout per attempt in ms. Default 30_000. */
  timeoutMs?: number;
  /** Extra attempts after the first, for transient failures only. Default 0,
   *  so existing callers are unaffected. */
  retries?: number;
  /** Delay between attempts in ms. Default 1_000. */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Configuration failures: a second attempt fails identically, so retrying
 *  only doubles the wait before the user sees the real problem. */
const CONFIG_ERROR = /\b40[123]\b|payment required|unknown model|invalid model|model not found|invalid api key|unauthorized/i;

export function isConfigError(message: string): boolean {
  return CONFIG_ERROR.test(message);
}

/** Marks output that reached us but wasn't JSON — transient in practice, so
 *  runAideJson retries it instead of giving up on the first bad completion. */
class UnparseableAideJson extends Error {
  constructor() { super('Aide returned unparseable JSON'); }
}

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

async function withRetries<T>(opts: AideOptions, attempt: () => Promise<T>): Promise<T> {
  const total = Math.max(0, opts.retries ?? 0) + 1;
  let lastErr: unknown;
  for (let i = 0; i < total; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (i === total - 1) break;
      if (opts.signal?.aborted) break;
      if (isConfigError((err as Error)?.message ?? '')) break;
      await delay(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/** One attempt: the timeout is per-attempt, so a retry gets a full budget. */
async function runOnce(prompt: string, opts: AideOptions): Promise<string> {
  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await opts.runner({
      prompt,
      agent: opts.agent,
      model: opts.model,
      signal: ac.signal,
    });
    if (!res.success) throw new Error(res.error ?? 'aide runner returned non-success');
    return (res.output ?? '').trim();
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort);
  }
}

/** Run a one-shot prompt through the configured Aide. Returns trimmed output, or throws. */
export async function runAide(prompt: string, opts: AideOptions): Promise<string> {
  return withRetries(opts, () => runOnce(prompt, opts));
}

/** JSON variant — runs the prompt, then extracts and parses the first balanced
 *  object. Unparseable output is retried like any other transient failure;
 *  null is returned only after the last attempt. */
export async function runAideJson<T = unknown>(prompt: string, opts: AideOptions): Promise<T | null> {
  try {
    return await withRetries(opts, async () => {
      const txt = await runOnce(prompt, opts);
      const parsed = extractJsonObject(txt) as T | null;
      if (parsed === null) throw new UnparseableAideJson();
      return parsed;
    });
  } catch (err) {
    if (err instanceof UnparseableAideJson) return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/core -- aide.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Confirm no other Aide caller regressed**

Run: `npm test -w @codey/core -- aide-tasks.test.ts aide-automation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/aide.ts packages/core/src/aide.test.ts
git commit -m "feat(core): bounded retry for transient Aide failures"
```

---

### Task 3: Cap the authoring transcript

**Files:**
- Modify: `packages/core/src/aide-automation.ts:73-99`
- Test: `packages/core/src/aide-automation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/aide-automation.test.ts`:

```ts
describe('formatTranscript', () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `m${i}`,
  }));

  it('renders every message when under the cap', () => {
    expect(formatTranscript(msgs(2))).toBe('User: m0\nYou: m1');
  });

  it('keeps the newest MAX_CHAT_HISTORY and marks the elision', () => {
    const out = formatTranscript(msgs(30));
    const lines = out.split('\n');
    expect(lines[0]).toBe('[earlier turns omitted]');
    expect(lines).toHaveLength(MAX_CHAT_HISTORY + 1);
    expect(lines[1]).toBe('User: m6');
    expect(lines[lines.length - 1]).toBe('You: m29');
    expect(out).not.toContain('m5');
  });
});
```

Add `formatTranscript` and `MAX_CHAT_HISTORY` to the existing import at the top of that file:

```ts
import {
  renderBrief, automationChatTurn, buildDryRunPrompt, classifyDryRun,
  formatTranscript, MAX_CHAT_HISTORY,
} from './aide-automation';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/core -- aide-automation.test.ts`
Expected: FAIL — `formatTranscript is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/aide-automation.ts`, immediately above `const CHAT_TURN_PROMPT` (line 73), add:

```ts
/** Newest turns kept verbatim in the prompt. The draft is a complete state
 *  snapshot, so older turns carry tone and nothing else — dropping them keeps
 *  a long conversation from growing the prompt until it times out. */
export const MAX_CHAT_HISTORY = 24;

export function formatTranscript(
  messages: AutomationChatMessage[], max = MAX_CHAT_HISTORY,
): string {
  const recent = messages.slice(-max);
  const lines = recent.map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`);
  if (recent.length < messages.length) lines.unshift('[earlier turns omitted]');
  return lines.join('\n');
}
```

Then in `CHAT_TURN_PROMPT`, replace line 89:

```ts
${messages.map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n')}
```

with:

```ts
${formatTranscript(messages)}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/core -- aide-automation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts
git commit -m "feat(core): cap the authoring transcript sent to Aide"
```

---

### Task 4: Chat-turn time budget and prompt cleanup

**Files:**
- Modify: `packages/core/src/aide-automation.ts:96` (prompt rule 5), `:101-107` (`automationChatTurn`)
- Test: `packages/core/src/aide-automation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/aide-automation.test.ts`:

```ts
describe('automationChatTurn budget', () => {
  const ctx2 = {
    workspaces: ['default'], teams: [], tz: 'Asia/Shanghai',
    nowIso: 'Fri Jul 11 2026 10:00:00 GMT+0800', mode: 'create' as const,
  };

  it('asks for a 90s budget and one retry, and survives one transient failure', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const runner = async (req: AgentRequest): Promise<AgentResponse> => {
      seen.push(req.signal);
      if (++calls === 1) throw new Error('socket hang up');
      return { success: true, output: '{"reply":"ok"}' } as AgentResponse;
    };
    const t = await automationChatTurn([{ role: 'user', text: 'hi' }], {}, ctx2, {
      agent: 'claude-code', runner, retryDelayMs: 0,
    });
    expect(t.reply).toBe('ok');
    expect(calls).toBe(2);
  });

  it('lets an explicit caller budget win', async () => {
    let calls = 0;
    const runner = async (_req: AgentRequest): Promise<AgentResponse> => {
      calls++;
      throw new Error('socket hang up');
    };
    await expect(automationChatTurn([{ role: 'user', text: 'hi' }], {}, ctx2, {
      agent: 'claude-code', runner, retries: 0,
    })).rejects.toThrow('socket hang up');
    expect(calls).toBe(1);
  });
});
```

Add `AgentRequest`/`AgentResponse` to the existing type import if they are not already there — they are, at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/core -- aide-automation.test.ts`
Expected: FAIL — the first test's runner is called once and the turn rejects (no retry configured yet).

- [ ] **Step 3: Implement the budget**

In `packages/core/src/aide-automation.ts`, replace line 107 inside `automationChatTurn`:

```ts
  const res = await runAideJson<Record<string, unknown>>(CHAT_TURN_PROMPT(messages, draft, context), opts);
```

with:

```ts
  // Authoring turns are interactive but not latency-critical, and the failure
  // mode users hit is a slow model, not a wrong one: give each attempt a wide
  // budget and one automatic retry. An explicit caller value still wins.
  const res = await runAideJson<Record<string, unknown>>(CHAT_TURN_PROMPT(messages, draft, context), {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 90_000,
    retries: opts.retries ?? 1,
  });
```

- [ ] **Step 4: Drop the dead prompt clause**

In `CHAT_TURN_PROMPT` rule 5 (line 96), delete the final sentence. The rule ends after `...do not repeat the full plan or manual-schedule reminder.` — remove:

```
 If the conversation contains dry-run findings ("Dry run found things to pin down") that the user has not yet fully addressed, treat them as open questions: keep ready=false until each is resolved.
```

Dry-run findings no longer appear in the authoring transcript at all, so the clause referenced a mechanism that no longer exists.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w @codey/core -- aide-automation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts
git commit -m "feat(core): widen the authoring chat turn budget and retry once"
```

---

### Task 5: Shared execution fingerprint

**Files:**
- Modify: `packages/core/src/aide-automation.ts`
- Test: `packages/core/src/aide-automation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/aide-automation.test.ts`:

```ts
describe('executionFingerprint', () => {
  const base = {
    target: { kind: 'prompt' as const, workspaceName: 'default' },
    brief: 'Post five items.',
    params: { a: '1', b: '2' },
  };

  it('ignores everything that does not change what runs', () => {
    expect(executionFingerprint({ ...base, brief: '  Post five items.  ' }))
      .toBe(executionFingerprint(base));
    expect(executionFingerprint({ ...base, params: { b: '2', a: '1' } }))
      .toBe(executionFingerprint(base));
    expect(executionFingerprint({ ...base, target: { kind: 'prompt', workspaceName: 'default', agent: undefined } }))
      .toBe(executionFingerprint(base));
  });

  it('changes when the target, brief or params change', () => {
    expect(executionFingerprint({ ...base, brief: 'Post six items.' })).not.toBe(executionFingerprint(base));
    expect(executionFingerprint({ ...base, params: { a: '9', b: '2' } })).not.toBe(executionFingerprint(base));
    expect(executionFingerprint({ ...base, target: { kind: 'prompt', workspaceName: 'blog' } }))
      .not.toBe(executionFingerprint(base));
    expect(executionFingerprint({ ...base, target: { kind: 'prompt', workspaceName: 'default', model: 'opus' } }))
      .not.toBe(executionFingerprint(base));
  });

  it('treats an empty draft as its own fingerprint', () => {
    expect(executionFingerprint({})).toBe(executionFingerprint({ params: {} }));
  });
});
```

Add `executionFingerprint` to the import list at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/core -- aide-automation.test.ts`
Expected: FAIL — `executionFingerprint is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/aide-automation.ts`, below `renderBrief` (after line 20), add:

```ts
/** What actually executes, canonicalized. Renaming, rescheduling or changing
 *  the notify mode leaves this unchanged, so those edits never cost the user a
 *  fresh dry run. Key order and surrounding whitespace are normalized because
 *  a spurious difference here spawns a real agent process. */
export function executionFingerprint(a: {
  target?: AutomationTarget;
  brief?: string;
  params?: Record<string, string>;
}): string {
  const t = a.target;
  const target = !t ? null
    : t.kind === 'team'
      ? { kind: 'team', workspaceName: t.workspaceName, teamName: t.teamName }
      : { kind: 'prompt', workspaceName: t.workspaceName, agent: t.agent ?? null, model: t.model ?? null };
  const params = Object.entries(a.params ?? {}).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify({ target, brief: a.brief?.trim() ?? '', params });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/core -- aide-automation.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole core suite**

Run: `npm test -w @codey/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts
git commit -m "feat(core): export a canonical execution fingerprint"
```

---

### Task 6: Strip verification from the authoring session

**Files:**
- Modify: `packages/gateway/src/automations/chat.ts`
- Test: `packages/gateway/src/automations/chat.test.ts:110-255`

- [ ] **Step 1: Write the failing test**

In `packages/gateway/src/automations/chat.test.ts`, delete the entire block of check-related tests (everything from the `it('...')` at line 121 through the end of the `describe` that contains `resolveCheck` and `retryCheck` — i.e. every test referencing `onReadyTransition`, `retryCheck` or `resolveCheck`, lines ~118-255). Replace that block with:

```ts
describe('finalize', () => {
  it('returns the draft for any complete draft, with no verification step', () => {
    const { mgr } = manager();
    const { sessionId } = mgr.start('edit', COMPLETE, 'a1');
    expect(mgr.finalize(sessionId)).toEqual({
      mode: 'edit', sourceAutomationId: 'a1', draft: COMPLETE,
    });
  });

  it('finalizes a create session as soon as the draft is complete', () => {
    const { mgr } = manager();
    const { sessionId } = mgr.start('create');
    expect(() => mgr.finalize(sessionId)).toThrow(/incomplete/);
    mgr.patch(sessionId, COMPLETE);
    expect(mgr.finalize(sessionId).draft).toEqual(COMPLETE);
  });

  it('rejects an unknown session', () => {
    const { mgr } = manager();
    expect(() => mgr.finalize('nope')).toThrow(/Unknown automation chat session/);
  });
});
```

Also update the `start` test at line 36: `expect(step.check).toBe('clean')` must be deleted (`ChatStep.check` no longer exists).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/gateway -- automations/chat.test.ts`
Expected: FAIL — `mgr.finalize(sessionId)` throws "Automation must pass its unattended check".

- [ ] **Step 3: Implement**

In `packages/gateway/src/automations/chat.ts`:

Replace the import on line 2 with:

```ts
import type { AutomationChatContext, AutomationChatTurn, AutomationDraft, AutomationChatMessage } from '@codey/core';
```

Replace `ChatManagerDeps` (lines 4-16) with:

```ts
export interface ChatManagerDeps {
  /** Bound automationChatTurn with AideOptions pre-applied. */
  turn: (
    messages: AutomationChatMessage[],
    draft: AutomationDraft,
    context: AutomationChatContext,
  ) => Promise<AutomationChatTurn>;
  /** Live grounding lists - re-read per turn so new workspaces/teams appear. */
  context: () => Omit<AutomationChatContext, 'mode'>;
  now?: () => number;
}
```

Replace `ChatStep` (lines 18-29) with:

```ts
export interface ChatStep {
  sessionId: string;
  reply: string;
  /** Full draft after the patch - drives the live summary panel. */
  draft: AutomationDraft;
  suggestions: string[];
  /** The assistant has no open questions. Drives copy only - saving is gated
   *  by draftComplete alone. */
  ready: boolean;
  /** Live choices used by the structured editor. */
  context: Omit<AutomationChatContext, 'mode' | 'nowIso'>;
}
```

Replace `Session` (lines 31-41) with:

```ts
interface Session {
  mode: 'create' | 'edit';
  messages: AutomationChatMessage[];
  draft: AutomationDraft;
  inFlight: boolean;
  touchedAt: number;
  sourceAutomationId?: string;
}
```

In `start()`, replace lines 82-93 (the `ready` comment block through `return this.step(...)`) with:

```ts
    this.sessions.set(sessionId, s);
    // A persisted automation is already a complete, reviewed baseline, so an
    // edit session opens ready without forcing an otherwise empty turn.
    return this.step(sessionId, s, reply, [], mode === 'edit' && draftComplete(s.draft));
```

In `send()`, delete line 115 (`this.reconcileCheck(sessionId, s, ready);`).

In `patch()`, delete line 135 (`this.reconcileCheck(sessionId, s, ready);`).

Delete `retryCheck()` (lines 139-149), `resolveCheck()` (lines 165-178) and `reconcileCheck()` (lines 180-195) entirely.

Replace `finalize()` (lines 151-163) with:

```ts
  /** Return a server-owned draft. A complete draft is always saveable: the
   *  dry run is advisory and runs after the automation is persisted. */
  finalize(sessionId: string): {
    mode: 'create' | 'edit'; sourceAutomationId?: string; draft: AutomationDraft;
  } {
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown automation chat session: ${sessionId}`);
    if (!draftComplete(s.draft)) throw new Error('Automation draft is incomplete');
    return { mode: s.mode, sourceAutomationId: s.sourceAutomationId, draft: { ...s.draft } };
  }
```

Replace `step()` (lines 197-203) with:

```ts
  private step(sessionId: string, s: Session, reply: string, suggestions: string[], ready: boolean): ChatStep {
    const { workspaces, teams, agents, models, tz } = this.deps.context();
    return {
      sessionId, reply, draft: { ...s.draft }, suggestions, ready,
      context: { workspaces, teams, agents, models, tz },
    };
  }
```

Delete the local `executionFingerprint` function (lines 211-213) — Task 5 moved it to core.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/gateway -- automations/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/chat.ts packages/gateway/src/automations/chat.test.ts
git commit -m "refactor(gateway): the authoring session no longer verifies anything"
```

---

### Task 7: Key dry runs by automation id

**Files:**
- Modify: `packages/gateway/src/automations/dry-run.ts`
- Test: `packages/gateway/src/automations/dry-run.test.ts`

The generation mechanics are unchanged; this is the rename that makes the new ownership readable.

- [ ] **Step 1: Update the test to the new key**

In `packages/gateway/src/automations/dry-run.test.ts`, replace every `'s1'` / `'s2'` literal with `'a1'` / `'a2'`, and in the first test change the `onResult` assertion to:

```ts
    expect(onResult).toHaveBeenCalledWith('a1', { status: 'clean' });
```

- [ ] **Step 2: Run the test to verify it still passes**

Run: `npm test -w @codey/gateway -- automations/dry-run.test.ts`
Expected: PASS (the manager is key-agnostic; this step just confirms the rename is behavior-neutral).

- [ ] **Step 3: Rename the parameters and correct the docs**

In `packages/gateway/src/automations/dry-run.ts`:

Replace the `onResult` doc + signature (line 12-13) with:

```ts
  /** Delivered once per surviving run; superseded/cancelled runs are silent. */
  onResult: (automationId: string, verdict: DryRunVerdict) => void;
```

Replace the class doc (lines 17-22) with:

```ts
/**
 * Fire-and-forget dry-runs keyed by automation id. At most one verdict is
 * delivered per automation generation: a newer start() or a cancel() makes any
 * in-flight run's result be dropped on arrival (the underlying agent process is
 * not killed - the adapter's own timeout bounds it). Runs are advisory and
 * start only after the automation is already persisted.
 */
```

Rename the `sessionId` parameter to `automationId` in `start()`, `cancel()` and `run()`, and update the `cancel()` doc to:

```ts
  /** Drop any in-flight run's result (superseded edit, or deleted automation). */
```

and the log line inside `run()` to:

```ts
      this.deps.log?.(`dry-run for ${automationId} superseded; verdict dropped`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/gateway -- automations/dry-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/dry-run.ts packages/gateway/src/automations/dry-run.test.ts
git commit -m "refactor(gateway): key dry runs by automation id"
```

---

### Task 8: Save-time check decision

**Files:**
- Create: `packages/gateway/src/automations/check.ts`
- Test: `packages/gateway/src/automations/check.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/automations/check.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { needsRecheck, verdictToCheck } from './check';

const base = {
  target: { kind: 'prompt' as const, workspaceName: 'default' },
  brief: 'Post five items.',
  params: { count: '5' },
};

describe('needsRecheck', () => {
  it('always checks a newly created automation', () => {
    expect(needsRecheck(undefined, base)).toBe(true);
  });

  it('skips a rename / reschedule / notify-only edit', () => {
    expect(needsRecheck(base, { ...base })).toBe(false);
  });

  it('checks when the brief, params or target change', () => {
    expect(needsRecheck(base, { ...base, brief: 'Post six items.' })).toBe(true);
    expect(needsRecheck(base, { ...base, params: { count: '6' } })).toBe(true);
    expect(needsRecheck(base, { ...base, target: { kind: 'prompt', workspaceName: 'blog' } })).toBe(true);
  });
});

describe('verdictToCheck', () => {
  it('maps each verdict onto the persisted shape', () => {
    expect(verdictToCheck({ status: 'clean' }, 7)).toEqual({ status: 'clean', at: 7 });
    expect(verdictToCheck({ status: 'gaps', questions: ['Which account?'] }, 7))
      .toEqual({ status: 'gaps', questions: ['Which account?'], at: 7 });
    expect(verdictToCheck({ status: 'error', message: 'agent died' }, 7))
      .toEqual({ status: 'error', detail: 'agent died', at: 7 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/gateway -- automations/check.test.ts`
Expected: FAIL — cannot resolve `./check`.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/automations/check.ts`:

```ts
// packages/gateway/src/automations/check.ts
import { executionFingerprint } from '@codey/core';
import type { AutomationCheck, AutomationTarget, DryRunVerdict } from '@codey/core';

/** Just enough of an automation (or draft) to know what would execute. */
export interface Executable {
  target?: AutomationTarget;
  brief?: string;
  params?: Record<string, string>;
}

/** A background dry run costs a real agent process, so it is warranted only
 *  when what executes actually changed. `prev` absent = freshly created. */
export function needsRecheck(prev: Executable | undefined, next: Executable): boolean {
  if (!prev) return true;
  return executionFingerprint(prev) !== executionFingerprint(next);
}

/** Map a dry-run verdict onto the automation's persisted advisory field. */
export function verdictToCheck(verdict: DryRunVerdict, at: number): AutomationCheck {
  if (verdict.status === 'clean') return { status: 'clean', at };
  if (verdict.status === 'gaps') return { status: 'gaps', questions: verdict.questions, at };
  return { status: 'error', detail: verdict.message, at };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/gateway -- automations/check.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/check.ts packages/gateway/src/automations/check.test.ts
git commit -m "feat(gateway): decide at save time whether a dry run is warranted"
```

---

### Task 9: Persist the check without faking an edit

**Files:**
- Modify: `packages/gateway/src/automations/store.ts:125-136`
- Test: `packages/gateway/src/automations/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/automations/store.test.ts`, inside the `describe('definitions', ...)` block:

```ts
  it('writes and clears the advisory check without touching updatedAt', () => {
    const a = store.create(draft(), 111);
    store.setCheck(a.id, { status: 'pending', at: 222 });
    expect(store.get(a.id)!.check).toEqual({ status: 'pending', at: 222 });
    expect(store.get(a.id)!.updatedAt).toBe(111);

    store.setCheck(a.id, { status: 'gaps', questions: ['Which account?'], at: 333 });
    expect(store.get(a.id)!.check).toEqual({ status: 'gaps', questions: ['Which account?'], at: 333 });

    store.setCheck(a.id, undefined);
    expect(store.get(a.id)!.check).toBeUndefined();
    expect(JSON.stringify(store.get(a.id))).not.toContain('check');
  });

  it('setCheck on an unknown id is a no-op', () => {
    expect(() => store.setCheck('nope', { status: 'clean', at: 1 })).not.toThrow();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/gateway -- automations/store.test.ts`
Expected: FAIL — `store.setCheck is not a function`.

- [ ] **Step 3: Implement**

In `packages/gateway/src/automations/store.ts`, add `AutomationCheck` to the type import on line 4:

```ts
import type { Automation, AutomationCheck, AutomationRun } from '@codey/core';
```

and add this method immediately after `recordLastFired` (line 136):

```ts
  /** Advisory dry-run verdict. Not a user edit, so updatedAt is untouched —
   *  a background verdict must not make the one-pager claim the automation
   *  was just modified. `undefined` removes the field (user dismissed it). */
  setCheck(id: string, check: AutomationCheck | undefined): void {
    const raw = this.loadRaw();
    const cur = raw.automations.find(a => a.id === id);
    if (!cur) return; // unknown id — don't rewrite the file for a no-op
    if (check) cur.check = check;
    else delete cur.check;
    this.writeRaw(raw);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/gateway -- automations/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/store.ts packages/gateway/src/automations/store.test.ts
git commit -m "feat(gateway): persist the advisory check on the automation record"
```

---

### Task 10: Gateway wiring

**Files:**
- Modify: `packages/gateway/src/gateway.ts:1485-1516`, `:1633-1652`, `:1685-1693`, `:1739-1764`

No new unit test: this file has no Gateway-construction test harness, and the two decisions it makes (`needsRecheck`, `verdictToCheck`) are already covered by Task 8. Verification is the type build in Task 15 plus the manual smoke test.

- [ ] **Step 1: Update imports**

In `packages/gateway/src/gateway.ts`, add to the existing `@codey/core` type import the names `AutomationCheck`, and import the new helpers next to the `DryRunManager` import (line 10):

```ts
import { DryRunManager } from './automations/dry-run';
import { needsRecheck, verdictToCheck } from './automations/check';
```

- [ ] **Step 2: Rewire the managers**

Replace lines 1501 and 1514 in `initAutomations()`:

```ts
      onResult: (sessionId, verdict) => this.onDryRunResult(sessionId, verdict),
```
becomes
```ts
      onResult: (automationId, verdict) => this.onDryRunResult(automationId, verdict),
```

and delete the `onReadyTransition` line entirely, so the `AutomationChatManager` construction ends with the `context: () => ({...})` property.

- [ ] **Step 3: Replace the verdict delivery path**

Replace `onDryRunResult` (lines 1633-1652) with:

```ts
  /** Emit an automation event without letting a listener failure escape. */
  private emitAutomationEvent(ev: AutomationEvent): void {
    try { this.automationEventListener?.(ev); }
    catch { /* swallow - listener failures must not break automations */ }
  }

  /** Start an advisory background dry run for an already-persisted automation. */
  private startAutomationCheck(a: Automation): void {
    const check: AutomationCheck = { status: 'pending', at: Date.now() };
    this.automationStore?.setCheck(a.id, check);
    this.emitAutomationEvent({ type: 'automation-check', automationId: a.id, check });
    this.automationDryRuns?.start(a.id, {
      name: a.name, target: a.target, brief: a.brief, params: a.params,
    });
  }

  /** Persist a dry-run verdict and tell the renderer. Purely advisory - the
   *  automation has been saved and runnable since before this started. */
  private onDryRunResult(automationId: string, verdict: DryRunVerdict): void {
    // Deleted while the run was in flight: nothing left to annotate.
    if (!this.automationStore?.get(automationId)) return;
    const check = verdictToCheck(verdict, Date.now());
    this.automationStore.setCheck(automationId, check);
    this.emitAutomationEvent({ type: 'automation-check', automationId, check });
  }
```

- [ ] **Step 4: Cancel in-flight runs on delete**

In `deleteAutomation` (line 1685), add as the first statement of the method body, after the `if (!a) throw` guard:

```ts
    this.automationDryRuns?.cancel(id);
```

- [ ] **Step 5: Replace the save path and the retry method**

Delete `retryAutomationChatCheck` (lines 1745-1747) and replace `saveAutomationChat` (lines 1748-1760) with:

```ts
  saveAutomationChat(sessionId: string): Automation {
    const { mode, sourceAutomationId, draft } = this.requireAutomationChats().finalize(sessionId);
    const payload = {
      name: draft.name!.trim(), target: draft.target!, brief: draft.brief!.trim(),
      params: draft.params ?? {}, schedule: draft.schedule,
      report: { notify: draft.notify ?? 'none' },
    };
    // Read the pre-edit record first: the fingerprint comparison is what keeps
    // a rename or reschedule from costing the user a fresh agent run.
    const prev = mode === 'edit' ? this.automationStore?.get(sourceAutomationId!) : undefined;
    const saved = mode === 'edit'
      ? this.updateAutomation(sourceAutomationId!, payload)
      : this.createAutomation({ ...payload, enabled: true });
    this.cancelAutomationChat(sessionId);
    if (needsRecheck(prev, saved)) this.startAutomationCheck(saved);
    return saved;
  }

  /** Re-arm the advisory dry run for a saved automation (banner "Re-run"). */
  recheckAutomation(id: string): void {
    const a = this.requireAutomationStore().get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    this.startAutomationCheck(a);
  }

  /** Clear the advisory check and drop any in-flight verdict (banner "Dismiss"). */
  dismissAutomationCheck(id: string): void {
    this.automationDryRuns?.cancel(id);
    this.requireAutomationStore().setCheck(id, undefined);
    this.emitAutomationEvent({ type: 'automation-check', automationId: id });
  }
```

- [ ] **Step 6: Stop cancelling dry runs by session id**

Replace `cancelAutomationChat` (lines 1761-1764) with:

```ts
  cancelAutomationChat(sessionId: string): void {
    this.automationChats?.cancel(sessionId);
  }
```

Closing the authoring panel must no longer kill the dry run — that is the whole point of persisting the verdict.

- [ ] **Step 7: Typecheck the gateway package**

Run: `npm run build -w @codey/gateway`
Expected: compiles (this requires `npm run build -w @codey/core` to have been run after Task 5).

- [ ] **Step 8: Run the gateway suite**

Run: `npm test -w @codey/gateway`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): run the dry run after save, advisory and persisted"
```

---

### Task 11: IPC surface

**Files:**
- Modify: `codey-mac/electron/main.ts:2720-2732`
- Modify: `codey-mac/electron/preload.ts:52-53`
- Modify: `codey-mac/src/codey-api.d.ts:196-199`

- [ ] **Step 1: Replace the main-process handlers**

In `codey-mac/electron/main.ts`, replace the `automations:chat:retryCheck` and `automations:chat:save` handlers (lines 2720-2732) with:

```ts
  ipcMain.handle('automations:chat:save', async (_e, sessionId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.saveAutomationChat(sessionId)
    })
  )

  ipcMain.handle('automations:recheck', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      inProcessGateway.recheckAutomation(id)
    })
  )

  ipcMain.handle('automations:dismissCheck', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      inProcessGateway.dismissAutomationCheck(id)
    })
  )
```

- [ ] **Step 2: Update the preload bridge**

In `codey-mac/electron/preload.ts`, replace lines 52-53 with:

```ts
    chatSave: (sessionId: string) => ipcRenderer.invoke('automations:chat:save', sessionId),
    recheck: (id: string) => ipcRenderer.invoke('automations:recheck', id),
    dismissCheck: (id: string) => ipcRenderer.invoke('automations:dismissCheck', id),
```

- [ ] **Step 3: Update the renderer typings**

In `codey-mac/src/codey-api.d.ts`, replace lines 196-197 (`chatRetryCheck` and `chatSave`) with:

```ts
        chatSave: (sessionId: string) => Promise<IpcResult<Automation>>
        recheck: (id: string) => Promise<IpcResult<void>>
        dismissCheck: (id: string) => Promise<IpcResult<void>>
```

- [ ] **Step 4: Confirm nothing else references the removed channel**

Run: `grep -rn "retryCheck\|allowUnchecked" codey-mac/electron codey-mac/src packages --include='*.ts' --include='*.tsx'`
Expected: only `codey-mac/src/components/AutomationChatCreate.tsx` (fixed in Task 13).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): recheck/dismiss IPC, ungated chat save"
```

---

### Task 12: Banner model helper

**Files:**
- Modify: `codey-mac/src/components/automationsModel.ts:221-234`
- Test: `codey-mac/src/components/automationsModel.test.ts:3`, `:223-230`

- [ ] **Step 1: Write the failing test**

In `codey-mac/src/components/automationsModel.test.ts`, replace the `checkLabel` import name with `checkBanner` on line 3, and replace the whole `describe('checkLabel', ...)` block (lines 223-230) with:

```ts
describe('checkBanner', () => {
  it('shows nothing for a clean or absent check', () => {
    expect(checkBanner(undefined)).toBeNull()
    expect(checkBanner({ status: 'clean', at: 1 })).toBeNull()
  })

  it('announces a run in progress without offering actions', () => {
    expect(checkBanner({ status: 'pending', at: 1 }))
      .toEqual({ tone: 'neutral', title: 'Dry run in progress…', actions: false })
  })

  it('lists the questions for gaps', () => {
    expect(checkBanner({ status: 'gaps', questions: ['Which account?'], at: 1 })).toEqual({
      tone: 'warn', title: 'Dry run found things to pin down',
      questions: ['Which account?'], actions: true,
    })
  })

  it('keeps an errored run low-key — it is usually the environment, not the setup', () => {
    expect(checkBanner({ status: 'error', detail: 'agent died', at: 1 })).toEqual({
      tone: 'muted', title: 'Last dry run didn’t complete', actions: true,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w codey-mac -- automationsModel.test.ts`
Expected: FAIL — `checkBanner is not a function`.

- [ ] **Step 3: Implement**

In `codey-mac/src/components/automationsModel.ts`, replace lines 221-234 (`CheckTone` and `checkLabel`) with:

```ts
export type CheckTone = 'neutral' | 'warn' | 'muted'

export interface CheckBanner {
  tone: CheckTone
  title: string
  /** Present for 'gaps'. */
  questions?: string[]
  /** Re-run / Dismiss only make sense once a run has finished. */
  actions: boolean
}

/** One-pager banner for the advisory dry run. A clean or absent check renders
 *  nothing — the banner exists to raise problems, not to congratulate. */
export function checkBanner(check: AutomationCheck | undefined): CheckBanner | null {
  switch (check?.status) {
    case 'pending':
      return { tone: 'neutral', title: 'Dry run in progress…', actions: false }
    case 'gaps':
      return { tone: 'warn', title: 'Dry run found things to pin down', questions: check.questions ?? [], actions: true }
    case 'error':
      return { tone: 'muted', title: 'Last dry run didn’t complete', actions: true }
    default:
      return null
  }
}
```

and add the type import at the top of the file, next to the existing `isScheduled` import (line 4):

```ts
import type { AutomationCheck } from '../../../packages/core/src/types/automation'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w codey-mac -- automationsModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/automationsModel.ts codey-mac/src/components/automationsModel.test.ts
git commit -m "feat(mac): model the advisory check banner"
```

---

### Task 13: One-button authoring panel

**Files:**
- Modify: `codey-mac/src/components/AutomationChatCreate.tsx`

- [ ] **Step 1: Drop the check state**

In `codey-mac/src/components/AutomationChatCreate.tsx`:

Replace the model import (lines 7-10) with:

```ts
import {
  draftComplete, formatHHMM, NOTIFY_OPTIONS, scheduleSummary,
  slotsToSchedule, type NotifyMode, type ScheduleSlotInput,
} from './automationsModel'
```

Delete the `check`, `checkDetail` and `saveAfterCheckRef` declarations (lines 41-42 and 51), and delete `applyCheck` (lines 54-57).

Replace `applyStep` (lines 59-66) with:

```ts
  const applyStep = (step: ChatStep, appendReply = false) => {
    setDraft(step.draft)
    setContext(step.context)
    setSuggestions(step.suggestions)
    setReady(step.ready)
    if (appendReply && step.reply) setMessages(prev => [...prev, { role: 'assistant', text: step.reply }])
  }
```

In `begin()` delete `setCheckDetail(undefined)` (line 84).

Delete the whole `chat-check` subscription effect (lines 94-102) and the `saveAfterCheckRef` effect (lines 215-225).

In `send()` delete `setCheck(undefined)` (line 115); in `patchDraft()` delete `setCheck(undefined)` (line 136).

- [ ] **Step 2: Replace the save path**

Replace `finishSave`, `save` and `retryCheck` (lines 154-213) with a single function:

```ts
  const save = async () => {
    const sid = sessionIdRef.current
    if (!sid || saving) return
    setSaving(true)
    try {
      // Flush the visible form before finalizing. Text fields intentionally
      // keep local state while typing, so relying only on blur can otherwise
      // race a click on Save and persist the previous value.
      unwrap(await window.codey.automations.chatPatch(sid, {
        name: (draft.name?.trim() || null) as any,
        target: (draft.target ?? null) as any,
        schedule: (draft.schedule ?? null) as any,
        notify: draft.notify ?? 'none',
        brief: (draft.brief?.trim() || null) as any,
        params: draft.params ?? {},
      }))
      unwrap(await window.codey.automations.chatSave(sid))
      sessionIdRef.current = null
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setSaving(false)
    }
  }
```

- [ ] **Step 3: Show the real failure and the way around it**

Replace the `failedText` bubble (lines 285-289) with:

```ts
          {failedText && (
            <div style={{ ...bubbleAssistant, borderColor: C.red, color: C.red }}>
              {failedError ?? 'That message did not go through.'}
              {' '}<button style={inlineButton} onClick={() => void send(failedText, true)}>Retry</button>
              <div style={{ color: C.fg3, marginTop: 6 }}>You can also fill in the form on the right and save directly.</div>
            </div>
          )}
```

Add the state next to `failedText` (line 46):

```ts
  const [failedError, setFailedError] = useState<string | null>(null)
```

and set it in `send()`: replace the `catch` block (lines 120-126) with:

```ts
    } catch (e: any) {
      const message = e?.message ?? String(e)
      if (/Unknown automation chat session/.test(message)) {
        setSessionLost(true)
        setInput(trimmed)
      } else {
        setFailedText(trimmed)
        setFailedError(message)
      }
    }
```

and clear it where `setFailedText(null)` is called at the start of `send()` (line 114):

```ts
    setFailedText(null)
    setFailedError(null)
```

- [ ] **Step 4: Collapse the footer to one button**

Replace the whole `<footer>` block (lines 465-494) with:

```tsx
        <footer style={footerStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {missing.length > 0
              ? <div style={statusMuted}>Complete: {missing.join(', ')}</div>
              : <div style={statusMuted}>Ready to save</div>}
          </div>
          <button
            style={pillButton('primary')}
            disabled={!draftComplete(draft) || saving || locked}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create automation'}
          </button>
        </footer>
```

Delete the now-unused `checkInfo` line (line 267). `ready` stays in state — it still drives nothing beyond assistant copy, and the panel keeps reading it from each step.

- [ ] **Step 5: Confirm nothing check-shaped survives in this file**

Run: `grep -n "check\|Check" codey-mac/src/components/AutomationChatCreate.tsx`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/AutomationChatCreate.tsx
git commit -m "feat(mac): a complete draft saves immediately"
```

---

### Task 14: Advisory banner on the one-pager

**Files:**
- Modify: `codey-mac/src/components/AutomationOnePager.tsx`
- Modify: `codey-mac/src/components/AutomationsView.tsx:238-246`

- [ ] **Step 1: Import the helper**

In `codey-mac/src/components/AutomationOnePager.tsx`, add `checkBanner` to the model import (lines 7-10):

```ts
import {
  scheduleSummary, slotsToSchedule, nextRunAt, humanizeDelta,
  knobsFrom, knobsEqual, NOTIFY_OPTIONS, checkBanner, type Knobs, type NotifyMode,
} from './automationsModel'
```

- [ ] **Step 2: Add the actions**

Add next to `saveIcon` (after line 209):

```tsx
  const recheck = async () => {
    try {
      unwrap(await window.codey.automations.recheck(id))
      void refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const dismissCheck = async () => {
    try {
      unwrap(await window.codey.automations.dismissCheck(id))
      void refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }
```

- [ ] **Step 3: Render the banner**

Add just below the closing `</header>` (line 243), above the parked banner:

```tsx
      {(() => {
        const banner = checkBanner(a.check)
        if (!banner) return null
        return (
          <div style={checkBannerStyle(banner.tone)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: C.fg, fontSize: 12, fontWeight: 700 }}>{banner.title}</div>
              {banner.questions && banner.questions.length > 0 && (
                <ul style={checkQuestionList}>
                  {banner.questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              )}
            </div>
            {banner.actions && (
              <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
                <button style={pillButton('ghost')} onClick={() => void recheck()}>Re-run</button>
                <button style={pillButton('ghost')} onClick={() => void dismissCheck()}>Dismiss</button>
              </div>
            )}
          </div>
        )
      })()}
```

- [ ] **Step 4: Add the styles**

Next to `parkedBanner`'s definition in the style block at the bottom of the file, add:

```ts
/** The error tone is deliberately quiet: a failed dry run almost always means
 *  an environment problem, not a misconfigured automation. */
const checkBannerStyle = (tone: 'neutral' | 'warn' | 'muted'): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 12px',
  padding: '10px 12px', borderRadius: 10,
  border: `1px solid ${tone === 'warn' ? C.yellow : C.border}`,
  background: tone === 'warn' ? C.surface2 : C.surface,
  opacity: tone === 'muted' ? 0.8 : 1,
})
const checkQuestionList: React.CSSProperties = {
  margin: '4px 0 0', paddingLeft: 18, color: C.fg2, fontSize: 12, lineHeight: 1.5,
}
```

- [ ] **Step 5: Mark `gaps` rows in the list**

In `codey-mac/src/components/AutomationsView.tsx`, inside `nameRow` (after the health pill on line 245), add:

```tsx
                      {a.check?.status === 'gaps' && (
                        <span style={gapsMarker} title="Dry run found things to pin down">!</span>
                      )}
```

and add the style next to `statusPill` in that file's style block:

```ts
const gapsMarker: React.CSSProperties = {
  width: 15, height: 15, borderRadius: 999, flexShrink: 0,
  display: 'grid', placeItems: 'center',
  background: C.yellow, color: C.bg, fontSize: 10, fontWeight: 800,
}
```

- [ ] **Step 6: Run the Mac suite**

Run: `npm test -w codey-mac`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/AutomationOnePager.tsx codey-mac/src/components/AutomationsView.tsx
git commit -m "feat(mac): surface the advisory dry-run verdict on the automation"
```

---

### Task 15: Full verification

**Files:** none modified unless a failure demands it.

- [ ] **Step 1: Build every package**

Run: `npm run build`
Expected: exit 0, no TypeScript errors. Any error here is a leftover reference to `chat-check`, `ChatStep.check`, `allowUnchecked` or `retryCheck` — fix it in the file that owns it and re-run.

- [ ] **Step 2: Run every suite**

Run: `npm test`
Expected: all three workspaces pass.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no non-English characters flagged in source.

- [ ] **Step 4: Confirm the removed vocabulary is gone**

Run: `grep -rn "chat-check\|allowUnchecked\|retryCheck\|resolveCheck\|onReadyTransition\|checkLabel\|reconcileCheck" packages/core/src packages/gateway/src codey-mac/src codey-mac/electron`
Expected: no matches.

- [ ] **Step 5: Commit anything the verification changed**

```bash
git status --short
# only if there are changes:
git add -A && git commit -m "chore: fix up cross-package references after the check refactor"
```

- [ ] **Step 6: Manual smoke test (requires the Mac app)**

This is the part unit tests cannot cover. Run the app, then:

1. Open Automations → New. Fill in name, workspace and instructions **entirely by hand**, without sending a chat message. The button reads "Create automation" and is enabled; clicking it returns to the list **immediately** — no "Checking…" state.
2. The new automation's one-pager shows "Dry run in progress…" and, minutes later, either no banner (clean) or a warning banner listing questions.
3. Open Edit setup, change only the name, save. No new banner appears and "Updated" is the only thing that changed.
4. Open Edit setup, change the instructions, save. A fresh "Dry run in progress…" banner appears.
5. On a `gaps` banner, `Dismiss` removes it and the list marker; `Re-run` puts it back into pending.
6. Send a chat message and let it fail (e.g. stop the model backend): the red bubble names the real error and offers the form as a way through.

Record the outcome in the PR description — per `docs/superpowers/specs/2026-08-13-automation-authoring-friction-design.md`, the dry-run path has historically been the one place where unit tests looked green and the real app did not.
