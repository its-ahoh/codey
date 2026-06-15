# Solo Advisor (single-chat 兜底) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-chat toggle that, in single-worker/single-model chats, escalates a stuck agent to the stronger advisor model for guidance (up to 2 rounds), then lets the original agent continue.

**Architecture:** When `chat.soloAdvisor` is on, the gateway appends an `[ASK_ADVISOR]` self-assessment instruction to the agent prompt. After the agent replies, the gateway parses for that marker; if present it calls the advisor model (reusing `gateway.json` `advisor.{agent,model}`) for plain-text guidance, surfaces it as a 🧭 info event, and re-runs the original agent with the guidance injected. Capped at 2 escalation rounds per turn; the marker is always stripped from the user-visible reply. Spec: `docs/superpowers/specs/2026-06-14-solo-advisor-design.md`.

**Tech Stack:** TypeScript (CommonJS, ES2020), npm workspaces (`@codey/core`, `@codey/gateway`), vitest (core tests), Electron + React (codey-mac). Node v22.17.1 (via nvm — v16 cannot run vitest/tsc).

---

## File Structure

- `packages/core/src/utils/ask-user.ts` — add `parseAskAdvisor` + `stripAskAdvisor` (sibling to existing `parseAsk`/`parseAskUser`).
- `packages/core/src/solo-advisor.ts` — **new**: `SoloAdvisorInput`, `buildSoloAdvisorPrompt`, `buildSoloAdvisorFollowupPrompt`.
- `packages/core/src/solo-advisor.test.ts` — **new**: unit tests for the parser/strip + prompt builders.
- `packages/core/src/index.ts` — barrel-export the new module.
- `packages/core/src/types/chat.ts` — add `soloAdvisor?: boolean` to `Chat`.
- `packages/gateway/src/chat-runner.ts` — export `SOLO_ADVISOR_INSTRUCTION` constant.
- `packages/gateway/src/gateway.ts` — `runSoloAdvisor` helper + escalation loop in the single-agent branch + prompt-injection + `SOLO_ADVISOR_MAX_ROUNDS`.
- `packages/gateway/src/chats.ts` — `ChatManager.setSoloAdvisor`.
- codey-mac IPC chain (`electron/main.ts`, `electron/preload.ts`, `src/codey-api.d.ts`, `src/services/api.ts`, `src/hooks/useChats.tsx`) + `src/components/ChatTab.tsx` toggle button.

---

## Task 1: `Chat.soloAdvisor` type field

**Files:**
- Modify: `packages/core/src/types/chat.ts:76-115` (inside `interface Chat`)

- [ ] **Step 1: Add the field**

In `packages/core/src/types/chat.ts`, inside `interface Chat`, immediately after the `model?: string;` field (around line 87), add:

```ts
  /** Per-chat "solo advisor" 兜底 toggle. When true and the chat is NOT a team,
   *  a stuck single agent (one that emits `[ASK_ADVISOR]: <reason>`) is escalated
   *  to the stronger advisor model for guidance, then re-run. Default off. */
  soloAdvisor?: boolean;
```

- [ ] **Step 2: Build core to verify the type compiles**

Run: `cd /Users/jackou/Documents/projects/codey && npm run build:core`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add packages/core/src/types/chat.ts
git commit -m "feat(core): add Chat.soloAdvisor per-chat field"
```

---

## Task 2: `parseAskAdvisor` + `stripAskAdvisor`

**Files:**
- Modify: `packages/core/src/utils/ask-user.ts` (append near the bottom, after `parseAsk`)
- Test: `packages/core/src/solo-advisor.test.ts` (create; covers parser here, builders in Task 3)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/solo-advisor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAskAdvisor, stripAskAdvisor } from './utils/ask-user';

describe('parseAskAdvisor', () => {
  it('returns null when no marker present', () => {
    expect(parseAskAdvisor('just a normal reply')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseAskAdvisor('')).toBeNull();
  });

  it('returns null when reason is blank', () => {
    expect(parseAskAdvisor('[ASK_ADVISOR]:   ')).toBeNull();
  });

  it('parses reason and preamble', () => {
    const out = 'I tried X and Y.\n[ASK_ADVISOR]: stuck on the auth flow';
    expect(parseAskAdvisor(out)).toEqual({
      preamble: 'I tried X and Y.',
      reason: 'stuck on the auth flow',
    });
  });

  it('matches the first marker in document order', () => {
    const out = 'a\n[ASK_ADVISOR]: first\n[ASK_ADVISOR]: second';
    expect(parseAskAdvisor(out)?.reason).toBe('first');
  });
});

describe('stripAskAdvisor', () => {
  it('removes the marker line and trailing whitespace', () => {
    const out = 'kept line\n[ASK_ADVISOR]: blah\n';
    expect(stripAskAdvisor(out)).toBe('kept line');
  });

  it('leaves marker-free text unchanged (sans trailing ws)', () => {
    expect(stripAskAdvisor('hello world')).toBe('hello world');
  });

  it('removes multiple marker lines', () => {
    expect(stripAskAdvisor('a\n[ASK_ADVISOR]: x\nb\n[ASK_ADVISOR]: y')).toBe('a\nb');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jackou/Documents/projects/codey && npm test -w @codey/core -- solo-advisor`
