# Automation Dry-Run + Relaxed Authoring Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relax the automation authoring chat's readiness gate (scheduling no longer required to be discussed) and add an automatic, non-blocking dry-run that verifies a brief can run unattended, feeding gaps back into the chat.

**Architecture:** The Aide prompt drops its scheduling-discussion requirement. A new `DryRunManager` in the gateway fires when a chat session's `ready` flag transitions false→true (via a new `onReadyTransition` dep on `AutomationChatManager`), executes the rendered brief with a no-act preamble through the existing agent-adapter path, classifies the output via a new Aide call, and pushes the verdict back into the session (assistant message + `check` state) and to the renderer over the existing `automation-event` IPC channel as a new `chat-check` event type. Save remains gated only on `draftComplete` — the check informs, never blocks.

**Tech Stack:** TypeScript (ES2020/CommonJS, strict), Vitest, npm workspaces (`@codey/core`, `@codey/gateway`, `codey-mac`), Electron/React (Mac app).

**Spec:** `docs/superpowers/specs/2026-07-12-automation-dry-run-design.md`

**Environment note:** The default node (v16) cannot run vitest/tsc in this repo. Before any build/test command run `nvm use v22.17.1` (or ensure `node -v` reports v22.x). All test commands below assume repo root as cwd.

---

### Task 1: Core types — `chat-check` event + check status

**Files:**
- Modify: `packages/core/src/types/automation.ts:72-77` (the `AutomationEvent` interface)

Types-only change; verified by compilation (its consumers are exercised in Tasks 4-6 tests).

- [ ] **Step 1: Replace the `AutomationEvent` interface with a discriminated union**

In `packages/core/src/types/automation.ts`, replace:

```ts
export interface AutomationEvent {
  type: 'run-started' | 'run-finished' | 'run-parked';
  automationId: string;
  runId: string;
  run?: AutomationRun;
}
```

with:

```ts
/** Status of the authoring-time dry-run check for a chat session. */
export type AutomationCheckStatus = 'pending' | 'clean' | 'gaps' | 'error';

export type AutomationEvent =
  | {
      type: 'run-started' | 'run-finished' | 'run-parked';
      automationId: string;
      runId: string;
      run?: AutomationRun;
    }
  | {
      /** Dry-run verdict for an authoring chat session (never 'pending' —
       *  pending is signaled by the ChatStep that triggered the check). */
      type: 'chat-check';
      sessionId: string;
      check: 'clean' | 'gaps' | 'error';
      questions?: string[];
      /** Assistant message the gateway appended to the session, so the
       *  renderer can show it without waiting for the next turn. */
      message?: string;
    };
```

- [ ] **Step 2: Verify everything still compiles**

