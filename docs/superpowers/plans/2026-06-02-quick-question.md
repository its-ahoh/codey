# Quick Question (QQ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Quick Question" side-thread to the Codey macOS app that answers questions grounded in the current chat's content without touching the chat's history, CLI session, or channel mirroring.

**Architecture:** A new gateway method `runQuickQuestion` runs an ephemeral, read-only agent turn (no session anchor, no persistence) using the chat's history + the QQ thread's own turns as prompt context. A dedicated `qq:*` IPC channel streams it to a self-contained renderer hook (`useQuickQuestion`) and a third "Quick Question" tab in `ChatContextPanel`. Triggered by the QQ tab, `/qq <question>`, or a bare `QQ` in the composer.

**Tech Stack:** TypeScript, Electron (main/preload IPC), React (renderer), existing `@codey/core` agent adapters + `@codey/gateway`.

---

## Important Notes For The Implementer

- **No test runner exists in this repo** (`npm test` is not configured). Verification is done via `tsc --noEmit` per package and manual app testing. Every task's verify step is a typecheck; the final task is manual verification.
- Run typechecks from the worktree root `.worktrees/quick-question`. Commands:
  - Core: `(cd packages/core && npx tsc --noEmit -p tsconfig.json)`
  - Gateway: `(cd packages/gateway && npx tsc --noEmit -p tsconfig.json)`
  - Mac renderer: `(cd codey-mac && npx tsc -p tsconfig.json --noEmit)`
  - Mac electron: `(cd codey-mac && npx tsc -p tsconfig.electron.json --noEmit)` (only if that config exists; otherwise the renderer tsc covers `electron/` too — check `codey-mac/tsconfig*.json` first.)
- Do **not** run the root `npm run build` as a check — it fails on this machine due to a Node-16/Vite (`crypto.getRandomValues`) issue and the Swift voice build, unrelated to this work.
- Commit after each task with the exact message shown.

---

## File Structure

**Modify:**
- `packages/core/src/types/index.ts` — add `allowedTools?` to `AgentRequest`.
- `packages/core/src/agents/claude-code.ts` — pass `--allowedTools` when present.
- `packages/gateway/src/chat-runner.ts` — extract shared context renderer; add `buildQuickQuestionPrompt`, `READ_ONLY_TOOLS`, `QQStreamEvent`, `QQHistoryEntry`.
- `packages/gateway/src/gateway.ts` — add `runQuickQuestion` + `stopQuickQuestion`.
- `codey-mac/electron/main.ts` — `qq:ask` / `qq:stop` IPC handlers; inject `/qq` into slash list.
- `codey-mac/electron/preload.ts` — expose `window.codey.qq`.
- `codey-mac/src/codey-api.d.ts` — type `window.codey.qq` + `QQStreamEvent`.
- `codey-mac/src/services/api.ts` — `apiService.qq`.
- `codey-mac/src/components/ChatContextPanel.tsx` — controlled tab prop + third "Quick Question" tab.
- `codey-mac/src/components/ChatTab.tsx` — controlled panel tab; `QQ` and `/qq` triggers; wire `useQuickQuestion`.
- `codey-mac/src/App.tsx` — wrap tree in `QuickQuestionProvider`.

**Create:**
- `codey-mac/src/hooks/useQuickQuestion.tsx` — provider/hook owning per-chat ephemeral QQ threads + `qq:event` subscription.
- `codey-mac/src/components/QuickQuestionView.tsx` — the mini-chat UI rendered in the QQ tab.

---

## Task 1: Add read-only tool allowlist support to the agent request

**Files:**
- Modify: `packages/core/src/types/index.ts:102-141`
- Modify: `packages/core/src/agents/claude-code.ts:64-86`

- [ ] **Step 1: Add `allowedTools` to `AgentRequest`**

In `packages/core/src/types/index.ts`, inside `interface AgentRequest`, add this field right after `extraEnv?` (before the closing `}` at line 141):

```typescript
  /**
   * Restrict the agent to this exact set of tool names. When set, the adapter
   * passes it to the CLI's allow-list flag so the agent cannot use any other
   * tool. Used by Quick Question to enforce a read-only turn. Only enforced by
   * the claude-code adapter today; other adapters rely on prompt instructions.
   */
  allowedTools?: string[];
```

- [ ] **Step 2: Pass `--allowedTools` in the claude-code adapter**

In `packages/core/src/agents/claude-code.ts`, in `run()`, after the `if (request.skipPermissions) { args.push('--dangerously-skip-permissions'); }` block (ends at line 71) and before the `resumeSessionId`/`newSessionId` block, insert:

```typescript
      if (request.allowedTools && request.allowedTools.length > 0) {
        args.push('--allowedTools', request.allowedTools.join(' '));
      }
```

- [ ] **Step 3: Typecheck core**

