# Conversational Automation Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the form-based automation editor with a chat-driven creation flow (chat + live summary panel) and a one-pager view (Overview/Runs tabs) for existing automations, powered by a free-form Aide loop that replaces the scripted `InterviewManager`.

**Architecture:** A new `automationChatTurn` prompt in `@codey/core` (one `runAideJson` call per user turn returning `{reply, draftPatch, suggestions, ready}`), an in-memory `AutomationChatManager` in `@codey/gateway` holding per-session transcript + draft, three new IPC endpoints, and two new renderer components. Tasks 1–7 are purely additive so the tree stays green; Task 8 swaps the UI over and deletes the interview flow end to end.

**Tech Stack:** TypeScript (ES2020/CommonJS, strict), Vitest, Electron IPC, React renderer. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-11-conversational-automation-authoring-design.md`

**Environment (read first):**
- Node: the default node v16 cannot run vitest/tsc. Prefix every build/test command with `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"` (or `source ~/.nvm/nvm.sh && nvm use 22.17.1`).
- Work from repo root `/Users/jackou/Documents/projects/codey`, branch `feat/automation-chat-authoring`.
- `codey-mac` consumes `@codey/core`/`@codey/gateway` from `dist/` — after changing those packages run `npm run build -w @codey/core -w @codey/gateway` before touching mac code.
- The working tree contains unrelated staged changes (playbooks rename, ToolsView). Commit ONLY the files each task names — never `git add -A`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/aide-automation.ts` | Modify | Add `AutomationDraft`/`AutomationChatContext`/`AutomationChatTurn` types + `automationChatTurn` prompt/parse (Task 8 deletes the three interview functions) |
| `packages/core/src/aide-automation.test.ts` | Modify | Add `automationChatTurn` tests (Task 8 deletes interview tests) |
| `packages/gateway/src/automations/chat.ts` | Create | `AutomationChatManager` session state machine |
| `packages/gateway/src/automations/chat.test.ts` | Create | Manager unit tests |
| `packages/gateway/src/gateway.ts` | Modify | Wire chat manager; `startAutomationChat`/`sendAutomationChat`/`cancelAutomationChat` (Task 8 removes interview wiring) |
| `codey-mac/electron/main.ts` | Modify | `automations:chat:*` IPC handlers (Task 8 removes `automations:interview:*`) |
| `codey-mac/electron/preload.ts` | Modify | `chatStart`/`chatSend`/`chatCancel` bridge (Task 8 removes interview bridge) |
| `codey-mac/src/codey-api.d.ts` | Modify | Renderer types for the new bridge |
| `codey-mac/src/components/automationsModel.ts` | Modify | Add `nextRunAt`, `humanizeDelta`, `draftComplete` (Task 8 removes `canSchedule`) |
| `codey-mac/src/components/automationsModel.test.ts` | Modify | Tests for the new helpers |
| `codey-mac/src/components/AutomationChatCreate.tsx` | Create | Chat column + live summary panel (create & edit modes) |
| `codey-mac/src/components/AutomationOnePager.tsx` | Create | Overview/Runs tabs, parked banner, inline knobs; absorbs RunHistory |
| `codey-mac/src/components/AutomationsView.tsx` | Rewrite (Task 8) | List + panel switch; `AutomationEditor` and inline `RunHistory` deleted |
| `packages/gateway/src/automations/interview.ts` (+ test if present) | Delete (Task 8) | Superseded |

---

### Task 1: `automationChatTurn` in `@codey/core`

**Files:**
- Modify: `packages/core/src/aide-automation.ts` (append at end of file)
- Test: `packages/core/src/aide-automation.test.ts` (append at end of file)

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/aide-automation.test.ts`. The file already defines an `aide(output)` helper at the top that builds `AideOptions` with a canned runner — reuse it. Add `automationChatTurn` to the existing import from `./aide-automation`.

```ts
describe('automationChatTurn', () => {
  const ctx = {
    workspaces: ['default', 'blog'], teams: ['news'],
    tz: 'Asia/Shanghai', nowIso: 'Fri Jul 11 2026 10:00:00 GMT+0800', mode: 'create' as const,
  };
  const msgs = [{ role: 'user' as const, text: 'post AI news daily' }];

  it('parses a full turn', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"Which workspace?","draftPatch":{"name":"AI news"},"suggestions":["default","blog"],"ready":false}'));
    expect(t).toEqual({
      reply: 'Which workspace?', draftPatch: { name: 'AI news' },
      suggestions: ['default', 'blog'], ready: false,
    });
  });

  it('defaults optional fields', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide('{"reply":"ok"}'));
    expect(t.draftPatch).toEqual({});
    expect(t.suggestions).toEqual([]);
    expect(t.ready).toBe(false);
  });

  it('keeps null patch values (they mean "clear the field") and drops unknown keys', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide(
      '{"reply":"ok","draftPatch":{"schedule":null,"bogus":1}}'));
    expect(t.draftPatch).toEqual({ schedule: null });
  });

  it('drops non-string suggestions', async () => {
    const t = await automationChatTurn(msgs, {}, ctx, aide('{"reply":"ok","suggestions":["a",1,""]}'));
    expect(t.suggestions).toEqual(['a']);
  });

  it('throws on malformed JSON and on an empty reply', async () => {
    await expect(automationChatTurn(msgs, {}, ctx, aide('not json'))).rejects.toThrow();
    await expect(automationChatTurn(msgs, {}, ctx, aide('{"reply":"  "}'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH" && npm test -w @codey/core -- aide-automation`
Expected: FAIL — `automationChatTurn` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/aide-automation.ts`. Add to the top-of-file imports: `import type { AutomationSchedule, AutomationTarget } from './types';` (keep the existing imports).

```ts
// ---- Conversational authoring (chat-driven creation/edit) ----

/** Partial automation assembled turn-by-turn during the authoring chat. */
export interface AutomationDraft {
  name?: string;
  target?: AutomationTarget;
  schedule?: AutomationSchedule;
  notify?: boolean;
  brief?: string;
  params?: Record<string, string>;
}

export interface AutomationChatContext {
  workspaces: string[];
  teams: string[];
  /** User's IANA zone, e.g. "Asia/Shanghai". */
  tz: string;
  /** Current local datetime string, for resolving "every morning" etc. */
  nowIso: string;
  mode: 'create' | 'edit';
}

export interface AutomationChatTurn {
  reply: string;
  /** Shallow-merged into the session draft; a null value clears the field. */
  draftPatch: Partial<AutomationDraft>;
  /** Quick-reply chips (may be empty). */
  suggestions: string[];
  /** All required fields present + no open questions. */
  ready: boolean;
}

export type ChatMessage = { role: 'user' | 'assistant'; text: string };

const DRAFT_KEYS = new Set(['name', 'target', 'schedule', 'notify', 'brief', 'params']);