Run: `npm run build -w @codey/core && npm run build -w @codey/gateway`
Expected: both compile cleanly. (`engine.ts` constructs run-event literals that match the first union member; `main.ts` in codey-mac handles events as `any` and only branches on `run-finished`/`run-parked`, so `chat-check` flows through untouched.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/automation.ts
git commit -m "feat(core): chat-check automation event + check status type"
```

---

### Task 2: Relax the Aide readiness gate

**Files:**
- Modify: `packages/core/src/aide-automation.ts:77-101` (`CHAT_TURN_PROMPT`)
- Test: `packages/core/src/aide-automation.test.ts`

The prompt currently demands "scheduling has been explicitly discussed" before `ready=true` (rule 5) and steers the conversation toward scheduling (rule 2, "and eventually scheduling"). Both go away.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/aide-automation.test.ts` (inside the file, after the existing `automationChatTurn` describe block). It uses a capturing runner in the same style as the existing `aide()` helper:

```ts
describe('CHAT_TURN_PROMPT readiness gate', () => {
  const ctx = {
    workspaces: ['default'], teams: [],
    tz: 'UTC', nowIso: 'now', mode: 'create' as const,
  };

  it('does not require scheduling discussion for ready=true', async () => {
    let captured = '';
    const opts: AideOptions = {
      agent: 'claude-code',
      runner: async (req: AgentRequest): Promise<AgentResponse> => {
        captured = req.prompt;
        return { success: true, output: '{"reply":"ok"}' } as AgentResponse;
      },
    };
    await automationChatTurn([{ role: 'user', text: 'hi' }], {}, ctx, opts);
    expect(captured).not.toMatch(/scheduling has been explicitly discussed/i);
    expect(captured).toMatch(/scheduling is NOT required for ready/i);
    expect(captured).not.toMatch(/and eventually scheduling/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @codey/core -- aide-automation`
Expected: FAIL — `captured` matches `/scheduling has been explicitly discussed/i`.

- [ ] **Step 3: Edit the prompt**

In `packages/core/src/aide-automation.ts`, in `CHAT_TURN_PROMPT`:

Rule 2 — remove the trailing scheduling steer. Change:

```
2. Reply conversationally and ask about ONE thing at a time - the next most important gap: missing specifics, choices, accounts/handles, formats, limits, edge cases (e.g. "what if there is nothing to report?"), and eventually scheduling. Never ask about something the user already answered, even in passing. If the user revises an earlier choice, just patch it and move on.
```

to:

```
2. Reply conversationally and ask about ONE thing at a time - the next most important gap: missing specifics, choices, accounts/handles, formats, limits, edge cases (e.g. "what if there is nothing to report?"). Never ask about something the user already answered, even in passing. If the user revises an earlier choice, just patch it and move on. Patch schedule whenever the user's message settles timing, but do not steer the conversation toward scheduling.
```

Rule 5 — change:

```
5. Set ready=true ONLY when name, target and brief are complete, scheduling has been explicitly discussed (a concrete schedule or deliberately manual-only), and you have no open questions. On that turn, reply with a short summary of the full plan and invite the user to confirm or change anything. If they then request changes, patch the draft and set ready accordingly.
```

to:

```
5. Set ready=true ONLY when name, target and brief are complete and you have no open questions about the task itself. Scheduling is NOT required for ready: on the ready turn, reply with a short summary of the full plan, and if no schedule is set, mention once that it will run manually unless they set a schedule now or later from the automation's page. If they then request changes, patch the draft and set ready accordingly.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @codey/core -- aide-automation`
Expected: PASS (all existing tests too — none assert the old wording).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts
git commit -m "feat(core): drop scheduling-discussion requirement from authoring readiness gate"
```

---

### Task 3: Dry-run prompt builder + verdict classifier (core)

**Files:**
- Modify: `packages/core/src/aide-automation.ts` (append at end)
- Modify: `packages/core/src/index.ts` (only if `aide-automation` exports are enumerated rather than `export *` — check first; `renderBrief`/`automationChatTurn` are already re-exported, follow the same mechanism)
- Test: `packages/core/src/aide-automation.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/aide-automation.test.ts`:

```ts
import { buildDryRunPrompt, classifyDryRun } from './aide-automation';

describe('buildDryRunPrompt', () => {
  it('renders params into the brief and wraps it in a no-act preamble', () => {
    const p = buildDryRunPrompt('Post {{count}} items.', { count: '5' });
    expect(p).toContain('Post 5 items.');
    expect(p).toMatch(/DRY RUN/);
    expect(p).toMatch(/do not perform any real actions/i);
    expect(p).not.toContain('{{count}}');
  });

  it('inlines team context when provided', () => {
    const p = buildDryRunPrompt('b', {}, '{"members":["a","b"]}');
    expect(p).toContain('{"members":["a","b"]}');
    expect(p).toMatch(/normally executed by a team/i);
  });

  it('omits the team section when absent', () => {
    expect(buildDryRunPrompt('b', {})).not.toMatch(/team/i);
  });
});

describe('classifyDryRun', () => {
  it('parses a clean verdict', async () => {
    await expect(classifyDryRun('all good', aide('{"verdict":"clean"}')))
      .resolves.toEqual({ status: 'clean' });
  });

  it('parses gaps with questions, dropping non-strings', async () => {
    await expect(classifyDryRun('out', aide('{"verdict":"gaps","questions":["Which repo?",1,""]}')))
      .resolves.toEqual({ status: 'gaps', questions: ['Which repo?'] });
  });

  it('treats gaps without questions and unknown verdicts as errors', async () => {
    await expect(classifyDryRun('out', aide('{"verdict":"gaps","questions":[]}'))).rejects.toThrow();
    await expect(classifyDryRun('out', aide('{"verdict":"maybe"}'))).rejects.toThrow();
    await expect(classifyDryRun('out', aide('not json'))).rejects.toThrow();
  });
});
```

(`aide()` is the existing helper at the top of this test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/core -- aide-automation`
Expected: FAIL — `buildDryRunPrompt` / `classifyDryRun` are not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/aide-automation.ts`:

```ts
// ---- Authoring-time dry-run (verify a brief can run unattended) ----

export type DryRunVerdict =
  | { status: 'clean' }
  | { status: 'gaps'; questions: string[] }
  | { status: 'error'; message: string };

/**
 * Wrap a rendered brief in a no-act preamble. The agent walks the brief in
 * the real workspace but must not act; its output is classified by
 * classifyDryRun. Team targets are never dispatched as teams - their
 * definitions are inlined as context instead.
 */
export function buildDryRunPrompt(
  brief: string,
  params: Record<string, string>,
  teamContext?: string,
): string {
  const rendered = renderBrief(brief, params);
  const teamBlock = teamContext
    ? `\nThis brief is normally executed by a team; its definitions, for context:\n${teamContext}\n`
    : '';
  return `DRY RUN - do not perform any real actions (no messages sent, no files changed, no external side effects). Walk through the brief below step by step as if executing it unattended. Report:
(a) anything missing or ambiguous you would need to ask a human about,
(b) anything in the workspace that contradicts the brief.
If nothing blocks unattended execution, say so explicitly.
${teamBlock}
Brief:
${rendered}`;
}

const CLASSIFY_DRY_RUN_PROMPT = (output: string) => `An agent just performed a DRY RUN of an automation brief and reported the following. Decide whether anything would block fully unattended execution.

Agent report:
${output}

Respond with ONLY this JSON:
- Nothing blocks unattended execution: {"verdict":"clean"}
- Something blocks it: {"verdict":"gaps","questions":["<one concrete question per blocking item, phrased to the automation's owner>"]}`;

/** Classify dry-run output. Throws on malformed/unusable classification -
 *  callers map a throw to an 'error' verdict, never to 'gaps'. */
export async function classifyDryRun(output: string, opts: AideOptions): Promise<DryRunVerdict> {
  const res = await runAideJson<Record<string, unknown>>(CLASSIFY_DRY_RUN_PROMPT(output), opts);
  if (res?.verdict === 'clean') return { status: 'clean' };
  if (res?.verdict === 'gaps') {
    const questions = Array.isArray(res.questions)
      ? (res.questions as unknown[]).filter((q): q is string => typeof q === 'string' && !!q.trim())
      : [];
    if (questions.length > 0) return { status: 'gaps', questions };
  }
  throw new Error('Unrecognized dry-run classification');
}
```

If `packages/core/src/index.ts` enumerates exports from `./aide-automation` (rather than `export *`), add `buildDryRunPrompt`, `classifyDryRun`, and type `DryRunVerdict` to that list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/core -- aide-automation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts packages/core/src/index.ts
git commit -m "feat(core): dry-run prompt builder + verdict classifier"
```

---

### Task 4: Chat manager — check state, ready transitions, verdict resolution

**Files:**
- Modify: `packages/gateway/src/automations/chat.ts`
- Test: `packages/gateway/src/automations/chat.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/automations/chat.test.ts`:

```ts
describe('dry-run check state', () => {
  it('sets check=pending and fires onReadyTransition only on a false->true ready transition', async () => {
    const onReadyTransition = vi.fn();
    const turn = vi.fn()
      .mockResolvedValueOnce(turnResult({ ready: true, draftPatch: { name: 'N' } }))
      .mockResolvedValueOnce(turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX, onReadyTransition });
    const { sessionId } = mgr.start('create');

    const first = await mgr.send(sessionId, 'go');
    expect(first.check).toBe('pending');
    expect(onReadyTransition).toHaveBeenCalledTimes(1);
    expect(onReadyTransition).toHaveBeenCalledWith(sessionId, { name: 'N' });

    const second = await mgr.send(sessionId, 'still ready');
    expect(onReadyTransition).toHaveBeenCalledTimes(1); // no re-trigger while ready stays true
    expect(second.check).toBe('pending');               // state carries over
  });

  it('clears check when ready drops back to false, and re-triggers on the next rise', async () => {
    const onReadyTransition = vi.fn();
    const turn = vi.fn()
      .mockResolvedValueOnce(turnResult({ ready: true }))
      .mockResolvedValueOnce(turnResult({ ready: false }))
      .mockResolvedValueOnce(turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX, onReadyTransition });
    const { sessionId } = mgr.start('create');
    await mgr.send(sessionId, 'a');
    const dropped = await mgr.send(sessionId, 'b');
    expect(dropped.check).toBeUndefined();
    await mgr.send(sessionId, 'c');
    expect(onReadyTransition).toHaveBeenCalledTimes(2);
  });

  it('resolveCheck records the verdict and appends the message to the transcript', async () => {
    const turn = vi.fn(async () => turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX });
    const { sessionId } = mgr.start('create');
    await mgr.send(sessionId, 'go');

    expect(mgr.resolveCheck(sessionId, 'clean', 'Dry run passed.')).toBe(true);
    await mgr.send(sessionId, 'next');
    const transcript = turn.mock.calls[1][0];
    expect(transcript.some((m: any) => m.role === 'assistant' && m.text === 'Dry run passed.')).toBe(true);
  });

  it('resolveCheck is rejected when the check is not pending or the session is gone', async () => {
    const turn = vi.fn(async () => turnResult({ ready: true }));
    const mgr = new AutomationChatManager({ turn, context: () => CTX });
    const { sessionId } = mgr.start('create');
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(false); // never went pending
    await mgr.send(sessionId, 'go');
    expect(mgr.resolveCheck(sessionId, 'gaps', 'q')).toBe(true);
    expect(mgr.resolveCheck(sessionId, 'clean')).toBe(false); // already resolved
    expect(mgr.resolveCheck('nope', 'clean')).toBe(false);    // unknown session
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/chat`
Expected: FAIL — `check` undefined behavior missing, `onReadyTransition` never called, `resolveCheck` not a function.

- [ ] **Step 3: Implement**

In `packages/gateway/src/automations/chat.ts`:

Import the status type (top of file):

```ts
import type { AutomationChatContext, AutomationChatTurn, AutomationDraft, AutomationChatMessage, AutomationCheckStatus } from '@codey/core';
```

Extend `ChatManagerDeps`:

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
  /** Fired when a session's ready flag rises false->true (dry-run trigger). */
  onReadyTransition?: (sessionId: string, draft: AutomationDraft) => void;
  now?: () => number;
}
```

Extend `ChatStep` and `Session`:

```ts
export interface ChatStep {
  sessionId: string;
  reply: string;
  /** Full draft after the patch - drives the live summary panel. */
  draft: AutomationDraft;
  suggestions: string[];
  ready: boolean;
  /** Dry-run check state; undefined until the first ready transition. */
  check?: AutomationCheckStatus;
}