Expected: FAIL — `parseAskAdvisor`/`stripAskAdvisor` are not exported from `./utils/ask-user`.

- [ ] **Step 3: Implement the parser + strip**

At the bottom of `packages/core/src/utils/ask-user.ts`, append:

```ts
const ADVISOR_MARKER_RE = /^\s*\[ASK_ADVISOR\]\s*:\s*(.*)$/;

export interface AskAdvisor {
  /** Agent output before the marker line (joined with \n, trailing ws trimmed). */
  preamble: string;
  /** The text after `[ASK_ADVISOR]:` describing where the agent is stuck. */
  reason: string;
}

/**
 * Detect a `[ASK_ADVISOR]: <reason>` marker line in a single agent's output.
 * Returns the first marker (in document order) or null when absent/blank.
 */
export function parseAskAdvisor(output: string): AskAdvisor | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ADVISOR_MARKER_RE);
    if (!m) continue;
    const reason = m[1].trim();
    if (!reason) return null;
    const preamble = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { preamble, reason };
  }
  return null;
}

/** Remove every `[ASK_ADVISOR]: ...` marker line from output (trailing ws trimmed). */
export function stripAskAdvisor(output: string): string {
  if (!output) return output;
  return output
    .split(/\r?\n/)
    .filter(l => !ADVISOR_MARKER_RE.test(l))
    .join('\n')
    .replace(/\s+$/, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jackou/Documents/projects/codey && npm test -w @codey/core -- solo-advisor`
Expected: PASS (the `parseAskAdvisor` + `stripAskAdvisor` describe blocks green).

- [ ] **Step 5: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add packages/core/src/utils/ask-user.ts packages/core/src/solo-advisor.test.ts
git commit -m "feat(core): parseAskAdvisor + stripAskAdvisor markers"
```

---

## Task 3: Solo advisor prompt builders

**Files:**
- Create: `packages/core/src/solo-advisor.ts`
- Modify: `packages/core/src/index.ts` (add barrel export)
- Test: `packages/core/src/solo-advisor.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/solo-advisor.test.ts`:

```ts
import { buildSoloAdvisorPrompt, buildSoloAdvisorFollowupPrompt } from './solo-advisor';

describe('buildSoloAdvisorPrompt', () => {
  const input = { task: 'add login', stuckOutput: 'tried JWT', reason: 'token never validates' };

  it('includes task, stuck output, and reason', () => {
    const p = buildSoloAdvisorPrompt(input);
    expect(p).toContain('add login');
    expect(p).toContain('tried JWT');
    expect(p).toContain('token never validates');
  });

  it('instructs guidance-only (no code)', () => {
    expect(buildSoloAdvisorPrompt(input).toLowerCase()).toContain('do not write code');
  });
});