Run: `(cd packages/core && npx tsc --noEmit -p tsconfig.json)`
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/index.ts packages/core/src/agents/claude-code.ts
git commit -m "feat(core): add allowedTools to AgentRequest for read-only turns"
```

---

## Task 2: QQ prompt builder + shared types in chat-runner

**Files:**
- Modify: `packages/gateway/src/chat-runner.ts:51-114`

- [ ] **Step 1: Extract the shared "prior conversation" renderer**

In `packages/gateway/src/chat-runner.ts`, replace the body of `buildChatPrompt` (lines 51-87) so the history-rendering logic lives in a reusable helper. Replace the existing `export function buildChatPrompt(...) { ... }` with:

```typescript
/**
 * Render the chat's prior history as context sections (compaction summary +
 * windowed transcript). Shared by buildChatPrompt and buildQuickQuestionPrompt
 * so both window/compact identically.
 */
function renderChatContextSections(chat: Chat, windowSize: number): string[] {
  const sections: string[] = [];

  const summarizedUpTo = chat.compaction?.summarizedUpTo ?? 0;
  if (chat.compaction?.summary) {
    sections.push(
      `[Earlier conversation summary — covers messages before this point]\n${chat.compaction.summary}`,
    );
  }

  const start = Math.max(summarizedUpTo, chat.messages.length - windowSize);
  const tail = chat.messages.slice(start);
  if (tail.length > 0) {
    const transcript = tail.map(m => {
      const tag = m.role === 'user' ? '[user]' : '[assistant]';
      return `${tag}\n${m.content}`;
    }).join('\n\n');
    sections.push(
      `[Prior conversation — context only; do not continue or fabricate further turns]\n${transcript}`,
    );
  }

  return sections;
}

export function buildChatPrompt(
  chat: Chat,
  userText: string,
  attachments?: FileAttachment[],
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  const sections: string[] = [];

  if (attachments && attachments.length > 0) {
    sections.push(formatAttachmentList(attachments));
  }

  sections.push(...renderChatContextSections(chat, windowSize));

  sections.push(`[Respond to this new user message]\n${userText}`);
  return sections.join('\n\n');
}
```

(The doc comment above `buildChatPrompt` at lines 41-50 can stay as-is.)

- [ ] **Step 2: Add QQ types, the read-only allowlist, and the QQ prompt builder**

At the end of `packages/gateway/src/chat-runner.ts`, append:

```typescript
/** Tools Quick Question is allowed to use — strictly read/inspect only. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'];

export interface QQHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** Stream events for a Quick Question run. `chatId` is the parent chat it belongs to. */
export type QQStreamEvent =
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'tool'; chatId: string; message: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number }
  | { type: 'stopped'; chatId: string }
  | { type: 'error'; chatId: string; message: string };

/**
 * Build the ephemeral prompt for a Quick Question turn: the parent chat as
 * read-only reference, then the QQ thread's own prior turns, then the new
 * question with an explicit read-only instruction.
 */
export function buildQuickQuestionPrompt(
  chat: Chat,
  qqHistory: QQHistoryEntry[],
  question: string,
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  const sections: string[] = [];

  const ctx = renderChatContextSections(chat, windowSize);
  if (ctx.length > 0) {
    sections.push(
      '[Main chat — read-only reference. Do not continue or modify this conversation.]',
      ...ctx,
    );
  }

  if (qqHistory.length > 0) {
    const transcript = qqHistory.map(m => {
      const tag = m.role === 'user' ? '[user]' : '[assistant]';
      return `${tag}\n${m.content}`;
    }).join('\n\n');
    sections.push(`[Quick Question thread so far]\n${transcript}`);
  }

  sections.push(
    '[New quick question — answer using the reference above. You are READ-ONLY: ' +
    'you may read files and search, but must NOT create, edit, delete, or run ' +
    'commands that modify anything.]\n' + question,
  );

  return sections.join('\n\n');
}
```

Note: `renderChatContextSections` is declared above `buildChatPrompt` in Step 1; `buildQuickQuestionPrompt` is appended at the bottom of the file. Both are in the same module, so the hoisted `function` declaration is in scope.

- [ ] **Step 3: Typecheck gateway**

Run: `(cd packages/gateway && npx tsc --noEmit -p tsconfig.json)`
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/chat-runner.ts
git commit -m "feat(gateway): add Quick Question prompt builder + read-only tool list"
```

---

## Task 3: gateway.runQuickQuestion + stopQuickQuestion

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (import line 16; new methods near `sendToChat` ~line 3473)

- [ ] **Step 1: Import the new chat-runner exports**

In `packages/gateway/src/gateway.ts` line 16, extend the existing import from `./chat-runner` to include the new symbols:

```typescript
import { buildChatPrompt, buildChatBootstrapPrompt, buildChatResumePrompt, buildQuickQuestionPrompt, assistantPrefixForSelection, RunSemaphore, ChatStreamSink, READ_ONLY_TOOLS, QQStreamEvent, QQHistoryEntry } from './chat-runner';
```

- [ ] **Step 2: Add a QQ abort-controller map field**

In `packages/gateway/src/gateway.ts`, right after the existing `private chatSemaphore = new RunSemaphore();` (line 48), add:

```typescript
  /** In-flight Quick Question runs, keyed by parent chatId, for cancellation. */
  private qqAborts = new Map<string, AbortController>();
```