interface Session {
  mode: 'create' | 'edit';
  messages: AutomationChatMessage[];
  draft: AutomationDraft;
  inFlight: boolean;
  touchedAt: number;
  wasReady: boolean;
  check?: AutomationCheckStatus;
}
```

In `start()`, add `wasReady: false` to the session literal. In `send()`, replace the success-path return block:

```ts
      s.messages.push({ role: 'user', text }, { role: 'assistant', text: turn.reply });
      applyDraftPatch(s.draft, turn.draftPatch);
      return { sessionId, reply: turn.reply, draft: { ...s.draft }, suggestions: turn.suggestions, ready: turn.ready };
```

with:

```ts
      s.messages.push({ role: 'user', text }, { role: 'assistant', text: turn.reply });
      applyDraftPatch(s.draft, turn.draftPatch);
      const transition = turn.ready && !s.wasReady;
      s.wasReady = turn.ready;
      if (!turn.ready) s.check = undefined;
      else if (transition) s.check = 'pending';
      if (transition) this.deps.onReadyTransition?.(sessionId, { ...s.draft });
      return { sessionId, reply: turn.reply, draft: { ...s.draft }, suggestions: turn.suggestions, ready: turn.ready, check: s.check };
```

Add after `cancel()`:

```ts
  /**
   * Record a dry-run verdict. Accepted only while the session's check is
   * still pending - a stale verdict (session gone, superseded, or ready
   * dropped meanwhile) returns false and must be discarded by the caller.
   * `message` is appended to the transcript so later turns see it.
   */
  resolveCheck(sessionId: string, check: 'clean' | 'gaps' | 'error', message?: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.check !== 'pending') return false;
    s.check = check;
    if (message) s.messages.push({ role: 'assistant', text: message });
    return true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/chat`
Expected: PASS (including all pre-existing tests — `check` is additive).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/chat.ts packages/gateway/src/automations/chat.test.ts
git commit -m "feat(gateway): chat session check state + ready-transition hook"
```