describe('buildSoloAdvisorFollowupPrompt', () => {
  it('includes the guidance and the original task', () => {
    const p = buildSoloAdvisorFollowupPrompt('token never validates', 'check the clock skew', 'add login', 'tried JWT');
    expect(p).toContain('check the clock skew');
    expect(p).toContain('add login');
    expect(p).toContain('tried JWT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jackou/Documents/projects/codey && npm test -w @codey/core -- solo-advisor`
Expected: FAIL — cannot resolve `./solo-advisor`.

- [ ] **Step 3: Implement the builders**

Create `packages/core/src/solo-advisor.ts`:

```ts
export interface SoloAdvisorInput {
  /** The user's request for the current turn. */
  task: string;
  /** The stuck agent's reply text (preamble before the [ASK_ADVISOR] marker). */
  stuckOutput: string;
  /** The reason the agent gave after [ASK_ADVISOR]:. */
  reason: string;
}

/**
 * Prompt for the stronger advisor model when a single agent is stuck. The
 * advisor gives plain-text guidance only — it never writes code (the original
 * agent stays in the driver's seat and applies the advice).
 */
export function buildSoloAdvisorPrompt(input: SoloAdvisorInput): string {
  return [
    '# Advisor (single-agent escalation)',
    '## Role',
    'You are a senior advisor. Another coding agent got stuck on a task and needs your guidance.',
    'Give concrete, actionable guidance to unblock it. Do NOT write code or full solutions — the other agent will implement. Be specific about the approach, what to check, and likely causes.',
    '## Task the agent is working on',
    input.task,
    "## The agent's latest attempt",
    input.stuckOutput || '(no output captured)',
    '## Where it says it is stuck',
    input.reason,
    '## Your guidance',
    'Respond with a short, direct set of next steps (a few sentences or a tight bullet list). No preamble.',
  ].join('\n\n');
}

/**
 * Follow-up prompt that re-runs the original agent with the advisor's guidance
 * injected. Bootstraps fresh (no session resume) so it works for every agent;
 * the agent's prior attempt and the guidance are both included inline.
 */
export function buildSoloAdvisorFollowupPrompt(
  reason: string,
  guidance: string,
  task: string,
  stuckOutput: string,
): string {
  return [
    `[Respond to this new user message]\n${task}`,
    `[Your previous attempt]\n${stuckOutput || '(none)'}`,
    `[You reported being stuck: ${reason}]`,
    `[A senior advisor reviewed your situation and gave this guidance — follow it to continue and complete the task]\n${guidance}`,
    'Continue the task now. Only emit `[ASK_ADVISOR]: <reason>` again if you are still genuinely blocked after applying this guidance.',
  ].join('\n\n');
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/core/src/index.ts`, after the line `export * from './advisor-personality';` (line 13), add:

```ts
export * from './solo-advisor';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/jackou/Documents/projects/codey && npm test -w @codey/core -- solo-advisor`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Build core**

Run: `cd /Users/jackou/Documents/projects/codey && npm run build:core`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add packages/core/src/solo-advisor.ts packages/core/src/solo-advisor.test.ts packages/core/src/index.ts
git commit -m "feat(core): solo advisor prompt builders"
```

---

## Task 4: Gateway — instruction constant + escalation loop

**Files:**
- Modify: `packages/gateway/src/chat-runner.ts` (export `SOLO_ADVISOR_INSTRUCTION`)
- Modify: `packages/gateway/src/gateway.ts` (imports, `SOLO_ADVISOR_MAX_ROUNDS`, prompt injection, `runSoloAdvisor`, escalation loop)

- [ ] **Step 1: Add the instruction constant**

In `packages/gateway/src/chat-runner.ts`, after the `CHAT_CONTEXT_WINDOW` constant (line 4), add:

```ts
/**
 * Appended to the prompt only when a chat has soloAdvisor enabled. Tells the
 * single agent to self-escalate when stuck via the [ASK_ADVISOR] marker.
 */
export const SOLO_ADVISOR_INSTRUCTION =
  'If you cannot make progress, or you notice you are repeating the same failed ' +
  'approach across turns, end your reply with a single line ' +
  '`[ASK_ADVISOR]: <brief description of where you are stuck>` (a stronger advisor ' +
  'model will give you guidance, then you continue). Do not use this line unless you ' +
  'are genuinely blocked.';
```

- [ ] **Step 2: Extend the core import in gateway.ts**

In `packages/gateway/src/gateway.ts` line 3, add these names to the existing `@codey/core` import list: `parseAskAdvisor`, `stripAskAdvisor`, `buildSoloAdvisorPrompt`, `buildSoloAdvisorFollowupPrompt`, `SoloAdvisorInput`.

The import currently ends with `...lastParagraphPreview } from '@codey/core';`. Change that tail to:

```ts
..., lastParagraphPreview, parseAskAdvisor, stripAskAdvisor, buildSoloAdvisorPrompt, buildSoloAdvisorFollowupPrompt, SoloAdvisorInput } from '@codey/core';
```

- [ ] **Step 3: Import the instruction constant**

In `packages/gateway/src/gateway.ts` line 16, add `SOLO_ADVISOR_INSTRUCTION` to the existing `./chat-runner` import list (after `QQHistoryEntry`).

- [ ] **Step 4: Add the round-cap constant**

Near the top of the gateway file, just after the imports (before the class declaration), add:

```ts
/** Max advisor escalation rounds per single-agent turn (solo advisor). */
const SOLO_ADVISOR_MAX_ROUNDS = 2;
```

- [ ] **Step 5: Add the `runSoloAdvisor` helper method**

In `packages/gateway/src/gateway.ts`, immediately after the `advisorRunner` field (ends at line 368), add:

```ts
  /** Run the stronger advisor model for a stuck single agent. Returns plain-text
   *  guidance, or null on failure/timeout (caller degrades to the agent's reply). */
  private async runSoloAdvisor(
    input: SoloAdvisorInput,
    workingDir: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const { agent, model } = this.getAdvisorAgentAndModel();
    try {
      const resp = await this.runWithFallback(agent, {
        prompt: buildSoloAdvisorPrompt(input),
        agent,
        model,
        context: { workingDir },
        onStream: () => {},
        onThinking: () => {},
        onStatus: () => {},
        signal,
      });
      if (!resp?.success) return null;
      const text = this.formatAgentResponse(resp).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 6: Inject the instruction into the prompt**

In `packages/gateway/src/gateway.ts`, after the prompt-build `if (warmAnchor) { ... } else { ... }` block (ends at line 3778), add:

```ts
    // Solo advisor: when enabled (and not a team), tell the agent how to escalate.
    if (chat.soloAdvisor && chat.selection.type !== 'team') {
      prompt = prompt + '\n\n' + SOLO_ADVISOR_INSTRUCTION;
    }
```

- [ ] **Step 7: Add the escalation loop**

In `packages/gateway/src/gateway.ts`, in the single-agent `else` branch, locate the line `singleAgentResponse = response;` (line 3905). Immediately BEFORE it, insert:

```ts
        // Solo advisor escalation: if the agent signalled it's stuck, get
        // guidance from the stronger advisor model and re-run, up to N rounds.
        let advisorRounds = 0;
        while (
          chat.soloAdvisor &&
          chat.selection.type !== 'team' &&
          response?.success &&
          advisorRounds < SOLO_ADVISOR_MAX_ROUNDS &&
          !abortController.signal.aborted
        ) {
          const ask = parseAskAdvisor(this.formatAgentResponse(response));
          if (!ask) break;
          advisorRounds++;
          const guidance = await this.runSoloAdvisor(
            { task: userText, stuckOutput: ask.preamble, reason: ask.reason },
            workingDir,
            abortController.signal,
          );
          if (!guidance) break; // advisor failed → keep the agent's own reply
          sink({ type: 'info', chatId, message: `🧭 Advisor: ${guidance}` });
          streamedText = '';
          const followup = selPrefix + buildSoloAdvisorFollowupPrompt(
            ask.reason, guidance, userText, ask.preamble,
          );
          response = await this.runWithFallback(agent, {
            prompt: followup,
            agent,
            model,
            context: { workingDir },
            skipPermissions: this.getSkipPermissions(),
            onStream,
            onThinking: (text: string) => sink({ type: 'thinking', chatId, token: text }),
            onStatus,
            signal: abortController.signal,
          });
        }
```

- [ ] **Step 8: Strip the marker from the final output**

In `packages/gateway/src/gateway.ts`, find the line `output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');` (line 3906). Immediately AFTER it, add:

```ts
        if (chat.soloAdvisor) output = stripAskAdvisor(output);
```

- [ ] **Step 9: Build core + gateway**

Run: `cd /Users/jackou/Documents/projects/codey && npm run build:core && npm run build:gateway`
Expected: both exit 0, no TypeScript errors.

- [ ] **Step 10: Run the full core test suite (regression check)**

Run: `cd /Users/jackou/Documents/projects/codey && npm test -w @codey/core`
Expected: PASS (no regressions; solo-advisor tests green).

- [ ] **Step 11: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add packages/gateway/src/chat-runner.ts packages/gateway/src/gateway.ts
git commit -m "feat(gateway): solo advisor escalation loop for single-agent chats"
```

---

## Task 5: `ChatManager.setSoloAdvisor`

**Files:**
- Modify: `packages/gateway/src/chats.ts:210-219` (add after `updateContextPanelOpen`)

- [ ] **Step 1: Add the manager method**

In `packages/gateway/src/chats.ts`, immediately after the `updateContextPanelOpen` method (ends at line 219), add:

```ts
  /** Set or clear the per-chat solo-advisor toggle. */
  setSoloAdvisor(chatId: string, enabled: boolean): Chat {
    const chat = this.requireChat(chatId);
    if (enabled) chat.soloAdvisor = true;
    else delete chat.soloAdvisor;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }
```

- [ ] **Step 2: Build gateway**

Run: `cd /Users/jackou/Documents/projects/codey && npm run build:gateway`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add packages/gateway/src/chats.ts
git commit -m "feat(gateway): ChatManager.setSoloAdvisor"
```

---

## Task 6: codey-mac IPC chain + toggle UI

**Files:**
- Modify: `codey-mac/electron/main.ts:2053` (add IPC handler near `chats:updateAgentModel`)
- Modify: `codey-mac/electron/preload.ts:105-106` (expose the call)
- Modify: `codey-mac/src/codey-api.d.ts:104` (type the call)
- Modify: `codey-mac/src/services/api.ts:197-198` (apiService method)
- Modify: `codey-mac/src/hooks/useChats.tsx` (reducer patch + action + interface)
- Modify: `codey-mac/src/components/ChatTab.tsx:840-847` (toggle button)

- [ ] **Step 1: Add the IPC handler (main process)**

In `codey-mac/electron/main.ts`, immediately after the `chats:updateAgentModel` handler (the block starting at line 2053), add:

```ts
  ipcMain.handle('chats:setSoloAdvisor', async (_e, id: string, enabled: boolean) =>
    wrap(() => {
      if (!inProcessGateway) throw new Error('Gateway not started');
      return inProcessGateway.getChatManager().setSoloAdvisor(id, enabled);
    }),
  );
```

(Match the exact `wrap(...)`/error-handling shape used by the adjacent `chats:updateAgentModel` handler — read lines 2053-2058 first and mirror them precisely.)

- [ ] **Step 2: Expose it in preload**

In `codey-mac/electron/preload.ts`, after the `updateAgentModel` entry (lines 105-106), add:

```ts
    setSoloAdvisor: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('chats:setSoloAdvisor', id, enabled),
```

- [ ] **Step 3: Type it**

In `codey-mac/src/codey-api.d.ts`, after the `updateAgentModel` line (104), add:

```ts
        setSoloAdvisor: (id: string, enabled: boolean) => Promise<IpcResult<Chat>>
```

- [ ] **Step 4: Add the apiService method**

In `codey-mac/src/services/api.ts`, after the `updateAgentModel` entry (lines 197-198), add:

```ts
    setSoloAdvisor: async (id: string, enabled: boolean): Promise<Chat> =>
      unwrap(await window.codey.chats.setSoloAdvisor(id, enabled)),
```

- [ ] **Step 5: Add the reducer patch case**

In `codey-mac/src/hooks/useChats.tsx`, find the `patchContextPanelOpen` reducer case (around line 123). Immediately after that case's block, add a parallel case:

```tsx
    case 'patchSoloAdvisor': {
      const chat = state.chats.find(c => c.id === action.chatId)
      if (!chat) return state
      const updated: Chat = { ...chat, soloAdvisor: action.enabled || undefined }
      return { ...state, chats: state.chats.map(c => (c.id === chat.id ? updated : c)) }
    }
```

Also add the action to the reducer's action union type (find where `patchContextPanelOpen` is declared in the `Action` type and add alongside it):

```tsx
  | { type: 'patchSoloAdvisor'; chatId: string; enabled: boolean }
```

- [ ] **Step 6: Add the action method + interface entry**

In `codey-mac/src/hooks/useChats.tsx`, after the `setContextPanelOpen` interface declaration (line 327), add:

```tsx
  setSoloAdvisor: (chatId: string, enabled: boolean) => Promise<void>
```

And after the `setContextPanelOpen` action implementation (ends at line 543), add:

```tsx
    async setSoloAdvisor(chatId, enabled) {
      dispatch({ type: 'patchSoloAdvisor', chatId, enabled })
      try { await apiService.chats.setSoloAdvisor(chatId, enabled) } catch { /* swallow */ }
    },
```

- [ ] **Step 7: Wire the toggle into the component's hook destructure**

In `codey-mac/src/components/ChatTab.tsx` line 225, add `setSoloAdvisor` to the destructured `useChats()` result (after `setContextPanelOpen`).

- [ ] **Step 8: Add the toggle button**

In `codey-mac/src/components/ChatTab.tsx`, inside the `chat.selection.type !== 'team'` fragment (the `<>...</>` spanning lines 813-838, right after the model `<select>` closes at line 837), add:

```tsx
            <button
              onClick={() => setSoloAdvisor(chat.id, !(chat.soloAdvisor ?? false))}
              style={{
                ...styles.linkBtn,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                padding: '4px 6px',
                opacity: chat.soloAdvisor ? 1 : 0.5,
              }}
              title={chat.soloAdvisor
                ? 'Solo Advisor 兜底: ON — stuck agent escalates to the advisor model'
                : 'Solo Advisor 兜底: OFF'}
              aria-label="Toggle solo advisor"
            >
              🧭
            </button>
```

- [ ] **Step 9: Type-check / build codey-mac**

Run: `cd /Users/jackou/Documents/projects/codey/codey-mac && npm run build`
Expected: exits 0 (Vite + tsc build succeeds). If the project uses a separate typecheck script (`npm run typecheck`), run that too.

- [ ] **Step 10: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts codey-mac/src/services/api.ts codey-mac/src/hooks/useChats.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "feat(codey-mac): per-chat solo advisor toggle"
```

---

## Task 7: Manual verification

**Files:** none (runtime check)

- [ ] **Step 1: Launch the app**

Run the codey-mac app (use the project's standard launch, e.g. `cd codey-mac && npm run dev`).

- [ ] **Step 2: Verify the happy path (toggle OFF)**

In a single-worker/single-model chat with the 🧭 toggle OFF, send a normal prompt. Confirm behavior is unchanged and no `[ASK_ADVISOR]` text leaks into replies.

- [ ] **Step 3: Verify escalation (toggle ON)**

Turn the 🧭 toggle ON. Send a prompt likely to stump the base model (or temporarily set the chat's model to a weak one). Confirm: when the agent emits `[ASK_ADVISOR]`, a `🧭 Advisor:` info note appears, the agent re-runs with guidance, and the final reply has no marker. Confirm escalation stops after at most 2 rounds.

- [ ] **Step 4: Verify persistence**

Toggle ON, reload the app / reopen the chat, confirm the 🧭 toggle stays ON (persisted via `chat.soloAdvisor`).

---

## Self-Review Notes

- **Spec coverage:** config/state → T1+T5+T6; prompt injection → T4 S1/S6; parser → T2; solo advisor prompt+runner → T3+T4; escalation loop w/ 2-round cap → T4 S7; UI toggle → T6; error handling (advisor failure degrades, marker stripped) → T4 S5/S7/S8; testing → T2/T3/T4 S10. All spec sections mapped.
- **Type consistency:** `parseAskAdvisor`/`stripAskAdvisor` (T2) used in T4; `buildSoloAdvisorPrompt`/`buildSoloAdvisorFollowupPrompt`/`SoloAdvisorInput` (T3) used in T4; `Chat.soloAdvisor` (T1) used in T4/T5/T6; `setSoloAdvisor` (T5) used by T6 IPC chain. Names consistent across tasks.
- **Line numbers** are from the current `main` snapshot; if drifted, locate by the quoted anchor text instead.