- [ ] **Step 3: Add `runQuickQuestion` and `stopQuickQuestion`**

In `packages/gateway/src/gateway.ts`, immediately BEFORE the `async sendToChat(` method declaration (line 3473), insert:

```typescript
  /**
   * Run an ephemeral, read-only Quick Question turn against a chat's context.
   * Does NOT append to the chat, set a session anchor, persist, or mirror to
   * channels. Streams via the provided sink. Uses the Aide agent/model when
   * configured, otherwise the chat's effective agent/model.
   */
  async runQuickQuestion(
    chatId: string,
    question: string,
    qqHistory: QQHistoryEntry[],
    sink: (e: QQStreamEvent) => void,
  ): Promise<{ response: string; tokens?: number; durationSec?: number }> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);

    // Resolve workingDir from the chat's workspace.json (mirrors sendToChat).
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, chat.workspaceName, 'workspace.json');
    let workingDir = this.workingDir;
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) workingDir = wsConfig.workingDir;
      } catch { /* use default */ }
    } else {
      const msg = `Workspace not found: ${chat.workspaceName}`;
      sink({ type: 'error', chatId, message: msg });
      throw new Error(msg);
    }

    // Aide agent/model if configured, else the chat's effective agent/model.
    const aideCfg = this.config.aide;
    let agent: CodingAgent;
    let model: ModelConfig | undefined;
    try {
      if (aideCfg?.agent || aideCfg?.model) {
        ({ agent, model } = this.getAideAgentAndModel());
      } else {
        agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
        model = chat.model
          ? this.getModelConfig(agent, chat.model)
          : this.getDefaultModelConfig(agent);
      }
    } catch (err) {
      const msg = (err as Error).message;
      sink({ type: 'error', chatId, message: msg });
      throw err;
    }

    // One in-flight QQ per chat: abort any prior run for this chat.
    this.qqAborts.get(chatId)?.abort();
    const abortController = new AbortController();
    this.qqAborts.set(chatId, abortController);

    const started = Date.now();
    const prompt = buildQuickQuestionPrompt(chat, qqHistory, question);

    let streamedText = '';
    const onStream = (text: string) => {
      streamedText += text;
      sink({ type: 'stream', chatId, token: text });
    };
    const onStatus = (update: any) => {
      try {
        const parsed = typeof update === 'string' ? JSON.parse(update) : update;
        if (parsed?.message) sink({ type: 'tool', chatId, message: String(parsed.message) });
      } catch { /* non-JSON status */ }
    };

    try {
      const response = await this.runWithFallback(agent, {
        prompt,
        agent,
        model,
        context: { workingDir },
        skipPermissions: true,
        allowedTools: READ_ONLY_TOOLS,
        onStream,
        onStatus,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        sink({ type: 'stopped', chatId });
        return { response: streamedText };
      }

      const output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
      const tokens = (response as any)?.tokens?.total;
      const durationSec = Math.round((Date.now() - started) / 1000);

      if (!response?.success && !output) {
        const msg = (response as any)?.error || 'Quick Question failed';
        sink({ type: 'error', chatId, message: String(msg) });
        return { response: '' };
      }

      sink({ type: 'done', chatId, response: output, tokens, durationSec });
      return { response: output, tokens, durationSec };
    } catch (err) {
      if (abortController.signal.aborted) {
        sink({ type: 'stopped', chatId });
        return { response: streamedText };
      }
      const msg = (err as Error).message;
      sink({ type: 'error', chatId, message: msg });
      throw err;
    } finally {
      if (this.qqAborts.get(chatId) === abortController) {
        this.qqAborts.delete(chatId);
      }
    }
  }

  /** Cancel an in-flight Quick Question run for a chat. Returns true if one was aborted. */
  stopQuickQuestion(chatId: string): boolean {
    const ac = this.qqAborts.get(chatId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

```

Notes for the implementer:
- `path` and `fs` are already imported at the top of `gateway.ts` (used by `sendToChat`/`chats:upload` paths). Confirm with `grep -n "^import \* as path\|^import path\|from 'path'\|from 'fs'" packages/gateway/src/gateway.ts`; they are present.
- `this.workingDir`, `this.workspaceManager`, `this.config`, `this.getAideAgentAndModel()`, `this.getModelConfig`, `this.getDefaultAgent`, `this.getDefaultModelConfig`, `this.runWithFallback`, and `this.formatAgentResponse` are all existing members on the class.

- [ ] **Step 4: Typecheck gateway**