const CHAT_TURN_PROMPT = (
  messages: ChatMessage[], draft: AutomationDraft, ctx: AutomationChatContext,
) => `You are Codey's automation-setup assistant, configuring an UNATTENDED automation through a short chat. It will run on a schedule with nobody available to answer questions, so every ambiguity that would block a run must be resolved during this conversation.

Environment:
- Workspaces (the only valid choices): ${ctx.workspaces.join(', ') || '(none)'}
- Teams (optional execution target): ${ctx.teams.join(', ') || '(none)'}
- User timezone: ${ctx.tz}; current time: ${ctx.nowIso}
- Mode: ${ctx.mode === 'edit' ? 'editing an existing automation - only change what the user asks to change' : 'creating a new automation'}

Current draft (gathered so far):
${JSON.stringify(draft, null, 2)}

Conversation so far:
${messages.map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n')}

Your job this turn:
1. Update the draft with anything the user's latest message settles. draftPatch contains ONLY fields that changed; set a field to null to clear it. Draft fields: name (short title), target ({"kind":"prompt","workspaceName":"..."} or {"kind":"team","teamName":"...","workspaceName":"..."}), schedule ({"hour":0-23,"minute":0-59,"daysOfWeek":[0-6] optional,"tz":"${ctx.tz}"} or null for manual-only), notify (boolean), brief (string), params (object of string values).
2. Reply conversationally and ask about ONE thing at a time - the next most important gap: missing specifics, choices, accounts/handles, formats, limits, edge cases (e.g. "what if there is nothing to report?"), and eventually scheduling. Never ask about something the user already answered, even in passing. If the user revises an earlier choice, just patch it and move on.
3. When the answer space is enumerable (workspace names, team names, times, yes/no), offer 2-5 short suggestions the user can tap. Only ever suggest workspace/team names that appear in the environment above.
4. Maintain the brief as you learn: a frozen, fully self-contained instruction block for an unattended agent - no "the user said", concrete values, edge-case handling, expected output. Surface tweakable knobs as {{placeholder}} in the brief with current values in params.
5. Set ready=true ONLY when name, target and brief are complete, scheduling has been explicitly discussed (a concrete schedule or deliberately manual-only), and you have no open questions. On that turn, reply with a short summary of the full plan and invite the user to confirm or change anything. If they then request changes, patch the draft and set ready accordingly.

Respond with ONLY this JSON:
{"reply":"...","draftPatch":{},"suggestions":[],"ready":false}`;