---

### Task 5: DryRunManager

**Files:**
- Create: `packages/gateway/src/automations/dry-run.ts`
- Test: `packages/gateway/src/automations/dry-run.test.ts`
- Modify: `packages/gateway/vitest.config.ts` (test include allowlist — the gateway vitest config enumerates test files explicitly; add `src/automations/dry-run.test.ts` alongside the existing automations entries)

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/automations/dry-run.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DryRunManager } from './dry-run';
import type { AutomationDraft } from '@codey/core';

const draft = (over: Partial<AutomationDraft> = {}): AutomationDraft => ({
  name: 'N',
  target: { kind: 'prompt', workspaceName: 'default' },
  brief: 'Post {{count}} items.',
  params: { count: '5' },
  ...over,
});

const flush = () => new Promise<void>(res => setTimeout(res, 0));

describe('DryRunManager', () => {
  it('executes the rendered no-act prompt in the target workspace and reports the verdict', async () => {
    const execute = vi.fn(async () => 'agent output');
    const classify = vi.fn(async () => ({ status: 'clean' as const }));
    const onResult = vi.fn();
    const mgr = new DryRunManager({ execute, classify, teamContext: () => undefined, onResult });

    mgr.start('s1', draft());
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
    const [ws, prompt] = execute.mock.calls[0];
    expect(ws).toBe('default');
    expect(prompt).toMatch(/DRY RUN/);
    expect(prompt).toContain('Post 5 items.');
    expect(classify).toHaveBeenCalledWith('agent output');
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'clean' });
  });

  it('inlines team context for team targets and never team-dispatches', async () => {
    const execute = vi.fn(async () => 'out');
    const teamContext = vi.fn(() => '{"members":["a"]}');
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute, classify: async () => ({ status: 'clean' as const }), teamContext, onResult,
    });

    mgr.start('s1', draft({ target: { kind: 'team', teamName: 'news', workspaceName: 'blog' } }));
    await flush();

    expect(teamContext).toHaveBeenCalledWith('blog', 'news');
    expect(execute.mock.calls[0][0]).toBe('blog');
    expect(execute.mock.calls[0][1]).toContain('{"members":["a"]}');
  });

  it('maps execute/classify failures to an error verdict, never gaps', async () => {
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: async () => { throw new Error('agent timed out'); },
      classify: async () => ({ status: 'clean' as const }),
      teamContext: () => undefined,
      onResult,
    });
    mgr.start('s1', draft());
    await flush();
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'error', message: 'agent timed out' });
  });

  it('an incomplete draft yields an error verdict', async () => {
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: async () => 'out',
      classify: async () => ({ status: 'clean' as const }),
      teamContext: () => undefined,
      onResult,
    });
    mgr.start('s1', { name: 'N' }); // no target/brief
    await flush();
    expect(onResult).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'error' }));
  });

  it('a newer start supersedes an in-flight run - the stale verdict is dropped', async () => {
    let releaseFirst!: (v: string) => void;
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(res => { releaseFirst = res; }))
      .mockResolvedValueOnce('second output');
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute, classify: async (o: string) => ({ status: 'gaps' as const, questions: [o] }),
      teamContext: () => undefined, onResult,
    });

    mgr.start('s1', draft());
    mgr.start('s1', draft({ brief: 'v2' }));
    await flush();
    releaseFirst('first output');
    await flush();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'gaps', questions: ['second output'] });
  });

  it('cancel drops an in-flight result', async () => {
    let release!: (v: string) => void;
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: () => new Promise<string>(res => { release = res; }),
      classify: async () => ({ status: 'clean' as const }),
      teamContext: () => undefined, onResult,
    });
    mgr.start('s1', draft());
    mgr.cancel('s1');
    release('out');
    await flush();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('independent sessions do not interfere', async () => {
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: async () => 'out',
      classify: async () => ({ status: 'clean' as const }),
      teamContext: () => undefined, onResult,
    });
    mgr.start('s1', draft());
    mgr.start('s2', draft());
    await flush();
    expect(onResult).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/dry-run`
Expected: FAIL — module `./dry-run` does not exist. (If vitest reports "no test files found", the allowlist edit from the Files list is missing — add it now.)

- [ ] **Step 3: Implement**

Create `packages/gateway/src/automations/dry-run.ts`:

```ts
// packages/gateway/src/automations/dry-run.ts
import { buildDryRunPrompt } from '@codey/core';
import type { AutomationDraft, DryRunVerdict } from '@codey/core';