Run: `(cd packages/gateway && npx tsc --noEmit -p tsconfig.json)`
Expected: exits 0, no output. If it complains `formatAgentResponse` is private — it is called from within the same class, which is allowed; no change needed.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): add runQuickQuestion / stopQuickQuestion"
```

---

## Task 4: IPC handlers in main.ts + `/qq` slash command

**Files:**
- Modify: `codey-mac/electron/main.ts` (`/qq` injection near `agents:slashCommands` ~1482; new handlers near `chats:stop` ~1590)

- [ ] **Step 1: Inject `/qq` into the slash-command list**

In `codey-mac/electron/main.ts`, replace the `agents:slashCommands` handler (lines 1482-1484) with one that prepends a gateway-level `/qq`:

```typescript
  ipcMain.handle('agents:slashCommands', async (_e, agent: string) =>
    wrap(async () => {
      const discovered = await discoverSlashCommands(agent)
      const qq: SlashCommand = {
        name: 'qq',
        description: 'Quick Question — ask about this chat without affecting it',
        source: 'gateway',
      }
      // Avoid a duplicate if a future discovery ever yields one.
      return [qq, ...discovered.filter(c => c.name !== 'qq')]
    })
  )
```

- [ ] **Step 2: Add `qq:ask` and `qq:stop` handlers**

In `codey-mac/electron/main.ts`, immediately after the `chats:stop` handler (ends at line 1590), insert:

```typescript
  ipcMain.handle('qq:ask', async (_e, payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }> }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      // Stream events to the renderer on a dedicated channel so QQ never
      // collides with the main 'chats:event' stream.
      const sink = (ev: any) => sendToRenderer('qq:event', ev)
      return inProcessGateway.runQuickQuestion(payload.chatId, payload.question, payload.history ?? [], sink)
    })
  )

  ipcMain.handle('qq:stop', async (_e, chatId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.stopQuickQuestion(chatId)
    })
  )
```

Note: `sendToRenderer` is the existing helper used at line 487 (`inProcessGateway.setChatEventListener((ev) => sendToRenderer('chats:event', ev))`). `wrap`, `inProcessGateway`, and `SlashCommand` are all defined in this file.

- [ ] **Step 3: Typecheck electron**

First check which tsconfig covers `electron/`:
Run: `ls codey-mac/tsconfig*.json`
Then run the electron typecheck (use `tsconfig.electron.json` if present, else the node config):
Run: `(cd codey-mac && npx tsc -p tsconfig.electron.json --noEmit) 2>/dev/null || (cd codey-mac && npx tsc -p tsconfig.node.json --noEmit)`
Expected: exits 0. (If both configs lack `electron/main.ts` in their include, fall back to `(cd codey-mac && npx tsc electron/main.ts --noEmit --skipLibCheck --module commonjs --target es2020 --moduleResolution node)` to sanity-check just this file.)

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(mac): add qq:ask/qq:stop IPC and /qq slash command"
```

---

## Task 5: Expose `window.codey.qq` in preload + types

**Files:**
- Modify: `codey-mac/electron/preload.ts:92-119`
- Modify: `codey-mac/src/codey-api.d.ts:1-2, 91-107`

- [ ] **Step 1: Add the `qq` bridge in preload**

In `codey-mac/electron/preload.ts`, immediately after the `chats: { ... }` object (after the closing `},` at line 119), add:

```typescript
  qq: {
    ask: (payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }> }) =>
      ipcRenderer.invoke('qq:ask', payload),
    stop: (chatId: string) => ipcRenderer.invoke('qq:stop', chatId),
    onEvent: (handler: (ev: any) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: any) => handler(ev)
      ipcRenderer.on('qq:event', listener)
      return () => ipcRenderer.removeListener('qq:event', listener)
    },
  },
```

- [ ] **Step 2: Type `window.codey.qq` and import `QQStreamEvent`**

In `codey-mac/src/codey-api.d.ts`, extend the import on line 2:

```typescript
import type { ChatStreamEvent, QQStreamEvent } from '../../packages/gateway/src/chat-runner'
```

Then, immediately after the `chats: { ... }` block (after its closing `}` at line 107), add:

```typescript
      qq: {
        ask: (payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }> }) => Promise<IpcResult<{ response: string; tokens?: number; durationSec?: number }>>
        stop: (chatId: string) => Promise<IpcResult<boolean>>
        onEvent: (handler: (ev: QQStreamEvent) => void) => () => void
      }
```

- [ ] **Step 3: Typecheck renderer**

Run: `(cd codey-mac && npx tsc -p tsconfig.json --noEmit)`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): expose window.codey.qq bridge + types"
```

---

## Task 6: apiService.qq

**Files:**
- Modify: `codey-mac/src/services/api.ts:1-21, 40` (top of `apiService` object)

- [ ] **Step 1: Add a `QQStreamEvent` re-export type and the `qq` service**

In `codey-mac/src/services/api.ts`, add this type near the top (after the `ChatStreamEvent` type at lines 7-16):

```typescript
export type QQStreamEvent =
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'tool'; chatId: string; message: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number }
  | { type: 'stopped'; chatId: string }
  | { type: 'error'; chatId: string; message: string };