export async function automationChatTurn(
  messages: ChatMessage[],
  draft: AutomationDraft,
  context: AutomationChatContext,
  opts: AideOptions,
): Promise<AutomationChatTurn> {
  const res = await runAideJson<Record<string, unknown>>(CHAT_TURN_PROMPT(messages, draft, context), opts);
  const reply = res && typeof res.reply === 'string' ? res.reply.trim() : '';
  if (!reply) throw new Error('Aide returned no reply');
  const draftPatch: Partial<AutomationDraft> = {};
  if (res!.draftPatch && typeof res!.draftPatch === 'object' && !Array.isArray(res!.draftPatch)) {
    for (const [k, v] of Object.entries(res!.draftPatch as Record<string, unknown>)) {
      if (DRAFT_KEYS.has(k)) (draftPatch as Record<string, unknown>)[k] = v;
    }
  }
  const suggestions = Array.isArray(res!.suggestions)
    ? (res!.suggestions as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 6)
    : [];
  return { reply, draftPatch, suggestions, ready: res!.ready === true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @codey/core -- aide-automation`
Expected: PASS (existing tests + 5 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/aide-automation.ts packages/core/src/aide-automation.test.ts
git commit -m "feat(core): automationChatTurn - free-form authoring chat turn via Aide"
```

---

### Task 2: `AutomationChatManager` in `@codey/gateway`

**Files:**
- Create: `packages/gateway/src/automations/chat.ts`
- Test: `packages/gateway/src/automations/chat.test.ts`

- [ ] **Step 1: Build core so gateway sees the new types**

Run: `npm run build -w @codey/core`
Expected: exit 0.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/gateway/src/automations/chat.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AutomationChatManager, SESSION_TTL_MS } from './chat';
import type { AutomationChatTurn } from '@codey/core';

const CTX = { workspaces: ['default'], teams: ['news'], tz: 'Asia/Shanghai', nowIso: 'now' };

const turnResult = (over: Partial<AutomationChatTurn> = {}): AutomationChatTurn =>
  ({ reply: 'ok', draftPatch: {}, suggestions: [], ready: false, ...over });

const manager = (turn: any = vi.fn(async () => turnResult()), now?: () => number) => ({
  mgr: new AutomationChatManager({ turn, context: () => CTX, now }),
  turn,
});

describe('start', () => {
  it('create mode opens with a fixed prompt and empty draft', () => {
    const { mgr } = manager();
    const step = mgr.start('create');
    expect(step.reply).toMatch(/What should this automation do/);
    expect(step.draft).toEqual({});
    expect(step.ready).toBe(false);
    expect(step.suggestions).toEqual([]);
  });

  it('edit mode seeds the initial draft and asks what to change', () => {
    const { mgr } = manager();
    const step = mgr.start('edit', { name: 'News', brief: 'b' });
    expect(step.reply).toMatch(/What should change/);
    expect(step.draft).toEqual({ name: 'News', brief: 'b' });
  });
});

describe('send', () => {
  it('passes transcript + draft + mode to the turn and merges the patch', async () => {
    const turn = vi.fn(async () => turnResult({
      reply: 'Which workspace?', draftPatch: { name: 'News' }, suggestions: ['default'],
    }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    const step = await mgr.send(sessionId, 'post news');
    expect(turn).toHaveBeenCalledWith(
      [
        { role: 'assistant', text: expect.stringMatching(/What should this automation do/) },
        { role: 'user', text: 'post news' },
      ],
      {},
      { ...CTX, mode: 'create' },
    );
    expect(step.draft).toEqual({ name: 'News' });
    expect(step.suggestions).toEqual(['default']);
  });

  it('commits the transcript only on success - a failed turn retries without duplication', async () => {
    const turn = vi.fn()
      .mockRejectedValueOnce(new Error('aide down'))
      .mockResolvedValueOnce(turnResult({ reply: 'hi' }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    await expect(mgr.send(sessionId, 'post news')).rejects.toThrow('aide down');
    await mgr.send(sessionId, 'post news');
    const transcript = turn.mock.calls[1][0];
    expect(transcript.filter((m: any) => m.role === 'user')).toHaveLength(1);
  });

  it('a null patch value clears the field', async () => {
    const turn = vi.fn(async () => turnResult({ draftPatch: { schedule: null } as any }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('edit', { schedule: { hour: 9, minute: 0, tz: 'UTC' } });
    const step = await mgr.send(sessionId, 'make it manual');
    expect('schedule' in step.draft).toBe(false);
  });

  it('rejects a second send while one is in flight', async () => {
    let release!: (v: AutomationChatTurn) => void;
    const turn = vi.fn(() => new Promise<AutomationChatTurn>(res => { release = res; }));
    const { mgr } = manager(turn);
    const { sessionId } = mgr.start('create');
    const first = mgr.send(sessionId, 'one');
    await expect(mgr.send(sessionId, 'two')).rejects.toThrow(/in flight/);
    release(turnResult());
    await first;
  });

  it('throws for unknown or cancelled sessions', async () => {
    const { mgr } = manager();
    await expect(mgr.send('nope', 'x')).rejects.toThrow(/Unknown/);
    const { sessionId } = mgr.start('create');
    mgr.cancel(sessionId);
    await expect(mgr.send(sessionId, 'x')).rejects.toThrow(/Unknown/);
  });

  it('sweeps idle sessions past the TTL', async () => {
    let now = 1000;
    const { mgr } = manager(vi.fn(async () => turnResult()), () => now);
    const { sessionId } = mgr.start('create');
    now += SESSION_TTL_MS + 1;
    mgr.start('create'); // any entry point sweeps
    await expect(mgr.send(sessionId, 'x')).rejects.toThrow(/Unknown/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w @codey/gateway -- automations/chat`
Expected: FAIL — cannot resolve `./chat`.

- [ ] **Step 4: Implement**

```ts
// packages/gateway/src/automations/chat.ts
import { randomUUID } from 'crypto';
import type { AutomationChatContext, AutomationChatTurn, AutomationDraft, ChatMessage } from '@codey/core';

export interface ChatManagerDeps {
  /** Bound automationChatTurn with AideOptions pre-applied. */
  turn: (
    messages: ChatMessage[],
    draft: AutomationDraft,
    context: AutomationChatContext,
  ) => Promise<AutomationChatTurn>;
  /** Live grounding lists - re-read per turn so new workspaces/teams appear. */
  context: () => Omit<AutomationChatContext, 'mode'>;
  now?: () => number;
}

export interface ChatStep {
  sessionId: string;
  reply: string;
  /** Full draft after the patch - drives the live summary panel. */
  draft: AutomationDraft;
  suggestions: string[];
  ready: boolean;
}

interface Session {
  mode: 'create' | 'edit';
  messages: ChatMessage[];
  draft: AutomationDraft;
  inFlight: boolean;
  touchedAt: number;
}

export const SESSION_TTL_MS = 30 * 60_000;

const OPENER: Record<'create' | 'edit', string> = {
  create: "What should this automation do? Describe it in your own words - I'll ask about anything that needs pinning down before it can run unattended.",
  edit: 'What should change about this automation?',
};

/** Drives one authoring chat. Sessions are in-memory only - an authoring
 *  session is interactive Mac-app state, not a persisted run. */
export class AutomationChatManager {
  private sessions = new Map<string, Session>();

  constructor(private deps: ChatManagerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Lazy TTL sweep - no timers; runs on every entry point. */
  private sweep(): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) {
      if (s.touchedAt < cutoff && !s.inFlight) this.sessions.delete(id);
    }
  }

  /** Fixed opener - no Aide call, so opening the panel is instant. */
  start(mode: 'create' | 'edit', initialDraft: AutomationDraft = {}): ChatStep {
    this.sweep();
    const sessionId = randomUUID();
    const reply = OPENER[mode];
    const s: Session = {
      mode,
      messages: [{ role: 'assistant', text: reply }],
      draft: { ...initialDraft },
      inFlight: false,
      touchedAt: this.now(),
    };
    this.sessions.set(sessionId, s);
    return { sessionId, reply, draft: { ...s.draft }, suggestions: [], ready: false };
  }

  async send(sessionId: string, text: string): Promise<ChatStep> {
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown automation chat session: ${sessionId}`);
    if (s.inFlight) throw new Error('A turn is already in flight for this session');
    s.inFlight = true;
    try {
      // The user message is committed only after the turn succeeds, so a
      // failed Aide call can be retried by resending the same text.
      const turn = await this.deps.turn(
        [...s.messages, { role: 'user', text }],
        s.draft,
        { ...this.deps.context(), mode: s.mode },
      );
      s.messages.push({ role: 'user', text }, { role: 'assistant', text: turn.reply });
      applyDraftPatch(s.draft, turn.draftPatch);
      s.touchedAt = this.now();
      return { sessionId, reply: turn.reply, draft: { ...s.draft }, suggestions: turn.suggestions, ready: turn.ready };
    } finally {
      s.inFlight = false;
    }
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Shallow merge; an explicit null clears the field. */
function applyDraftPatch(draft: AutomationDraft, patch: Partial<AutomationDraft>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete (draft as Record<string, unknown>)[k];
    else (draft as Record<string, unknown>)[k] = v;
  }
}
```

Note: `ChatMessage` must be exported from core (it is, from Task 1).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @codey/gateway -- automations/chat`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/automations/chat.ts packages/gateway/src/automations/chat.test.ts
git commit -m "feat(gateway): AutomationChatManager - session state for authoring chat"
```

---

### Task 3: Wire the chat manager into `Codey` (additive)

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (imports ~line 9, field ~line 82, `initAutomations` ~line 892, public API ~line 1010)

The `InterviewManager` stays wired until Task 8 — this task only adds.

- [ ] **Step 1: Add imports**

Next to `import { InterviewManager } from './automations/interview';` (line ~9):

```ts
import { AutomationChatManager, ChatStep } from './automations/chat';
```

Add `automationChatTurn` to the existing `@codey/core` import that already contains `generateAutomationQuestions`/`renderBrief` (find it with `grep -n 'generateAutomationQuestions' packages/gateway/src/gateway.ts`).

- [ ] **Step 2: Add the field**

Next to `private automationInterviews?: InterviewManager;` (line ~82):

```ts
private automationChats?: AutomationChatManager;
```

- [ ] **Step 3: Construct in `initAutomations`**

Immediately after the `this.automationInterviews = new InterviewManager({...});` block (line ~892-896):

```ts
    this.automationChats = new AutomationChatManager({
      turn: (messages, draft, context) => automationChatTurn(messages, draft, context, this.getAideOptions()),
      context: () => ({
        workspaces: this.getWorkspaceList(),
        teams: Object.keys(this.configManager?.getTeams() ?? {}),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        nowIso: new Date().toString(),
      }),
    });
```

- [ ] **Step 4: Add the public API**

Immediately after `cancelAutomationInterview` (line ~1016-1018):

```ts
  startAutomationChat(mode: 'create' | 'edit', automationId?: string): ChatStep {
    const mgr = this.requireAutomationChats();
    if (mode !== 'edit') return mgr.start('create');
    const a = this.requireAutomationStore().get(automationId ?? '');
    if (!a) throw new Error(`Automation not found: ${automationId}`);
    return mgr.start('edit', {
      name: a.name,
      target: a.target,
      schedule: a.schedule,
      notify: a.report.notify,
      brief: a.brief,
      params: a.params,
    });
  }
  sendAutomationChat(sessionId: string, text: string): Promise<ChatStep> {
    return this.requireAutomationChats().send(sessionId, text);
  }
  cancelAutomationChat(sessionId: string): void {
    this.automationChats?.cancel(sessionId);
  }
```

And next to `requireAutomationInterviews` (line ~1031):

```ts
  private requireAutomationChats(): AutomationChatManager {
    if (!this.automationChats) throw new Error('Automations not initialized (gateway not started)');
    return this.automationChats;
  }
```

- [ ] **Step 5: Build and run gateway tests**

Run: `npm run build -w @codey/core -w @codey/gateway && npm test -w @codey/gateway`
Expected: build exit 0, all gateway tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): wire AutomationChatManager into Codey public API"
```

---

### Task 4: IPC endpoints + preload bridge + renderer types (additive)

**Files:**
- Modify: `codey-mac/electron/main.ts` (after the `automations:markSeen` handler, ~line 1930)
- Modify: `codey-mac/electron/preload.ts` (inside the `automations` object, after `markSeen`, ~line 42)
- Modify: `codey-mac/src/codey-api.d.ts` (import ~line 9, `automations` block ~line 61)

- [ ] **Step 1: Add IPC handlers in `main.ts`**

Insert before the `automations:interview:start` handler (~line 1932), matching the surrounding `wrap` pattern:

```ts
  ipcMain.handle('automations:chat:start', async (_e, mode: 'create' | 'edit', automationId?: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.startAutomationChat(mode, automationId)
    })
  )

  ipcMain.handle('automations:chat:send', async (_e, sessionId: string, text: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.sendAutomationChat(sessionId, text)
    })
  )

  ipcMain.handle('automations:chat:cancel', async (_e, sessionId: string) =>
    wrap(async () => {
      inProcessGateway?.cancelAutomationChat(sessionId)
    })
  )
```

- [ ] **Step 2: Add the preload bridge**

In `codey-mac/electron/preload.ts`, after the `markSeen` line (~line 42), keeping the interview lines for now:

```ts
    chatStart: (mode: 'create' | 'edit', automationId?: string) => ipcRenderer.invoke('automations:chat:start', mode, automationId),
    chatSend: (sessionId: string, text: string) => ipcRenderer.invoke('automations:chat:send', sessionId, text),
    chatCancel: (sessionId: string) => ipcRenderer.invoke('automations:chat:cancel', sessionId),
```

- [ ] **Step 3: Add renderer types**

In `codey-mac/src/codey-api.d.ts`, next to the existing `InterviewStep` import (line ~9):

```ts
import type { ChatStep } from '../../packages/gateway/src/automations/chat'
```

In the `automations` block, after `markSeen` (keep the interview entries for now):

```ts
        chatStart: (mode: 'create' | 'edit', automationId?: string) => Promise<IpcResult<ChatStep>>
        chatSend: (sessionId: string, text: string) => Promise<IpcResult<ChatStep>>
        chatCancel: (sessionId: string) => Promise<IpcResult<void>>
```

- [ ] **Step 4: Verify codey-mac still typechecks/tests**

Run: `npm test -w codey-mac`
Expected: PASS (no new tests; confirms nothing broke).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): automations chat IPC - chatStart/chatSend/chatCancel"
```

---

### Task 5: Renderer model helpers

**Files:**
- Modify: `codey-mac/src/components/automationsModel.ts` (append)
- Test: `codey-mac/src/components/automationsModel.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `automationsModel.test.ts`; extend the import at line 3 with `nextRunAt, humanizeDelta, draftComplete`.

```ts
describe('nextRunAt', () => {
  // 2026-07-02T09:00 Asia/Shanghai (a Thursday) is 2026-07-02T01:00Z; SH has no DST.
  const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0)
  const daily = { hour: 9, minute: 0, tz: 'Asia/Shanghai' }

  it('returns the next slot today when still ahead', () => {
    expect(nextRunAt(daily, SH_9AM - 3600_000)).toBe(SH_9AM)
  })
  it('rolls to tomorrow when the slot already passed or is exactly now', () => {
    expect(nextRunAt(daily, SH_9AM)).toBe(SH_9AM + 86_400_000)
  })
  it('respects daysOfWeek', () => {
    // Thursday 08:00 with Friday-only schedule -> Friday 09:00
    expect(nextRunAt({ ...daily, daysOfWeek: [5] }, SH_9AM - 3600_000)).toBe(SH_9AM + 86_400_000)
  })
  it('returns null for manual-only', () => {
    expect(nextRunAt(undefined, SH_9AM)).toBeNull()
  })
})

describe('humanizeDelta', () => {
  it('formats minutes, hours, days', () => {
    expect(humanizeDelta(30_000)).toBe('in <1m')
    expect(humanizeDelta(5 * 60_000)).toBe('in 5m')
    expect(humanizeDelta(14 * 3600_000)).toBe('in 14h')
    expect(humanizeDelta(3 * 86_400_000)).toBe('in 3d')
  })
})

describe('draftComplete', () => {
  it('requires name, brief, and a workspace', () => {
    expect(draftComplete({})).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b' })).toBe(false)
    expect(draftComplete({ name: ' ', brief: 'b', target: { workspaceName: 'w' } })).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b', target: { workspaceName: 'w' } })).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w codey-mac -- automationsModel`
Expected: FAIL — `nextRunAt` is not exported.

- [ ] **Step 3: Implement**

Append to `automationsModel.ts`:

```ts
// ---- One-pager helpers ----

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number }
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const fmtCache = new Map<string, Intl.DateTimeFormat>()

function localParts(ms: number, tz: string): LocalParts {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  const parts: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, dayOfWeek: DOW[parts.weekday] ?? 0,
  }
}

/** Instant when the wall clock in `tz` reads y-m-d h:min (double-corrected for DST). */
function zonedInstant(y: number, mo: number, d: number, h: number, min: number, tz: string): number {
  const want = Date.UTC(y, mo - 1, d, h, min)
  let guess = want
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz)
    guess += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  }
  return guess
}

/** Next firing instant strictly after nowMs, or null for manual-only. */
export function nextRunAt(s: ScheduleLike | undefined, nowMs: number): number | null {
  if (!s) return null
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const ref = localParts(nowMs + dayOffset * 86_400_000, s.tz)
    const candidate = zonedInstant(ref.year, ref.month, ref.day, s.hour, s.minute, s.tz)
    if (candidate <= nowMs) continue
    const dow = localParts(candidate, s.tz).dayOfWeek
    if (s.daysOfWeek && s.daysOfWeek.length > 0 && !s.daysOfWeek.includes(dow)) continue
    return candidate
  }
  return null
}

export function humanizeDelta(ms: number): string {
  if (ms < 60_000) return 'in <1m'
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`
  return `in ${Math.round(ms / 86_400_000)}d`
}

export interface DraftLike {
  name?: string
  brief?: string
  target?: { workspaceName?: string }
}

/** Client-side gate for the Create/Save button in the authoring chat. */
export function draftComplete(d: DraftLike): boolean {
  return !!(d.name?.trim() && d.brief?.trim() && d.target?.workspaceName)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w codey-mac -- automationsModel`
Expected: PASS (existing + 9 new assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/automationsModel.ts codey-mac/src/components/automationsModel.test.ts
git commit -m "feat(mac): nextRunAt/humanizeDelta/draftComplete model helpers"
```

---

### Task 6: `AutomationChatCreate` component

**Files:**
- Create: `codey-mac/src/components/AutomationChatCreate.tsx`

No unit test — this is a thin view over the tested manager and helpers (repo convention: renderer logic lives in `*Model.ts`, components are untested JSX).

- [ ] **Step 1: Create the component**

```tsx
// codey-mac/src/components/AutomationChatCreate.tsx
// Chat-driven automation authoring: chat column + live summary panel.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle } from './settingsAtoms'
import { scheduleSummary, draftComplete } from './automationsModel'
import type { AutomationDraft } from '../../../packages/core/src/aide-automation'
import type { ChatStep } from '../../../packages/gateway/src/automations/chat'

interface Props {
  mode: 'create' | 'edit'
  automationId?: string
  onDone: () => void
  onCancel: () => void
  setError: (e: string | null) => void
}

interface Bubble { role: 'user' | 'assistant'; text: string }

export const AutomationChatCreate: React.FC<Props> = ({ mode, automationId, onDone, onCancel, setError }) => {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [messages, setMessages] = useState<Bubble[]>([])
  const [draft, setDraft] = useState<AutomationDraft>({})
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [sessionLost, setSessionLost] = useState(false)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  // Cancel the server-side session when the view unmounts.
  useEffect(() => () => {
    const sid = sessionIdRef.current
    if (sid) void window.codey.automations.chatCancel(sid).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const step: ChatStep = unwrap(await window.codey.automations.chatStart(mode, automationId))
        if (cancelled) { void window.codey.automations.chatCancel(step.sessionId).catch(() => {}); return }
        setSessionId(step.sessionId)
        setMessages([{ role: 'assistant', text: step.reply }])
        setDraft(step.draft)
        setSuggestions(step.suggestions)
        setReady(step.ready)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      }
    })()
    return () => { cancelled = true }
  }, [mode, automationId, setError])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, busy])

  const send = useCallback(async (text: string, isRetry = false) => {
    const sid = sessionIdRef.current
    const trimmed = text.trim()
    if (!sid || !trimmed || busy) return
    setBusy(true)
    setFailedText(null)
    setSuggestions([])
    if (!isRetry) setMessages(prev => [...prev, { role: 'user', text: trimmed }])
    try {
      const step: ChatStep = unwrap(await window.codey.automations.chatSend(sid, trimmed))
      setMessages(prev => [...prev, { role: 'assistant', text: step.reply }])
      setDraft(step.draft)
      setSuggestions(step.suggestions)
      setReady(step.ready)
    } catch (e: any) {
      // Unknown session = gateway restarted or the session hit its TTL —
      // only starting over helps. Anything else is retryable in place.
      if (/Unknown automation chat session/.test(e?.message ?? '')) {
        setSessionLost(true)
        setInput(trimmed) // keep the user's text for the restarted chat
      } else {
        setFailedText(trimmed)
      }
    } finally {
      setBusy(false)
    }
  }, [busy])

  const startOver = () => {
    // Remount-free restart: clear local state and re-run the start effect
    // by clearing the session; simplest is to reload via chatStart directly.
    setSessionLost(false)
    setMessages([])
    setDraft({})
    setSuggestions([])
    setReady(false)
    void (async () => {
      try {
        const step: ChatStep = unwrap(await window.codey.automations.chatStart(mode, automationId))
        setSessionId(step.sessionId)
        setMessages([{ role: 'assistant', text: step.reply }])
        setDraft(step.draft)
        setSuggestions(step.suggestions)
        setReady(step.ready)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      }
    })()
  }

  const submit = () => {
    const t = input.trim()
    if (t) { setInput(''); void send(t) }
  }

  const save = async () => {
    if (!draftComplete(draft) || saving) return
    setSaving(true)
    try {
      const payload = {
        name: draft.name!.trim(),
        target: draft.target!,
        brief: draft.brief!,
        params: draft.params ?? {},
        schedule: draft.schedule ?? undefined,
        report: { notify: draft.notify ?? true },
      }
      if (mode === 'edit' && automationId) {
        unwrap(await window.codey.automations.update(automationId, payload as any))
      } else {
        unwrap(await window.codey.automations.create({ ...payload, enabled: true } as any))
      }
      onDone()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setSaving(false)
    }
  }

  const targetText = draft.target
    ? draft.target.kind === 'team'
      ? `team ${draft.target.teamName} (${draft.target.workspaceName})`
      : `${draft.target.workspaceName} (prompt)`
    : undefined

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div ref={scrollRef} style={chatScroll}>
          {messages.map((m, i) => (
            <div key={i} style={m.role === 'user' ? bubbleUser : bubbleAssistant}>{m.text}</div>
          ))}
          {busy && <div style={{ ...bubbleAssistant, color: C.fg3, fontStyle: 'italic' }}>Thinking…</div>}
          {failedText !== null && (
            <div style={{ ...bubbleAssistant, border: `1px solid ${C.red}`, color: C.red }}>
              Something went wrong.{' '}
              <button style={pillButton('ghost')} onClick={() => void send(failedText, true)}>Retry</button>
            </div>
          )}
          {sessionLost && (
            <div style={{ ...bubbleAssistant, border: `1px solid ${C.red}`, color: C.red }}>
              This session expired.{' '}
              <button style={pillButton('ghost')} onClick={startOver}>Start over</button>
            </div>
          )}
          {!busy && failedText === null && suggestions.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map(sug => (
                <button key={sug} style={pillButton('ghost')} onClick={() => void send(sug)}>{sug}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '10px 20px', borderTop: `1px solid ${C.border}` }}>
          <input
            autoFocus
            style={{ ...inputStyle, flex: 1, width: 'auto' }}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder={sessionId ? 'Message…' : 'Starting…'}
            disabled={!sessionId || busy}
          />
          <button style={pillButton('ghost')} onClick={onCancel}>Cancel</button>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ color: C.fg, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
            {draft.name ?? <span style={dim}>New automation</span>}
          </div>
          <SummaryRow label="Runs" value={draft.schedule ? scheduleSummary(draft.schedule) : ready ? 'manual' : undefined} placeholder="schedule…" />
          <SummaryRow label="Where" value={targetText} placeholder="workspace…" />
          <SummaryRow label="Notify" value={draft.notify === undefined ? undefined : draft.notify ? 'on' : 'off'} placeholder="notify…" />
          {draft.params && Object.keys(draft.params).length > 0 && (
            <SummaryRow
              label="Knobs"
              value={Object.entries(draft.params).map(([k, v]) => `${k}=${v}`).join(', ')}
              placeholder=""
            />
          )}
          <div style={{ marginTop: 12 }}>
            <div style={panelLabel}>Brief</div>
            {draft.brief ? (
              <>
                <pre style={{ ...briefBox, maxHeight: briefOpen ? undefined : 96, overflow: 'hidden' }}>{draft.brief}</pre>
                <button style={{ ...pillButton('ghost'), marginTop: 4 }} onClick={() => setBriefOpen(o => !o)}>
                  {briefOpen ? 'Collapse' : 'Expand'}
                </button>
              </>
            ) : (
              <span style={dim}>synthesized as you chat…</span>
            )}
          </div>
        </div>
        {ready && draftComplete(draft) && (
          <button style={{ ...pillButton('primary'), marginTop: 10 }} disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create automation'}
          </button>
        )}
      </div>
    </div>
  )
}

const SummaryRow: React.FC<{ label: string; value?: string; placeholder: string }> = ({ label, value, placeholder }) => (
  <div style={{ display: 'flex', gap: 8, fontSize: 12, margin: '3px 0' }}>
    <span style={{ color: C.fg3, width: 56, flexShrink: 0 }}>{label}</span>
    {value ? (
      <span style={{ color: C.fg2, wordBreak: 'break-word' }}>{value}</span>
    ) : (
      <span style={dim}>{placeholder}</span>
    )}
  </div>
)

const dim: React.CSSProperties = { color: C.fg3, opacity: 0.55, fontStyle: 'italic' }

const chatScroll: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '16px 20px',
  display: 'flex', flexDirection: 'column', gap: 8,
}

const bubbleBase: React.CSSProperties = {
  maxWidth: '82%', padding: '8px 12px', borderRadius: 12,
  fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

const bubbleAssistant: React.CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-start', background: C.surface,
  border: `1px solid ${C.border}`, borderBottomLeftRadius: 4, color: C.fg,
}

const bubbleUser: React.CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-end', background: C.surface3,
  borderBottomRightRadius: 4, color: C.fg,
}

const panelStyle: React.CSSProperties = {
  width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column',
  borderLeft: `1px solid ${C.border}`, padding: '16px 16px 12px',
  overflow: 'hidden',
}

const panelLabel: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
}

const briefBox: React.CSSProperties = {
  margin: 0, padding: '8px 10px', borderRadius: 8, background: C.surface3, color: C.fg2,
  fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm test -w codey-mac`
Expected: PASS (vitest typechecks imports; no new tests). If the workspace has a `typecheck`/`build` script (check `codey-mac/package.json`), run it too.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/AutomationChatCreate.tsx
git commit -m "feat(mac): AutomationChatCreate - chat column + live summary panel"
```

---

### Task 7: `AutomationOnePager` component

**Files:**
- Create: `codey-mac/src/components/AutomationOnePager.tsx`

Absorbs the run-history UI (currently `RunHistory` inside `AutomationsView.tsx` — copied here, deleted from there in Task 8).

- [ ] **Step 1: Create the component**

```tsx
// codey-mac/src/components/AutomationOnePager.tsx
// One-pager for an existing automation: Overview / Runs tabs, parked banner,
// inline knobs. Behavioral edits go through "Edit in chat".
import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap, inputStyle } from './settingsAtoms'
import { scheduleSummary, timeOfDayToSchedule, nextRunAt, humanizeDelta } from './automationsModel'
import type { Automation, AutomationRun } from '../../../packages/core/src/types/automation'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface Props {
  id: string
  onEditInChat: () => void
  onDeleted: () => void
  setError: (e: string | null) => void
}

interface Knobs {
  params: Record<string, string>
  scheduleOn: boolean
  time: string
  days: number[]
  notify: boolean
}

const knobsFrom = (a: Automation): Knobs => ({
  params: { ...a.params },
  scheduleOn: !!a.schedule,
  time: a.schedule
    ? `${String(a.schedule.hour).padStart(2, '0')}:${String(a.schedule.minute).padStart(2, '0')}`
    : '09:00',
  days: a.schedule?.daysOfWeek ?? [],
  notify: a.report.notify,
})

export const AutomationOnePager: React.FC<Props> = ({ id, onEditInChat, onDeleted, setError }) => {
  const [a, setA] = useState<Automation | null>(null)
  const [tab, setTab] = useState<'overview' | 'runs'>('overview')
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [knobs, setKnobs] = useState<Knobs | null>(null)
  const [running, setRunning] = useState(false)
  const [savingKnobs, setSavingKnobs] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [resuming, setResuming] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    try {
      const fresh: Automation = unwrap(await window.codey.automations.get(id))
      setA(fresh)
      setKnobs(prev => prev ?? knobsFrom(fresh))
      const freshRuns: AutomationRun[] = unwrap(await window.codey.automations.history(id, 50))
      setRuns(freshRuns)
      // Viewing the one-pager counts as seeing its results.
      const toMark = freshRuns.filter(r => r.endedAt && !r.seenAt)
      await Promise.all(toMark.map(r => window.codey.automations.markSeen(id, r.runId).catch(() => {})))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [id, setError])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => window.codey.automations.onEvent(() => { void refresh() }), [refresh])

  const runNow = async () => {
    setRunning(true)
    try {
      unwrap(await window.codey.automations.runNow(id))
      void refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRunning(false)
    }
  }

  const toggleEnabled = async () => {
    if (!a) return
    try {
      unwrap(await window.codey.automations.setEnabled(id, !a.enabled))
      setA({ ...a, enabled: !a.enabled })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const del = async () => {
    if (!a || !confirm(`Delete automation "${a.name}"?`)) return
    setDeleting(true)
    try {
      unwrap(await window.codey.automations.delete(id))
      onDeleted()
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setDeleting(false)
    }
  }

  const resume = async (runId: string, option: string) => {
    if (resuming[runId]) return
    setResuming(prev => ({ ...prev, [runId]: true }))
    try {
      unwrap(await window.codey.automations.resume(id, runId, option))
      void refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setResuming(prev => ({ ...prev, [runId]: false }))
    }
  }

  const knobsDirty = !!a && !!knobs && (
    JSON.stringify(knobs.params) !== JSON.stringify(a.params) ||
    knobs.scheduleOn !== !!a.schedule ||
    (knobs.scheduleOn && (
      knobs.time !== `${String(a.schedule?.hour ?? 0).padStart(2, '0')}:${String(a.schedule?.minute ?? 0).padStart(2, '0')}` ||
      JSON.stringify(knobs.days) !== JSON.stringify(a.schedule?.daysOfWeek ?? [])
    )) ||
    knobs.notify !== a.report.notify
  )

  const saveKnobs = async () => {
    if (!a || !knobs || savingKnobs) return
    setSavingKnobs(true)
    try {
      const schedule = knobs.scheduleOn
        ? timeOfDayToSchedule(knobs.time, a.schedule?.tz ?? TZ, knobs.days.length ? knobs.days : undefined)
        : undefined
      if (knobs.scheduleOn && !schedule) throw new Error('Invalid time')
      const fresh: Automation = unwrap(await window.codey.automations.update(id, {
        params: knobs.params,
        schedule: schedule ?? undefined,
        report: { notify: knobs.notify },
      } as any))
      setA(fresh)
      setKnobs(knobsFrom(fresh))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSavingKnobs(false)
    }
  }

  if (!a) return <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 24 }}>Loading…</div>

  const next = a.schedule && a.enabled ? nextRunAt(a.schedule, Date.now()) : null
  const subtitle = a.schedule
    ? `${scheduleSummary(a.schedule)} (${a.schedule.tz})${next ? ` · next run ${humanizeDelta(next - Date.now())}` : ''}`
    : 'manual only'
  const latest = runs[0]

  return (
    <div style={{ padding: '14px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.fg, fontSize: 15, fontWeight: 600 }}>{a.name}</div>
          <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{subtitle}</div>
        </div>
        <button style={pillButton('primary')} disabled={running} onClick={() => void runNow()}>
          {running ? 'Running…' : 'Run now'}
        </button>
        <button style={pillButton('ghost')} onClick={onEditInChat}>Edit in chat</button>
        <label style={{ color: C.fg3, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={a.enabled} onChange={() => void toggleEnabled()} />
          Enabled
        </label>
        <button style={pillButton('danger')} disabled={deleting} onClick={() => void del()}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {latest?.status === 'parked' && latest.question && (
        <div style={parkedBanner}>
          <div style={{ color: C.fg, fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
            Waiting on you: {latest.question}
          </div>
          {latest.options && latest.options.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {latest.options.map(opt => (
                <button key={opt} style={pillButton('ghost')} disabled={!!resuming[latest.runId]}
                  onClick={() => void resume(latest.runId, opt)}>{opt}</button>
              ))}
            </div>
          )}
          <input
            style={{ ...inputStyle, width: '100%' }}
            placeholder={resuming[latest.runId] ? 'Resuming…' : 'Free-text answer…'}
            disabled={!!resuming[latest.runId]}
            value={answers[latest.runId] ?? ''}
            onChange={e => setAnswers(prev => ({ ...prev, [latest.runId]: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = (answers[latest.runId] ?? '').trim()
                if (v) void resume(latest.runId, v)
              }
            }}
          />
        </div>
      )}

      <div style={tabBar}>
        <button style={tabStyle(tab === 'overview')} onClick={() => setTab('overview')}>Overview</button>
        <button style={tabStyle(tab === 'runs')} onClick={() => setTab('runs')}>Runs ({runs.length})</button>
      </div>

      {tab === 'overview' && knobs && (
        <div>
          <div style={sectLabel}>What it does</div>
          <pre style={briefBox}>{a.brief}</pre>

          <div style={sectLabel}>Knobs — edit directly</div>
          {Object.entries(knobs.params).map(([k, v]) => (
            <div key={k} style={knobRow}>
              <span style={knobKey}>{k}</span>
              <input style={{ ...inputStyle, flex: 1, width: 'auto' }} value={v}
                onChange={e => setKnobs({ ...knobs, params: { ...knobs.params, [k]: e.target.value } })} />
            </div>
          ))}
          <div style={knobRow}>
            <span style={knobKey}>schedule</span>
            <input type="checkbox" checked={knobs.scheduleOn}
              onChange={e => setKnobs({ ...knobs, scheduleOn: e.target.checked })} />
            {knobs.scheduleOn && (
              <>
                <input type="time" style={inputStyle} value={knobs.time}
                  onChange={e => setKnobs({ ...knobs, time: e.target.value })} />
                <div style={{ display: 'flex', gap: 4 }}>
                  {DAY.map((d, i) => (
                    <button key={d}
                      style={{ ...pillButton(knobs.days.includes(i) ? 'primary' : 'ghost'), padding: '2px 7px', fontSize: 10 }}
                      onClick={() => setKnobs({
                        ...knobs,
                        days: knobs.days.includes(i) ? knobs.days.filter(x => x !== i) : [...knobs.days, i].sort(),
                      })}
                    >{d}</button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div style={knobRow}>
            <span style={knobKey}>notify</span>
            <input type="checkbox" checked={knobs.notify}
              onChange={e => setKnobs({ ...knobs, notify: e.target.checked })} />
          </div>
          {knobsDirty && (
            <button style={{ ...pillButton('primary'), marginTop: 8 }} disabled={savingKnobs} onClick={() => void saveKnobs()}>
              {savingKnobs ? 'Saving…' : 'Save knobs'}
            </button>
          )}

          <div style={sectLabel}>Setup</div>
          <div style={setupRow}><span style={knobKey}>Runs in</span>
            <span>{a.target.kind === 'team' ? `team ${a.target.teamName} (${a.target.workspaceName})` : `workspace ${a.target.workspaceName} (prompt)`}</span>
          </div>
          <div style={setupRow}><span style={knobKey}>Created</span><span>{new Date(a.createdAt).toLocaleString()}</span></div>
          <div style={setupRow}><span style={knobKey}>Updated</span><span>{new Date(a.updatedAt).toLocaleString()}</span></div>
        </div>
      )}

      {tab === 'runs' && (
        runs.length === 0 ? (
          <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No runs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {runs.map(r => (
              <div key={r.runId} style={cardStyle}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: C.fg, fontSize: 12, fontWeight: 600 }}>{new Date(r.startedAt).toLocaleString()}</span>
                  <span style={{ color: C.fg3, fontSize: 11 }}>{r.trigger}</span>
                  <span style={{ color: r.status === 'failed' ? C.red : C.fg3, fontSize: 11 }}>{r.status}</span>
                  {r.reportFailure && <span style={{ color: C.red, fontSize: 11 }}>report delivery failed</span>}
                </div>
                {r.status === 'parked' && r.question && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ color: C.fg2, fontSize: 12, marginBottom: 6 }}>{r.question}</div>
                    {r.options && r.options.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {r.options.map(opt => (
                          <button key={opt} style={pillButton('ghost')} disabled={!!resuming[r.runId]}
                            onClick={() => void resume(r.runId, opt)}>{opt}</button>
                        ))}
                      </div>
                    )}
                    <input
                      style={{ ...inputStyle, width: '100%' }}
                      placeholder={resuming[r.runId] ? 'Resuming…' : 'Free-text answer…'}
                      disabled={!!resuming[r.runId]}
                      value={answers[r.runId] ?? ''}
                      onChange={e => setAnswers(prev => ({ ...prev, [r.runId]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const v = (answers[r.runId] ?? '').trim()
                          if (v) void resume(r.runId, v)
                        }
                      }}
                    />
                  </div>
                )}
                {r.output && <pre style={preStyle}>{r.output}</pre>}
                {r.error && <pre style={{ ...preStyle, color: C.red }}>{r.error}</pre>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

const parkedBanner: React.CSSProperties = {
  marginTop: 12, padding: '10px 12px', borderRadius: 8,
  border: `1px solid ${C.border2}`, background: C.surface3,
}

const tabBar: React.CSSProperties = {
  display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, margin: '14px 0 12px',
}

const tabStyle = (on: boolean): React.CSSProperties => ({
  padding: '5px 14px', fontSize: 12, border: 'none', cursor: 'pointer',
  borderRadius: '6px 6px 0 0', background: on ? C.surface : 'transparent',
  color: on ? C.fg : C.fg3, fontWeight: on ? 600 : 400,
})

const sectLabel: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 16, marginBottom: 6,
}

const briefBox: React.CSSProperties = {
  margin: 0, padding: '10px 12px', borderRadius: 8, background: C.surface3, color: C.fg2,
  fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

const knobRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0',
}

const knobKey: React.CSSProperties = {
  color: C.fg3, fontSize: 12, width: 90, flexShrink: 0,
}

const setupRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'baseline', margin: '2px 0',
  color: C.fg2, fontSize: 12,
}

const cardStyle: React.CSSProperties = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px',
}

const preStyle: React.CSSProperties = {
  marginTop: 8, padding: '8px 10px', borderRadius: 6,
  background: C.codeBg ?? C.surface3, color: C.codeFg ?? C.fg2,
  fontSize: 11, lineHeight: 1.5, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
```

Note: check `codey-mac/src/theme.ts` for `C.border2`/`C.codeBg`/`C.codeFg` — `AutomationsView.tsx` already uses all three, so they exist (`codeBg`/`codeFg` via `??` fallback).

- [ ] **Step 2: Verify it compiles**

Run: `npm test -w codey-mac`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/AutomationOnePager.tsx
git commit -m "feat(mac): AutomationOnePager - Overview/Runs tabs, parked banner, inline knobs"
```

---

### Task 8: Swap `AutomationsView` over + delete the interview flow

**Files:**
- Rewrite: `codey-mac/src/components/AutomationsView.tsx`
- Modify: `codey-mac/src/codey-api.d.ts` (remove interview entries + `InterviewStep` import)
- Modify: `codey-mac/electron/preload.ts` (remove interview bridge lines 43-45)
- Modify: `codey-mac/electron/main.ts` (remove the three `automations:interview:*` handlers)
- Modify: `packages/gateway/src/gateway.ts` (remove `InterviewManager` import/field/construction, the three `*AutomationInterview` methods, `requireAutomationInterviews`)
- Delete: `packages/gateway/src/automations/interview.ts` (and `interview.test.ts` if present)
- Modify: `packages/core/src/aide-automation.ts` + test (remove interview prompts/functions/types)

- [ ] **Step 1: Rewrite `AutomationsView.tsx`**

Replace the entire file. The list panel keeps its behavior; `AutomationEditor` and `RunHistory` are gone (one-pager absorbs history); panel union per spec.

```tsx
import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import { scheduleSummary } from './automationsModel'
import { AutomationChatCreate } from './AutomationChatCreate'
import { AutomationOnePager } from './AutomationOnePager'
import type { Automation, AutomationRun, AutomationTarget } from '../../../packages/core/src/types/automation'

interface Props { onClose: () => void }

type Panel =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'chat-edit'; id: string }
  | { kind: 'view'; id: string }

export const AutomationsView: React.FC<Props> = ({ onClose }) => {
  const [panel, setPanel] = useState<Panel>({ kind: 'list' })
  const [automations, setAutomations] = useState<Automation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setAutomations(unwrap(await window.codey.automations.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // The view is open and the user is looking at it - mark finished/parked
  // runs seen as their events arrive, so they don't re-notify on next launch.
  useEffect(() => {
    const off = window.codey.automations.onEvent((ev) => {
      if (ev.type === 'run-finished' || ev.type === 'run-parked') {
        void window.codey.automations.markSeen(ev.automationId, ev.runId).catch(() => {})
      }
      void refresh()
    })
    return off
  }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && panel.kind === 'list') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, panel.kind])

  return (
    <div style={styles.backdrop} onClick={panel.kind === 'list' ? onClose : undefined}>
      <div style={styles.window} onClick={e => e.stopPropagation()}>
        <div style={styles.titleBar}>
          <button
            onClick={panel.kind === 'list' ? onClose : () => setPanel({ kind: 'list' })}
            style={styles.closeBtn}
            title={panel.kind === 'list' ? 'Close (Esc)' : 'Back'}
            aria-label={panel.kind === 'list' ? 'Close' : 'Back'}
          >
            <span style={styles.closeDot} />
          </button>
          <div style={styles.titleText}>Automations</div>
          <div style={{ width: 60 }} />
        </div>
        <div style={styles.body}>
          {error && <div style={styles.errorBanner}>{error}</div>}
          {panel.kind === 'list' && (
            <AutomationList
              automations={automations}
              loading={loading}
              onRefresh={refresh}
              onNew={() => setPanel({ kind: 'create' })}
              onOpen={(id) => setPanel({ kind: 'view', id })}
              setError={setError}
            />
          )}
          {(panel.kind === 'create' || panel.kind === 'chat-edit') && (
            <AutomationChatCreate
              key={panel.kind === 'chat-edit' ? panel.id : 'new'}
              mode={panel.kind === 'chat-edit' ? 'edit' : 'create'}
              automationId={panel.kind === 'chat-edit' ? panel.id : undefined}
              onDone={() => {
                setPanel(panel.kind === 'chat-edit' ? { kind: 'view', id: panel.id } : { kind: 'list' })
                void refresh()
              }}
              onCancel={() => setPanel(panel.kind === 'chat-edit' ? { kind: 'view', id: panel.id } : { kind: 'list' })}
              setError={setError}
            />
          )}
          {panel.kind === 'view' && (
            <AutomationOnePager
              key={panel.id}
              id={panel.id}
              onEditInChat={() => setPanel({ kind: 'chat-edit', id: panel.id })}
              onDeleted={() => { setPanel({ kind: 'list' }); void refresh() }}
              setError={setError}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ListProps {
  automations: Automation[]
  loading: boolean
  onRefresh: () => void
  onNew: () => void
  onOpen: (id: string) => void
  setError: (e: string | null) => void
}

const AutomationList: React.FC<ListProps> = ({ automations, loading, onRefresh, onNew, onOpen, setError }) => {
  const [lastStatus, setLastStatus] = useState<Record<string, AutomationRun | undefined>>({})
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(automations.map(async a => {
        try {
          const runs = unwrap(await window.codey.automations.history(a.id, 1))
          const last = runs[0]
          // Displaying the last-run status in the list counts as seeing it.
          if (last && last.endedAt && !last.seenAt) {
            void window.codey.automations.markSeen(a.id, last.runId).catch(() => {})
          }
          return [a.id, last] as const
        } catch {
          return [a.id, undefined] as const
        }
      }))
      if (!cancelled) setLastStatus(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [automations])

  const toggle = async (a: Automation) => {
    try {
      await window.codey.automations.setEnabled(a.id, !a.enabled)
      onRefresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const runNow = async (id: string) => {
    setRunningIds(prev => ({ ...prev, [id]: true }))
    try {
      unwrap(await window.codey.automations.runNow(id))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRunningIds(prev => ({ ...prev, [id]: false }))
    }
  }

  const targetLabel = (t: AutomationTarget) =>
    t.kind === 'team' ? `team: ${t.teamName} (${t.workspaceName})` : `prompt: ${t.workspaceName}`

  return (
    <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button style={pillButton('primary')} onClick={onNew}>+ New automation</button>
      </div>
      {loading ? (
        <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>Loading…</div>
      ) : automations.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '36px 20px', color: C.fg3, fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>⏱</div>
          <div style={{ fontWeight: 500, color: C.fg2, marginBottom: 4 }}>No automations yet</div>
          <div style={{ fontSize: 12 }}>
            Create one by chatting with Codey - it will pin down every detail, then run unattended.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {automations.map(a => {
            const last = lastStatus[a.id]
            return (
              <div key={a.id} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={() => void toggle(a)}
                  title={a.enabled ? 'Enabled' : 'Disabled'}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen(a.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: C.fg, fontSize: 13, fontWeight: 600 }}>{a.name}</span>
                    <span style={{ color: C.fg3, fontSize: 11 }}>{scheduleSummary(a.schedule)}</span>
                  </div>
                  <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{targetLabel(a.target)}</div>
                  {last && (
                    <div style={{ color: last.status === 'failed' ? C.red : C.fg3, fontSize: 11, marginTop: 2 }}>
                      last run: {last.status}{last.reportFailure ? ' - report delivery failed' : ''}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button style={pillButton('ghost')} onClick={() => onOpen(a.id)}>Open</button>
                  <button style={pillButton('ghost')} disabled={!!runningIds[a.id]} onClick={() => void runNow(a.id)}>
                    {runningIds[a.id] ? 'Running…' : 'Run now'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

const rowStyle: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'flex-start',
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: '12px 14px',
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(3px)',
    WebkitBackdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  window: {
    width: 'min(900px, 92%)',
    height: 'min(620px, 88%)',
    background: C.bg,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  titleBar: {
    height: 40, flexShrink: 0, display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 12px',
  },
  closeBtn: {
    width: 24, height: 24, borderRadius: '50%', border: 'none',
    background: 'transparent', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeDot: { width: 12, height: 12, borderRadius: '50%', background: C.red },
  titleText: { flex: 1, textAlign: 'center', color: C.fg, fontSize: 13, fontWeight: 600 },
  body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  errorBanner: {
    margin: '10px 20px 0', background: C.dangerBg ?? (C.red + '22'), color: C.dangerFg ?? C.red,
    padding: 10, borderRadius: 8, fontSize: 12,
  },
}
```

- [ ] **Step 2: Remove the interview bridge from the renderer types and preload**

- `codey-mac/src/codey-api.d.ts`: delete the `interviewStart`/`interviewAnswer`/`interviewCancel` lines and the `InterviewStep` import (line ~9).
- `codey-mac/electron/preload.ts`: delete the three `interview*` lines (~43-45).
- `codey-mac/electron/main.ts`: delete the three `automations:interview:*` handlers (~lines 1932-1950).

- [ ] **Step 3: Remove the interview flow from the gateway**

In `packages/gateway/src/gateway.ts`:
- Delete `import { InterviewManager } from './automations/interview';` (line ~9).
- Delete the field `private automationInterviews?: InterviewManager;` (line ~82).
- Delete the `this.automationInterviews = new InterviewManager({...});` block in `initAutomations` (~lines 892-896).
- Delete `startAutomationInterview`, `answerAutomationInterview`, `cancelAutomationInterview` (~lines 1010-1018) and `requireAutomationInterviews` (~lines 1031-1034).
- Remove `generateAutomationQuestions`, `generateAutomationFollowup`, `synthesizeAutomationBrief` from the `@codey/core` import (keep `renderBrief` and `automationChatTurn`).

Then delete the files:

```bash
git rm packages/gateway/src/automations/interview.ts
# also remove its test if it exists:
ls packages/gateway/src/automations/interview.test.ts 2>/dev/null && git rm packages/gateway/src/automations/interview.test.ts
```

- [ ] **Step 4: Remove the interview functions from core**

In `packages/core/src/aide-automation.ts` delete: `InterviewQuestion`, `InterviewAnswer`, `QUESTIONS_PROMPT`, `FOLLOWUP_PROMPT`, `SYNTHESIS_PROMPT`, `generateAutomationQuestions`, `generateAutomationFollowup`, `synthesizeAutomationBrief`. Keep `renderBrief` (execution uses it) and everything added in Task 1.

In `packages/core/src/aide-automation.test.ts` delete the `generateAutomationQuestions`, `generateAutomationFollowup`, and `synthesizeAutomationBrief` describe blocks. Keep `renderBrief` and `automationChatTurn` blocks (and the `aide` helper).

In `codey-mac/src/components/automationsModel.ts` delete `canSchedule` (the chat gate replaces it); in `automationsModel.test.ts` delete its describe block.

Verify nothing still references the deleted names:

```bash
grep -rn 'InterviewManager\|InterviewStep\|interviewStart\|interviewAnswer\|interviewCancel\|generateAutomationQuestions\|generateAutomationFollowup\|synthesizeAutomationBrief\|canSchedule' \
  packages/core/src packages/gateway/src codey-mac/src codey-mac/electron
```

Expected: no matches.

- [ ] **Step 5: Full verification**

```bash
export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"
npm run build -w @codey/core -w @codey/gateway
npm test
npm run lint
```

Expected: builds exit 0, all workspace suites PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/AutomationsView.tsx codey-mac/src/codey-api.d.ts \
  codey-mac/electron/preload.ts codey-mac/electron/main.ts \
  packages/gateway/src/gateway.ts packages/core/src/aide-automation.ts \
  packages/core/src/aide-automation.test.ts \
  codey-mac/src/components/automationsModel.ts codey-mac/src/components/automationsModel.test.ts
git commit -m "feat(mac): chat-driven automation authoring + one-pager; remove scripted interview"
```

---

## Verification checklist (manual, after Task 8)

Launch the Mac app (`npm run dev` in `codey-mac` or the project's usual dev command) and confirm:

1. Automations → **+ New automation** opens the chat; the opener appears instantly.
2. Describing a goal fills the summary panel progressively; suggestion chips are tappable; a mid-chat revision ("actually 8am") updates the panel.
3. When ready, **Create automation** appears; creating lands the automation in the list.
4. Opening an automation shows the one-pager: subtitle with next-run, Overview knobs editable (Save knobs appears when dirty), Runs tab lists history.
5. **Edit in chat** opens the chat seeded with current values; saving returns to the one-pager.
6. Killing the network / breaking the Aide mid-chat shows the Retry bubble; Retry continues without duplicated messages.