export interface DryRunDeps {
  /** One-shot no-act prompt execution in a workspace (agent-adapter path). */
  execute: (workspaceName: string, prompt: string) => Promise<string>;
  /** Aide classification of the agent's dry-run report. */
  classify: (output: string) => Promise<DryRunVerdict>;
  /** Team definitions to inline for team targets (undefined = none found). */
  teamContext: (workspaceName: string, teamName: string) => string | undefined;
  /** Delivered once per surviving run; superseded/cancelled runs are silent. */
  onResult: (sessionId: string, verdict: DryRunVerdict) => void;
  log?: (msg: string) => void;
}

/**
 * Fire-and-forget dry-runs keyed by authoring-chat session. At most one
 * verdict is delivered per session generation: a newer start() or a cancel()
 * makes any in-flight run's result be dropped on arrival (the underlying
 * agent process is not killed - the adapter's own timeout bounds it).
 */
export class DryRunManager {
  private generations = new Map<string, number>();

  constructor(private deps: DryRunDeps) {}

  start(sessionId: string, draft: AutomationDraft): void {
    const gen = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, gen);
    void this.run(sessionId, gen, draft);
  }

  /** Drop any in-flight run's result (authoring UI closed / session over). */
  cancel(sessionId: string): void {
    this.generations.delete(sessionId);
  }

  private async run(sessionId: string, gen: number, draft: AutomationDraft): Promise<void> {
    let verdict: DryRunVerdict;
    try {
      if (!draft.target || !draft.brief) throw new Error('Draft is missing target or brief');
      const team = draft.target.kind === 'team'
        ? this.deps.teamContext(draft.target.workspaceName, draft.target.teamName)
        : undefined;
      const prompt = buildDryRunPrompt(draft.brief, draft.params ?? {}, team);
      const output = await this.deps.execute(draft.target.workspaceName, prompt);
      verdict = await this.deps.classify(output);
    } catch (err) {
      verdict = { status: 'error', message: (err as Error).message };
    }
    if (this.generations.get(sessionId) !== gen) {
      this.deps.log?.(`dry-run for ${sessionId} superseded; verdict dropped`);
      return;
    }
    this.generations.delete(sessionId);
    this.deps.onResult(sessionId, verdict);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/dry-run`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/automations/dry-run.ts packages/gateway/src/automations/dry-run.test.ts packages/gateway/vitest.config.ts
git commit -m "feat(gateway): DryRunManager - supersedable authoring-time dry-runs"
```

---

### Task 6: Gateway wiring

**Files:**
- Modify: `packages/gateway/src/gateway.ts` — imports (~line 1-14), field declarations (~line 82), `initAutomations()` (~line 878-901), `cancelAutomationChat()` (~line 1031), `resolveChatWorkingDir()` (~line 1051), plus two new private methods.

Gateway glue follows the existing convention of not having direct unit tests (the pieces it wires — chat manager, dry-run manager, classifier — are each unit-tested above). Verification here is compilation plus the manual smoke test in Task 8.

- [ ] **Step 1: Add imports and field**

In the big `@codey/core` import at `gateway.ts:4`, add `classifyDryRun` and type `DryRunVerdict` (and `AutomationTarget` if not already imported). Next to the `AutomationChatManager` import at line 9:

```ts
import { DryRunManager } from './automations/dry-run';
```

Next to `private automationChats?: AutomationChatManager;` (~line 82):

```ts
private automationDryRuns?: DryRunManager;
```

- [ ] **Step 2: Wire the manager in `initAutomations()`**

Replace the `this.automationChats = new AutomationChatManager({...})` block (~line 892-900) with:

```ts
    this.automationDryRuns = new DryRunManager({
      execute: (workspaceName, prompt) => this.runDryRunPrompt(workspaceName, prompt),
      classify: (output) => classifyDryRun(output, this.getAideOptions()),
      teamContext: (_workspaceName, teamName) => {
        const team = (this.configManager?.getTeams() ?? {})[teamName];
        return team ? JSON.stringify(team, null, 2) : undefined;
      },
      onResult: (sessionId, verdict) => this.onDryRunResult(sessionId, verdict),
      log: (msg) => this.logger.info(`[automations] ${msg}`),
    });
    this.automationChats = new AutomationChatManager({
      turn: (messages, draft, context) => automationChatTurn(messages, draft, context, this.getAideOptions()),
      context: () => ({
        workspaces: this.getWorkspaceList(),
        teams: Object.keys(this.configManager?.getTeams() ?? {}),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        nowIso: new Date().toString(),
      }),
      onReadyTransition: (sessionId, draft) => this.automationDryRuns!.start(sessionId, draft),
    });
```

- [ ] **Step 3: Add the two private methods**

Add after `deliverAutomationReport()` (~line 971):

```ts
  /**
   * One-shot no-act agent run for the authoring dry-run. Deliberately NOT
   * skipPermissions: headless default-deny is the belt to the preamble's
   * suspenders - the agent can read the workspace but a stray write attempt
   * is refused rather than executed.
   */
  private async runDryRunPrompt(workspaceName: string, prompt: string): Promise<string> {
    const workingDir = this.resolveWorkspaceWorkingDir(workspaceName);
    const agent = (this.config.defaultAgent ?? 'claude-code') as CodingAgent;
    const response = await this.agentFactory.run(agent, {
      prompt,
      agent,
      context: { workingDir },
    });
    if (!response.success) throw new Error(response.error || 'dry-run agent failed');
    return response.output;
  }

  /** Deliver a dry-run verdict into the chat session and to the renderer. */
  private onDryRunResult(sessionId: string, verdict: DryRunVerdict): void {
    const message = verdict.status === 'clean'
      ? 'Dry run passed - this can run unattended. Save when ready.'
      : verdict.status === 'gaps'
        ? `Dry run found things to pin down:\n${verdict.questions.map(q => `- ${q}`).join('\n')}`
        : undefined; // errors surface only in the summary-panel status
    const accepted = this.automationChats?.resolveCheck(sessionId, verdict.status, message) ?? false;
    if (!accepted) return; // session gone or check superseded
    try {
      this.automationEventListener?.({
        type: 'chat-check',
        sessionId,
        check: verdict.status,
        questions: verdict.status === 'gaps' ? verdict.questions : undefined,
        message,
      });
    } catch { /* swallow - listener failures must not break the chat */ }
  }
```

- [ ] **Step 4: Extract `resolveWorkspaceWorkingDir` and reuse it**

Replace `resolveChatWorkingDir` (~line 1051-1065) with:

```ts
  private resolveChatWorkingDir(chat: Chat): string {
    if (chat.workingDirOverride) {
      if (fs.existsSync(chat.workingDirOverride)) return chat.workingDirOverride;
      this.logger.warn(`Chat ${chat.id} workingDirOverride=${chat.workingDirOverride} is gone; falling back to workspace dir`);
    }
    return this.resolveWorkspaceWorkingDir(chat.workspaceName);
  }

  /** workspace.json workingDir if present, else the gateway working dir. */
  private resolveWorkspaceWorkingDir(workspaceName: string): string {
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, workspaceName, 'workspace.json');
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) return wsConfig.workingDir;
      } catch { /* fall through */ }
    }
    return this.workingDir;
  }
```

- [ ] **Step 5: Cancel dry-runs with the chat session**

In `cancelAutomationChat()` (~line 1031):

```ts
  cancelAutomationChat(sessionId: string): void {
    this.automationChats?.cancel(sessionId);
    this.automationDryRuns?.cancel(sessionId);
  }
```

- [ ] **Step 6: Verify compilation and full gateway suite**

Run: `npm run build -w @codey/gateway && npm test -w @codey/gateway`
Expected: build clean; all gateway tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): wire authoring dry-run - trigger, agent execution, verdict delivery"
```

---

### Task 7: Mac app — status row + event subscription

**Files:**
- Modify: `codey-mac/src/components/automationsModel.ts` (append helper)
- Modify: `codey-mac/src/components/AutomationChatCreate.tsx` (state, subscription, status row)
- Test: `codey-mac/src/components/automationsModel.test.ts`

The renderer already imports `ChatStep` from gateway source (`codey-mac/src/components/AutomationChatCreate.tsx:8`), so the new `check` field is available without IPC changes; the `automation-event` channel already reaches the renderer via `window.codey.automations.onEvent` (`codey-mac/electron/preload.ts:46-50`), and `main.ts`'s notification logic only reacts to `run-finished`/`run-parked`, so `chat-check` flows through untouched.

- [ ] **Step 1: Write the failing test for the label helper**

Append to `codey-mac/src/components/automationsModel.test.ts`:

```ts
import { checkLabel } from './automationsModel'