```

Then add a `qq` member to the `apiService` object. Insert it right after the opening `export const apiService = {` line (line 40), before the `// Workers` comment:

```typescript
  qq: {
    ask: async (
      chatId: string,
      question: string,
      history: Array<{ role: 'user' | 'assistant'; content: string }>,
    ): Promise<{ response: string; tokens?: number; durationSec?: number }> =>
      unwrap(await window.codey.qq.ask({ chatId, question, history })),
    stop: async (chatId: string): Promise<boolean> =>
      unwrap(await window.codey.qq.stop(chatId)),
    onEvent: (handler: (ev: QQStreamEvent) => void): (() => void) =>
      window.codey.qq.onEvent(handler),
  },

```

- [ ] **Step 2: Typecheck renderer**

Run: `(cd codey-mac && npx tsc -p tsconfig.json --noEmit)`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/services/api.ts
git commit -m "feat(mac): add apiService.qq"
```

---

## Task 7: useQuickQuestion hook/provider

**Files:**
- Create: `codey-mac/src/hooks/useQuickQuestion.tsx`
- Modify: `codey-mac/src/App.tsx`

- [ ] **Step 1: Create the hook/provider**

Create `codey-mac/src/hooks/useQuickQuestion.tsx`:

```tsx
import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react'
import { apiService } from '../services/api'
import type { QQStreamEvent } from '../services/api'

export interface QQMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
}

export interface QQThread {
  messages: QQMessage[]
  inFlight: boolean
  activity?: string // latest tool/status line while running
}

interface State {
  threads: Record<string, QQThread>
}

type Action =
  | { type: 'startAsk'; chatId: string; userMsg: QQMessage; assistantId: string }
  | { type: 'token'; chatId: string; token: string }
  | { type: 'activity'; chatId: string; message: string }
  | { type: 'done'; chatId: string; content: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'stopped'; chatId: string }

const EMPTY: QQThread = { messages: [], inFlight: false }

function lastAssistant(thread: QQThread): QQMessage | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i].role === 'assistant') return thread.messages[i]
  }
  return undefined
}

function reducer(state: State, action: Action): State {
  const t = state.threads[action.chatId] ?? EMPTY
  switch (action.type) {
    case 'startAsk':
      return {
        threads: {
          ...state.threads,
          [action.chatId]: {
            messages: [
              ...t.messages,
              action.userMsg,
              { id: action.assistantId, role: 'assistant', content: '', streaming: true },
            ],
            inFlight: true,
            activity: undefined,
          },
        },
      }
    case 'token': {
      const msgs = t.messages.map(m =>
        m.streaming ? { ...m, content: m.content + action.token } : m,
      )
      return { threads: { ...state.threads, [action.chatId]: { ...t, messages: msgs } } }
    }
    case 'activity':
      return { threads: { ...state.threads, [action.chatId]: { ...t, activity: action.message } } }
    case 'done': {
      const msgs = t.messages.map(m =>
        m.streaming ? { ...m, content: action.content || m.content, streaming: false } : m,
      )
      return { threads: { ...state.threads, [action.chatId]: { messages: msgs, inFlight: false } } }
    }
    case 'stopped': {
      const msgs = t.messages.map(m => (m.streaming ? { ...m, streaming: false } : m))
      return { threads: { ...state.threads, [action.chatId]: { messages: msgs, inFlight: false } } }
    }
    case 'error': {
      const msgs = t.messages.map(m =>
        m.streaming ? { ...m, content: action.message, streaming: false, error: true } : m,
      )
      return { threads: { ...state.threads, [action.chatId]: { messages: msgs, inFlight: false } } }
    }
    default:
      return state
  }
}

interface QuickQuestionContextValue {
  getThread: (chatId: string) => QQThread
  ask: (chatId: string, question: string) => Promise<void>
  stop: (chatId: string) => Promise<void>
}

const Ctx = createContext<QuickQuestionContextValue | null>(null)

export const QuickQuestionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, { threads: {} })

  useEffect(() => {
    const off = apiService.qq.onEvent((ev: QQStreamEvent) => {
      switch (ev.type) {
        case 'stream':
          dispatch({ type: 'token', chatId: ev.chatId, token: ev.token })
          break
        case 'tool':
          dispatch({ type: 'activity', chatId: ev.chatId, message: ev.message })
          break
        case 'done':
          dispatch({ type: 'done', chatId: ev.chatId, content: ev.response })
          break
        case 'stopped':
          dispatch({ type: 'stopped', chatId: ev.chatId })
          break
        case 'error':
          dispatch({ type: 'error', chatId: ev.chatId, message: ev.message })
          break
      }
    })
    return off
  }, [])

  const value = useMemo<QuickQuestionContextValue>(() => ({
    getThread: (chatId) => state.threads[chatId] ?? EMPTY,
    async ask(chatId, question) {
      const q = question.trim()
      if (!q) return
      const thread = state.threads[chatId] ?? EMPTY
      if (thread.inFlight) return
      const history = thread.messages
        .filter(m => !m.error && m.content)
        .map(m => ({ role: m.role, content: m.content }))
      const userMsg: QQMessage = {
        id: `qq-u-${Date.now()}-${Math.random()}`,
        role: 'user',
        content: q,
      }
      const assistantId = `qq-a-${Date.now()}-${Math.random()}`
      dispatch({ type: 'startAsk', chatId, userMsg, assistantId })
      try {
        await apiService.qq.ask(chatId, q, history)
      } catch (err) {
        dispatch({ type: 'error', chatId, message: `Error: ${(err as Error).message}` })
      }
    },
    async stop(chatId) {
      try { await apiService.qq.stop(chatId) } catch { /* nothing in flight */ }
    },
  }), [state])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useQuickQuestion(): QuickQuestionContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useQuickQuestion must be used inside <QuickQuestionProvider>')
  return ctx
}
```

- [ ] **Step 2: Wrap the app with the provider**

In `codey-mac/src/App.tsx`, find where `<ChatsProvider>` wraps the tree (search: `grep -n "ChatsProvider" src/App.tsx`). Add the import at the top:

```tsx
import { QuickQuestionProvider } from './hooks/useQuickQuestion'
```

Then wrap the existing children of `<ChatsProvider>` with `<QuickQuestionProvider>`. For example, if the tree is `<ChatsProvider><Foo/></ChatsProvider>`, change it to:

```tsx
<ChatsProvider>
  <QuickQuestionProvider>
    <Foo/>
  </QuickQuestionProvider>
</ChatsProvider>
```

(The exact inner JSX stays the same — only the wrapping `<QuickQuestionProvider>…</QuickQuestionProvider>` is added inside `<ChatsProvider>`.)

- [ ] **Step 3: Typecheck renderer**

Run: `(cd codey-mac && npx tsc -p tsconfig.json --noEmit)`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/hooks/useQuickQuestion.tsx codey-mac/src/App.tsx
git commit -m "feat(mac): add useQuickQuestion provider for ephemeral QQ threads"
```

---

## Task 8: QuickQuestionView + third tab in ChatContextPanel

**Files:**
- Create: `codey-mac/src/components/QuickQuestionView.tsx`
- Modify: `codey-mac/src/components/ChatContextPanel.tsx:7-31` (Props), `:69` (tab state), `:124-137` (tabs), `:139-182` (body)

- [ ] **Step 1: Create QuickQuestionView**

Create `codey-mac/src/components/QuickQuestionView.tsx`:

```tsx
import React from 'react'
import { C } from '../theme'
import { Markdown } from './Markdown'
import { useQuickQuestion } from '../hooks/useQuickQuestion'

interface Props {
  chatId: string
  /** Set by the parent so it can focus the composer when QQ mode is opened. */
  inputRef?: React.RefObject<HTMLTextAreaElement>
}

export const QuickQuestionView: React.FC<Props> = ({ chatId, inputRef }) => {
  const { getThread, ask, stop } = useQuickQuestion()
  const thread = getThread(chatId)
  const [draft, setDraft] = React.useState('')
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.messages, thread.activity])

  const submit = () => {
    const q = draft.trim()
    if (!q || thread.inFlight) return
    setDraft('')
    void ask(chatId, q)
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div style={qqStyles.root}>
      <div style={qqStyles.hint}>
        Read-only side-thread. Answers use this chat's content as context but never
        modify the chat or its files.
      </div>
      <div ref={listRef} style={qqStyles.list}>
        {thread.messages.length === 0 && (
          <div style={qqStyles.empty}>Ask a quick question about this chat.</div>
        )}
        {thread.messages.map(m => (
          <div key={m.id} style={m.role === 'user' ? qqStyles.userMsg : qqStyles.asstMsg}>
            {m.role === 'user'
              ? <span style={qqStyles.userText}>{m.content}</span>
              : m.error
                ? <span style={qqStyles.errText}>{m.content}</span>
                : <Markdown content={m.content || (m.streaming ? '…' : '')} />}
          </div>
        ))}
        {thread.inFlight && thread.activity && (
          <div style={qqStyles.activity}>{thread.activity}</div>
        )}
      </div>
      <div style={qqStyles.composer}>
        <textarea
          ref={inputRef}
          style={qqStyles.textarea}
          value={draft}
          placeholder="Ask a quick question…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
        />
        {thread.inFlight ? (
          <button style={qqStyles.stopBtn} onClick={() => void stop(chatId)}>Stop</button>
        ) : (
          <button style={qqStyles.sendBtn} onClick={submit} disabled={!draft.trim()}>Ask</button>
        )}
      </div>
    </div>
  )
}

const qqStyles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  hint: { color: C.fg3, fontSize: 10, fontStyle: 'italic', padding: '0 0 8px' },
  list: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 },
  empty: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 0' },
  userMsg: { alignSelf: 'flex-end', maxWidth: '90%', background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '6px 8px' },
  userText: { color: C.fg, fontSize: 12, whiteSpace: 'pre-wrap' },
  asstMsg: { alignSelf: 'flex-start', maxWidth: '100%', fontSize: 12, color: C.fg2, minWidth: 0 },
  errText: { color: C.dangerFg ?? '#e66', fontSize: 12, whiteSpace: 'pre-wrap' },
  activity: { color: C.fg3, fontSize: 10, fontStyle: 'italic' },
  composer: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: `1px solid ${C.border}` },
  textarea: {
    resize: 'none', width: '100%', background: C.surface3, color: C.fg,
    border: `1px solid ${C.border2}`, borderRadius: 6, padding: '6px 8px',
    fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
  },
  sendBtn: {
    alignSelf: 'flex-end', background: C.accent, color: C.onAccent, border: 'none',
    borderRadius: 6, fontSize: 11, padding: '4px 12px', cursor: 'pointer',
  },
  stopBtn: {
    alignSelf: 'flex-end', background: 'transparent', color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 6, fontSize: 11, padding: '4px 12px', cursor: 'pointer',
  },
}
```