describe('checkLabel', () => {
  it('maps each check state to its status-row label', () => {
    expect(checkLabel('pending')).toEqual({ text: 'checking…', tone: 'dim' })
    expect(checkLabel('clean')).toEqual({ text: '✓ unattended-ready', tone: 'good' })
    expect(checkLabel('gaps')).toEqual({ text: '⚠ may need input during runs', tone: 'warn' })
    expect(checkLabel('error')).toEqual({ text: 'check failed', tone: 'dim' })
    expect(checkLabel(undefined)).toBeNull()
  })
})
```

(Match the file's existing import style — if it imports from `'./automationsModel'` with other names, extend that import instead of adding a duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w codey-mac -- automationsModel`
Expected: FAIL — `checkLabel` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `codey-mac/src/components/automationsModel.ts`:

```ts
export type CheckTone = 'dim' | 'good' | 'warn'

/** Status-row label for the authoring dry-run check; null hides the row. */
export function checkLabel(
  check: 'pending' | 'clean' | 'gaps' | 'error' | undefined,
): { text: string; tone: CheckTone } | null {
  switch (check) {
    case 'pending': return { text: 'checking…', tone: 'dim' }
    case 'clean': return { text: '✓ unattended-ready', tone: 'good' }
    case 'gaps': return { text: '⚠ may need input during runs', tone: 'warn' }
    case 'error': return { text: 'check failed', tone: 'dim' }
    default: return null
  }
}
```