Note: confirm `Markdown` is a named export in `codey-mac/src/components/Markdown.tsx` (`grep -n "export" src/components/Markdown.tsx`). If it is a default export, change the import to `import Markdown from './Markdown'`. Also confirm `C.dangerFg` exists in `src/theme` (it is used in `GlobalTeamsSection.tsx:146`); the `?? '#e66'` fallback covers the case where it does not.

- [ ] **Step 2: Make the panel tab controllable and add the QQ tab**

In `codey-mac/src/components/ChatContextPanel.tsx`:

a) Add imports near the top (after line 5):

```tsx
import { QuickQuestionView } from './QuickQuestionView'
```

b) Define a shared tab type and extend `Props`. Add above `interface Props` (line 7):

```tsx
export type ContextPanelTab = 'current' | 'files' | 'qq'
```

Then add these fields to `interface Props` (inside the interface, before its closing `}` at line 31):

```tsx
  /** Controlled active tab. When omitted the panel manages its own tab state. */
  activeTab?: ContextPanelTab
  onTabChange?: (tab: ContextPanelTab) => void
  /** Focused when the QQ tab opens via a trigger. */
  qqInputRef?: React.RefObject<HTMLTextAreaElement>
```

c) Destructure the new props in the component signature (lines 43-47). Add `activeTab, onTabChange, qqInputRef,` to the destructured list.

d) Replace the local tab state (line 69) with a controlled-or-local fallback:

```tsx
  const [localTab, setLocalTab] = React.useState<ContextPanelTab>('current')
  const tab: ContextPanelTab = activeTab ?? localTab
  const setTab = (t: ContextPanelTab) => { onTabChange ? onTabChange(t) : setLocalTab(t) }
```

e) Add the third tab button. In the tabs block (lines 124-137), after the "File changes" button (before the closing `</div>` at line 137), add:

```tsx
        <button
          role="tab"
          aria-selected={tab === 'qq'}
          style={{ ...styles.tab, ...(tab === 'qq' ? styles.tabActive : null) }}
          onClick={() => setTab('qq')}
        >Quick Question</button>
```

f) Render the QQ view in the body. Change the body conditional. The current body (lines 139-182) is `{tab === 'current' ? (...) : (<FileChangesView .../>)}`. Replace the outer ternary so it handles three tabs. Wrap as:

```tsx
      <div style={styles.body}>
        {tab === 'qq' ? (
          <QuickQuestionView chatId={chat.id} inputRef={qqInputRef} />
        ) : tab === 'current' ? (
          <>
            {/* ...existing 'current' tab contents unchanged... */}
          </>
        ) : (
          <FileChangesView
            chat={chat}
            workingDir={workingDir}
            selectedTurnId={selectedTurnId}
            onReveal={onRevealFile}
          />
        )}
      </div>
```

Keep the existing `current`-tab JSX (the `<Section title="Run target">…` through `{!turn && …}`) exactly as-is inside the `tab === 'current'` branch. Only the surrounding conditional structure changes (add the leading `tab === 'qq' ?` branch).

Note: the QQ body should not be constrained by the `styles.body` padding behavior for scrolling — `QuickQuestionView` manages its own internal scroll. `styles.body` already sets `flex: 1, overflowY: 'auto'`; that is fine since QuickQuestionView's root is `height: 100%`.

- [ ] **Step 3: Typecheck renderer**

Run: `(cd codey-mac && npx tsc -p tsconfig.json --noEmit)`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/QuickQuestionView.tsx codey-mac/src/components/ChatContextPanel.tsx
git commit -m "feat(mac): add Quick Question tab + view to context panel"
```

---

## Task 9: ChatTab — controlled tab, QQ/`/qq` triggers

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx` (imports ~10; state ~236; `send()` ~594-603; panel render ~1145-1164)

- [ ] **Step 1: Import the QQ types/hook and add state**

In `codey-mac/src/components/ChatTab.tsx`, add imports near line 10:

```tsx
import type { ContextPanelTab } from './ChatContextPanel'
import { useQuickQuestion } from '../hooks/useQuickQuestion'
```

Inside the component, near the other `useState` hooks (~line 236), add:

```tsx
  const [panelTab, setPanelTab] = useState<ContextPanelTab>('current')
  const qqInputRef = useRef<HTMLTextAreaElement>(null)
  const { ask: askQuickQuestion } = useQuickQuestion()
```

(`useRef` and `useState` are already imported in this file.)

- [ ] **Step 2: Add a helper to open QQ mode**

Add this helper inside the component, just above `const send = async () => {` (line 594):

```tsx
  const openQuickQuestion = (initial?: string) => {
    setContextPanelOpen(chat.id, true)
    setPanelTab('qq')
    if (initial && initial.trim()) {
      void askQuickQuestion(chat.id, initial.trim())
    } else {
      // Focus the QQ composer on the next paint, once the panel has mounted.
      setTimeout(() => qqInputRef.current?.focus(), 50)
    }
  }
```

- [ ] **Step 3: Intercept `QQ` and `/qq` in `send()`**

Replace the body of `send` (lines 594-603) with:

```tsx
  const send = async () => {
    if ((!input.trim() && pendingAttachments.length === 0) || !isGatewayRunning || !!flight) return

    // Quick Question triggers — these never go to the main chat.
    const trimmed = input.trim()
    if (trimmed.toLowerCase() === 'qq') {
      setInput('')
      if (taRef.current && composerHeight == null) taRef.current.style.height = 'auto'
      openQuickQuestion()
      return
    }
    const qqMatch = trimmed.match(/^\/qq(?:\s+([\s\S]*))?$/i)
    if (qqMatch) {
      setInput('')
      if (taRef.current && composerHeight == null) taRef.current.style.height = 'auto'
      openQuickQuestion(qqMatch[1] ?? '')
      return
    }

    const text = input
    const atts = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined
    setInput('')
    setPendingAttachments([])
    if (taRef.current && composerHeight == null) taRef.current.style.height = 'auto'
    setFollowLatest(true)
    await sendMessage(chat.id, text, atts)
  }
```

Note: confirm `taRef` and `composerHeight` are the correct identifiers in this file (they appear at line 600 in the original `send`). Keep whatever this file already uses for the textarea ref / height reset — reuse the exact same lines from the original `send` body.

- [ ] **Step 4: Pass the controlled tab + qq input ref to the panel**

In the `<ChatContextPanel ... />` JSX (lines 1145-1164), add these three props (e.g. after `isTurnStreaming={...}`):

```tsx
          activeTab={panelTab}
          onTabChange={setPanelTab}
          qqInputRef={qqInputRef}
```

- [ ] **Step 5: Typecheck renderer**

Run: `(cd codey-mac && npx tsc -p tsconfig.json --noEmit)`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): QQ and /qq composer triggers + controlled panel tab"
```

---

## Task 10: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck sweep**

Run all four (skip electron config if it doesn't exist per Task 4 note):
```bash
(cd packages/core && npx tsc --noEmit -p tsconfig.json) && \
(cd packages/gateway && npx tsc --noEmit -p tsconfig.json) && \
(cd codey-mac && npx tsc -p tsconfig.json --noEmit) && echo "ALL TYPECHECKS PASS"
```
Expected: prints `ALL TYPECHECKS PASS`.

- [ ] **Step 2: Launch the app and verify behavior**

Use the project's run path (e.g. `cd codey-mac && npm run dev`, or the `/run` skill). Then verify each:

1. Open a chat with some history. Type `/qq what files were changed in this chat?` and press Enter.
   - Right panel opens on the **Quick Question** tab; an answer streams in the QQ thread.
   - The main chat's message list is **unchanged** (no new user/assistant messages).
2. Type a bare `QQ` and Enter → panel opens on the QQ tab, composer focused, no message sent to the chat.
3. Ask a follow-up in the QQ composer that references the previous QQ answer → it has context (multi-turn works).
4. While the QQ is streaming, send a normal message in the main chat → both proceed independently; neither interrupts the other.
5. Open the slash menu by typing `/` → `/qq` appears in the list.
6. Ask QQ to "create a file called test.txt" → it refuses / cannot (claude-code: blocked by `--allowedTools`).
7. Restart the app → QQ threads are gone (ephemeral), main chats persist.

Record any failures and fix before finishing. If a step fails, debug with superpowers:systematic-debugging.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(mac): Quick Question manual-verification fixes"
```
(Skip if no fixes were needed.)

---

## Self-Review (completed by plan author)

- **Spec coverage:** read-only (Task 1 + READ_ONLY_TOOLS in Task 2/3), ephemeral in-memory (Task 7 — renderer-only state), context = parent chat + QQ history (Task 2 `buildQuickQuestionPrompt`), Aide-or-default model (Task 3), third tab (Task 8), `/qq` + bare `QQ` triggers + slash menu entry (Task 4 + Task 9), no chat-history/session/channel side effects (Task 3 — no `appendMessage`/anchor/mirror), separate stream channel (Task 4 `qq:event`). All covered.
- **Type consistency:** `QQStreamEvent` shape is identical in `chat-runner.ts` (source of truth), `api.ts` (re-declared), and the `qq:event` handlers. `QQHistoryEntry`/history payload `{ role, content }` consistent across gateway, IPC, preload, api, hook. `ContextPanelTab` defined once in `ChatContextPanel.tsx` and imported by `ChatTab.tsx`.
- **Placeholders:** none — every code step contains complete code. The two "confirm identifier" notes (Markdown export style; `taRef`/`composerHeight`) are verification instructions, not deferred work.