(The `✓`/`⚠`/`…` literals are safe: `npm run lint` flags non-Latin *letters* and CJK punctuation only — symbols pass.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w codey-mac -- automationsModel`
Expected: PASS.

- [ ] **Step 5: Wire the component**

In `codey-mac/src/components/AutomationChatCreate.tsx`:

a. Extend the model import (line 6):

```ts
import { scheduleSummary, draftComplete, checkLabel } from './automationsModel'
```

b. Add state next to `ready` (line 26):

```ts
const [check, setCheck] = useState<ChatStep['check']>(undefined)
```

c. Every place a `ChatStep` is applied must also apply `check`. There are three: the mount effect (line ~48-54), `startOver` (line ~104-110), and `send` (line ~75, where the step from `chatSend` is applied). In each, after `setReady(step.ready)` add:

```ts
setCheck(step.check)
```

d. Subscribe to verdict pushes. Add an effect after the mount effect:

```ts
  // Dry-run verdicts arrive as chat-check events on the automation-event
  // channel (session-keyed; the draft is not saved yet, so no automationId).
  useEffect(() => {
    if (!sessionId) return
    return window.codey.automations.onEvent((ev: any) => {
      if (ev?.type !== 'chat-check' || ev.sessionId !== sessionId) return
      setCheck(ev.check)
      if (ev.message) setMessages(ms => [...ms, { role: 'assistant', text: ev.message }])
    })
  }, [sessionId])
```

e. Render the status row. In the summary panel, after the `Notify` `SummaryRow` (line ~201), add:

```ts
          {(() => {
            const cl = checkLabel(check)
            if (!cl) return null
            return (
              <SummaryRow
                label="Check"
                value={cl.text}
                placeholder=""
              />
            )
          })()}
```

If `SummaryRow` (defined lower in this file) does not support a tone/color, pass the plain text — tone styling is a nice-to-have, not spec. If it accepts a style/color prop, map `good` → `C.green`, `warn` → `C.yellow`, `dim` → `C.fg3` following the theme constants already imported as `C`.

- [ ] **Step 6: Verify the renderer builds and Mac tests pass**

Run: `npm test -w codey-mac && npm run build -w codey-mac` (if codey-mac has no `build` script, run its typecheck script — check `codey-mac/package.json` `scripts` and use the `tsc`/`typecheck` entry)
Expected: tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/automationsModel.ts codey-mac/src/components/automationsModel.test.ts codey-mac/src/components/AutomationChatCreate.tsx
git commit -m "feat(mac): dry-run check status row in authoring chat"
```

---

### Task 8: Full verification

- [ ] **Step 1: Full test suite + builds**

```bash
nvm use v22.17.1
npm test
npm run build
npm run lint
```

Expected: every workspace suite PASS, build clean, lint clean (the `✓`/`⚠` symbols in codey-mac are allowed — the lint flags non-Latin letters, not symbols).

- [ ] **Step 2: Manual smoke test (spec's end-to-end flow)**

Launch the Mac app in dev (per `codey-mac` README / dev script). In Automations → New:
1. Describe a simple automation for a real workspace; answer the chat's questions.
2. When the chat summarizes the plan (ready), confirm the summary panel shows `checking…` immediately, then flips to `✓ unattended-ready` or `⚠ may need input during runs`, and (for clean/gaps) a matching assistant message appears in the chat.
3. Confirm Save is enabled the whole time (before/during/after the check) once name+brief+workspace exist.
4. Confirm the chat never demands a schedule; save without one and verify the one-pager shows manual + editable schedule knobs.

Report actual observed behavior; if any step fails, fix before proceeding.

- [ ] **Step 3: Update the spec's status line**

Edit `docs/superpowers/specs/2026-07-12-automation-dry-run-design.md` header: `**Status:** Implemented` — commit with the final changes.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "docs(specs): mark dry-run authoring spec implemented"
```
