# Multi-Chat for the Codey Mac App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, parallel, many-per-workspace chats to the Codey Mac app, surfaced as a left-side chat list. The current nav tabs collapse behind a single Settings entry.

**Architecture:** Chats become a first-class backend entity owned by a new `ChatManager` that persists them to `workspaces/<name>/chats/<chatId>.json`. The gateway gains a `sendToChat(chatId, text)` method that spawns an agent scoped to the chat's workspace, streaming updates tagged with `chatId`. The Mac app replaces the icon rail with a chat list panel, moves Settings into an overlay, and routes streamed events through a global `useChats` store so parallel sends keep flowing regardless of which chat is active.

**Tech Stack:** TypeScript, Node, Electron, React (Vite). Shared types live in `packages/core`. The repo has no test runner today (per `CLAUDE.md`); verification is manual per step — build, script exercise, or in-app interaction.

**Testing note:** Every task ends with a concrete verification command and expected observation. Where a task would traditionally have a failing test, we instead have a "build and exercise" step that fails until the code is written.

---

## File Structure

**Create:**
- `packages/core/src/types/chat.ts` — `Chat`, `ChatSelection`, shared `ChatMessage`, `ToolCallEntry`.
- `packages/gateway/src/chats.ts` — `ChatManager` singleton with disk persistence.
- `packages/gateway/src/chat-runner.ts` — per-chat send orchestration + concurrency semaphore.
- `codey-mac/src/hooks/useChats.tsx` — React context + store, single stream subscription fanning out by `chatId`.
- `codey-mac/src/components/ChatListPanel.tsx` — left panel (grouped list, `+ New Chat`, Settings button).
- `codey-mac/src/components/SettingsOverlay.tsx` — wraps existing tab components behind an overlay.

**Modify:**
- `packages/core/src/index.ts` — re-export the new types.
- `packages/gateway/src/gateway.ts` — add `sendToChat` method + expose chat manager.
- `codey-mac/electron/main.ts` — wire `chats:*` IPC handlers, re-emit streaming with `chatId`.
- `codey-mac/electron/preload.ts` — expose `window.codey.chats.*`.
- `codey-mac/src/codey-api.d.ts` — type declarations for the new preload surface.
- `codey-mac/src/services/api.ts` — add `chats` service methods.
- `codey-mac/src/App.tsx` — drop tab rail, render `ChatListPanel` + active `ChatTab` + optional `SettingsOverlay`.
- `codey-mac/src/components/ChatTab.tsx` — take `chatId` prop; read/write from `useChats` store; top bar with workspace label + selection dropdown + title.
- `codey-mac/src/types/index.ts` — re-export shared chat types from core (drop local duplicate).
- `packages/core/src/workspace.ts` — cascade-delete `chats/` dir on workspace removal.

**Keep untouched:**
- `ConversationManager` — still used by Telegram/Discord.
- Worker/team runtime internals.

---

## Phase 1 — Backend: Chat types + ChatManager

### Task 1: Define shared chat types in `@codey/core`

**Files:**
- Create: `packages/core/src/types/chat.ts`
- Modify: `packages/core/src/types/index.ts`

- [ ] **Step 1: Create the chat types file**

Create `packages/core/src/types/chat.ts`:

```ts
export interface ToolCallEntry {
  id: string;
  type: 'tool_start' | 'tool_end' | 'info';
  tool?: string;
  message: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
  /** Total tokens for the assistant response, set when the turn completes. */
  tokens?: number;
  /** Wall-clock seconds the agent took to produce the response. */
  durationSec?: number;
}

export type ChatSelection =
  | { type: 'none' }
  | { type: 'worker'; name: string }
  | { type: 'team' };

export interface Chat {
  id: string;
  title: string;
  workspaceName: string;
  selection: ChatSelection;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Export the types from the core barrel**

In `packages/core/src/types/index.ts`, append:

```ts
export * from './chat';
```

(If `types/index.ts` does not exist or has a different form, add the export adjacent to other type exports.)

- [ ] **Step 3: Build verification**

Run from repo root:

```bash
npm --prefix packages/core run build
```

Expected: no TypeScript errors; `packages/core/dist/types/chat.d.ts` and `chat.js` produced.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/chat.ts packages/core/src/types/index.ts
git commit -m "feat(core): add Chat, ChatSelection, ChatMessage types"
```

---

### Task 2: `ChatManager` file I/O skeleton

**Files:**
- Create: `packages/gateway/src/chats.ts`
- Test harness: `packages/gateway/src/chats.test-manual.ts` (manual; deleted after verify)

- [ ] **Step 1: Write `ChatManager` with lazy load + basic CRUD**

Create `packages/gateway/src/chats.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Chat, ChatMessage, ChatSelection } from '@codey/core';
import { Logger } from './logger';

const log = Logger.getInstance();

export interface CreateChatInput {
  workspaceName: string;
  selection?: ChatSelection;
  title?: string;
}

export class ChatManager {
  private cache = new Map<string, Chat>();
  private loaded = false;

  constructor(private readonly workspacesRoot: string) {}

  private chatsDir(workspaceName: string): string {
    return path.join(this.workspacesRoot, workspaceName, 'chats');
  }

  private chatFile(workspaceName: string, chatId: string): string {
    return path.join(this.chatsDir(workspaceName), `${chatId}.json`);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.workspacesRoot)) return;
    const workspaces = fs.readdirSync(this.workspacesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    for (const ws of workspaces) {
      const dir = this.chatsDir(ws);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(dir, file);
        try {
          const raw = fs.readFileSync(full, 'utf8');
          const chat = JSON.parse(raw) as Chat;
          if (chat.id && chat.workspaceName) {
            this.cache.set(chat.id, chat);
          }
        } catch (err) {
          log.warn(`ChatManager: skipped corrupt chat file ${full}: ${(err as Error).message}`);
        }
      }
    }
  }

  private persist(chat: Chat): void {
    const dir = this.chatsDir(chat.workspaceName);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.chatFile(chat.workspaceName, chat.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  list(workspaceName?: string): Chat[] {
    this.ensureLoaded();
    const all = [...this.cache.values()];
    const filtered = workspaceName
      ? all.filter(c => c.workspaceName === workspaceName)
      : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(chatId: string): Chat | undefined {
    this.ensureLoaded();
    return this.cache.get(chatId);
  }

  create(input: CreateChatInput): Chat {
    this.ensureLoaded();
    const now = Date.now();
    const chat: Chat = {
      id: randomUUID(),
      title: input.title ?? 'New Chat',
      workspaceName: input.workspaceName,
      selection: input.selection ?? { type: 'none' },
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.cache.set(chat.id, chat);
    this.persist(chat);
    return chat;
  }

  rename(chatId: string, title: string): Chat {
    const chat = this.requireChat(chatId);
    chat.title = title;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  updateSelection(chatId: string, selection: ChatSelection): Chat {
    const chat = this.requireChat(chatId);
    chat.selection = selection;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  delete(chatId: string): void {
    const chat = this.cache.get(chatId);
    if (!chat) return;
    const file = this.chatFile(chat.workspaceName, chat.id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.cache.delete(chatId);
  }

  /** Append a message and persist. Called at message completion. */
  appendMessage(chatId: string, message: ChatMessage): Chat {
    const chat = this.requireChat(chatId);
    chat.messages.push(message);
    chat.updatedAt = Date.now();
    if (chat.messages.length === 1 && message.role === 'user') {
      chat.title = deriveTitle(message.content);
    }
    this.persist(chat);
    return chat;
  }

  /** Remove all chat files for a deleted workspace. */
  cascadeDeleteWorkspace(workspaceName: string): void {
    this.ensureLoaded();
    for (const [id, chat] of [...this.cache]) {
      if (chat.workspaceName === workspaceName) this.cache.delete(id);
    }
    const dir = this.chatsDir(workspaceName);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private requireChat(chatId: string): Chat {
    this.ensureLoaded();
    const chat = this.cache.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    return chat;
  }
}

function deriveTitle(firstMessage: string): string {
  const cleaned = firstMessage.trim().replace(/\s+/g, ' ');
  return cleaned.length <= 40 ? cleaned : cleaned.slice(0, 40) + '…';
}
```

- [ ] **Step 2: Create a throwaway exercise script**

Create `packages/gateway/src/chats.test-manual.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatManager } from './chats';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chats-'));
fs.mkdirSync(path.join(root, 'wsA'));
fs.mkdirSync(path.join(root, 'wsB'));

const cm = new ChatManager(root);

const a = cm.create({ workspaceName: 'wsA' });
const b = cm.create({ workspaceName: 'wsB', title: 'Custom' });
cm.appendMessage(a.id, {
  id: 'm1', role: 'user', content: 'Hello world this is a long first message that should be truncated',
  timestamp: Date.now(), isComplete: true,
});
cm.rename(b.id, 'Renamed');
cm.updateSelection(a.id, { type: 'team' });

console.log('list(all):', cm.list().map(c => ({ id: c.id, title: c.title, ws: c.workspaceName, sel: c.selection })));
console.log('list(wsA):', cm.list('wsA').map(c => c.title));

// Reload from disk
const cm2 = new ChatManager(root);
console.log('reloaded:', cm2.list().map(c => ({ title: c.title, msgs: c.messages.length })));

cm.cascadeDeleteWorkspace('wsA');
console.log('after cascade wsA:', cm.list().map(c => c.title));
console.log('tmp root:', root);
```

- [ ] **Step 3: Build + run the exercise script**

```bash
npm --prefix packages/core run build
npm --prefix packages/gateway run build
node packages/gateway/dist/chats.test-manual.js
```

Expected output includes:

- `list(all)` showing two chats, one with selection `{ type: 'team' }`.
- A auto-titled to `'Hello world this is a long first message that…'` (40-char cap with ellipsis).
- `reloaded:` showing both chats with correct message counts.
- `after cascade wsA:` showing only the `Renamed` chat remains.

- [ ] **Step 4: Delete the harness file and commit**

```bash
rm packages/gateway/src/chats.test-manual.ts
git add packages/gateway/src/chats.ts
git commit -m "feat(gateway): ChatManager with disk persistence"
```

---

### Task 3: Wire `ChatManager` into the gateway

**Files:**
- Modify: `packages/gateway/src/gateway.ts:28-52` (constructor area — fields + init)
- Modify: `packages/core/src/workspace.ts` (cascade delete hook)

- [ ] **Step 1: Instantiate `ChatManager` in the gateway**

In `packages/gateway/src/gateway.ts`, add the import near the top:

```ts
import { ChatManager } from './chats';
```

Add a field and initialize it in the constructor/`initialize` method (place next to `workspaceManager`):

```ts
private chatManager: ChatManager;
```

Inside the initialization where `workspaceManager` is created, after it is available, add:

```ts
this.chatManager = new ChatManager(this.workspaceManager.getWorkspacesRoot());
```

Expose a getter near the other getters:

```ts
getChatManager(): ChatManager { return this.chatManager; }
```

- [ ] **Step 2: Add `getWorkspacesRoot()` to `WorkspaceManager` if missing**

In `packages/core/src/workspace.ts`, if there is not already a public accessor that returns the absolute path to the directory containing all workspace folders, add one:

```ts
getWorkspacesRoot(): string {
  return this.workspacesRoot; // adjust to the existing field name
}
```

If the field is named differently (e.g. `baseDir`, `rootDir`), return that instead. Do not rename existing fields.

- [ ] **Step 3: Cascade-delete chats when a workspace is deleted**

Find the method in `WorkspaceManager` that deletes a workspace (search for `removeWorkspace`, `deleteWorkspace`, or `rmSync` on the workspace directory). After the workspace directory is removed, chats stored under it are already gone from disk, so no extra disk work is needed — but the `ChatManager` cache must be invalidated.

Two acceptable integrations (pick whichever the existing code allows with the smallest diff):

**Option A — Gateway-level hook.** In `packages/gateway/src/gateway.ts`, wherever workspace deletion is invoked, also call:

```ts
this.chatManager.cascadeDeleteWorkspace(workspaceName);
```

**Option B — Emit an event from `WorkspaceManager`.** If `WorkspaceManager` already emits events on deletion, subscribe in the gateway and call `cascadeDeleteWorkspace`.

Use Option A unless there is an existing event surface; do not invent one.

- [ ] **Step 4: Build verification**

```bash
npm --prefix packages/core run build
npm --prefix packages/gateway run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workspace.ts packages/gateway/src/gateway.ts
git commit -m "feat(gateway): wire ChatManager with workspace cascade delete"
```

---

## Phase 2 — Backend: Send path + IPC

### Task 4: `chat-runner.ts` — prompt assembly + concurrency semaphore

**Files:**
- Create: `packages/gateway/src/chat-runner.ts`

- [ ] **Step 1: Create the runner module**

Create `packages/gateway/src/chat-runner.ts`:

```ts
import { Chat, ChatMessage, ToolCallEntry } from '@codey/core';

export const MAX_CONCURRENT_AGENTS = 4;
export const CHAT_CONTEXT_WINDOW = 40;

export type ChatStreamEvent =
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'tool_start'; chatId: string; tool?: string; message: string; input?: Record<string, unknown> }
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string }
  | { type: 'info'; chatId: string; message: string }
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number }
  | { type: 'error'; chatId: string; message: string };

export type ChatStreamSink = (e: ChatStreamEvent) => void;

/** Build the prompt string from the tail of the chat's message history + new user message. */
export function buildChatPrompt(chat: Chat, userText: string, windowSize = CHAT_CONTEXT_WINDOW): string {
  const tail = chat.messages.slice(-windowSize);
  const lines: string[] = [];
  for (const m of tail) {
    const tag = m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${tag}: ${m.content}`);
  }
  lines.push(`User: ${userText}`);
  return lines.join('\n\n');
}

export function assistantPrefixForSelection(chat: Chat): string {
  switch (chat.selection.type) {
    case 'worker': return `[worker:${chat.selection.name}]\n`;
    case 'team': return `[team]\n`;
    default: return '';
  }
}

/** FIFO semaphore bounding concurrent runs. */
export class RunSemaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max = MAX_CONCURRENT_AGENTS) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  get queueLength(): number { return this.queue.length; }
}
```

- [ ] **Step 2: Build verification**

```bash
npm --prefix packages/gateway run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chat-runner.ts
git commit -m "feat(gateway): chat prompt builder + concurrency semaphore"
```

---

### Task 5: `Gateway.sendToChat` method

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (end of class — append method)

- [ ] **Step 1: Add imports**

At the top of `packages/gateway/src/gateway.ts`, add:

```ts
import { ChatMessage, ToolCallEntry } from '@codey/core';
import { randomUUID } from 'crypto';
import { buildChatPrompt, assistantPrefixForSelection, RunSemaphore, ChatStreamEvent, ChatStreamSink } from './chat-runner';
```

Add a field next to other class fields:

```ts
private chatSemaphore = new RunSemaphore();
```

- [ ] **Step 2: Add `sendToChat` method**

Append to the `Codey` class in `packages/gateway/src/gateway.ts`, just before the closing brace:

```ts
async sendToChat(
  chatId: string,
  userText: string,
  sink: ChatStreamSink,
): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> {
  const chat = this.chatManager.get(chatId);
  if (!chat) throw new Error(`Chat not found: ${chatId}`);

  // Queue if at capacity
  if (this.chatSemaphore.queueLength >= 0 && (this.chatSemaphore as any).running >= (this.chatSemaphore as any).max) {
    sink({ type: 'queued', chatId, position: this.chatSemaphore.queueLength + 1 });
  }
  await this.chatSemaphore.acquire();

  const started = Date.now();
  const userMessage: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: userText,
    timestamp: started,
    isComplete: true,
  };
  this.chatManager.appendMessage(chatId, userMessage);

  // Resolve workspace → workingDir
  const ws = this.workspaceManager.getWorkspace(chat.workspaceName);
  if (!ws) {
    this.chatSemaphore.release();
    const msg = `Workspace not found: ${chat.workspaceName}`;
    sink({ type: 'error', chatId, message: msg });
    throw new Error(msg);
  }
  const workingDir = ws.workingDir ?? this.workingDir;

  const agent = this.config.defaultAgent;
  const model = this.getDefaultModelConfig(agent);

  const prompt = assistantPrefixForSelection(chat) + buildChatPrompt(chat, userText);

  const toolCalls: ToolCallEntry[] = [];
  let streamedText = '';

  const onStream = (text: string) => {
    streamedText += text;
    sink({ type: 'stream', chatId, token: text });
  };
  const onStatus = (update: any) => {
    try {
      const parsed = typeof update === 'string' ? JSON.parse(update) : update;
      const entry: ToolCallEntry = {
        id: randomUUID(),
        type: parsed.type ?? 'info',
        tool: parsed.tool,
        message: parsed.message ?? '',
        input: parsed.input,
        output: parsed.output,
      };
      toolCalls.push(entry);
      if (entry.type === 'tool_start') {
        sink({ type: 'tool_start', chatId, tool: entry.tool, message: entry.message, input: entry.input });
      } else if (entry.type === 'tool_end') {
        sink({ type: 'tool_end', chatId, tool: entry.tool, message: entry.message, output: entry.output });
      } else {
        sink({ type: 'info', chatId, message: entry.message });
      }
    } catch { /* non-JSON status */ }
  };

  try {
    const response = await this.runWithFallback(agent, {
      prompt,
      agent,
      model,
      context: { workingDir },
      onStream,
      onStatus,
    });

    const durationSec = Math.round((Date.now() - started) / 1000);
    const output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
    const tokens = (response as any)?.tokens;

    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: output,
      timestamp: Date.now(),
      toolCalls,
      isComplete: true,
      tokens,
      durationSec,
    };
    this.chatManager.appendMessage(chatId, assistantMessage);

    sink({ type: 'done', chatId, response: output, tokens, durationSec });
    return { response: output, chatId, tokens, durationSec };
  } catch (err) {
    const message = `Error: ${(err as Error).message}`;
    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: message,
      timestamp: Date.now(),
      toolCalls,
      isComplete: true,
    };
    this.chatManager.appendMessage(chatId, assistantMessage);
    sink({ type: 'error', chatId, message });
    throw err;
  } finally {
    this.chatSemaphore.release();
  }
}
```

Notes:
- Team execution support is deferred to Task 6 — for now `team` selection falls through to the default agent path with a `[team]` prefix that the agent will ignore. This keeps this task shippable on its own.
- The `RunSemaphore` private-field access uses `as any` — acceptable because the alternative is widening the public surface; a cleaner approach can come later.

- [ ] **Step 3: Build verification**

```bash
npm --prefix packages/gateway run build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): Codey.sendToChat with streaming + persistence"
```

---

### Task 6: Team-selection routing in `sendToChat`

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (replace team fallback from Task 5)

- [ ] **Step 1: Extract team dispatch**

Locate `runTeamTask` (around `gateway.ts:1189`). It currently posts results back through a channel handler. We need a variant that streams through `ChatStreamSink`.

Add a new method on `Codey` (near `runTeamTask`):

```ts
private async runTeamForChat(
  teamName: string,
  prompt: string,
  workingDir: string,
  sink: ChatStreamSink,
  chatId: string,
): Promise<{ response: string; tokens?: number }> {
  // Resolve team; iterate workers in sequence, passing output forward.
  const team = this.config.teams?.[teamName];
  if (!team || team.length === 0) {
    throw new Error(`Team not found or empty: ${teamName}`);
  }
  let carry = prompt;
  const parts: string[] = [];
  for (let i = 0; i < team.length; i++) {
    const workerName = team[i];
    sink({ type: 'info', chatId, message: `Step ${i + 1}/${team.length}: ${workerName}` });
    const stepPrompt = `[${workerName}]\n${carry}`;
    const response = await this.runWithFallback(this.config.defaultAgent, {
      prompt: stepPrompt,
      agent: this.config.defaultAgent,
      model: this.getDefaultModelConfig(this.config.defaultAgent),
      context: { workingDir },
      onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
      onStatus: (update: any) => { /* forwarded by ChatStreamSink elsewhere */ },
    });
    const output = response?.success ? this.formatAgentResponse(response) : '';
    parts.push(`### ${workerName}\n\n${output}`);
    carry = output;
  }
  return { response: parts.join('\n\n---\n\n') };
}
```

If the existing `runTeamTask` references a team-config shape different from `this.config.teams?.[teamName]`, use the same resolution it uses. Do not change `runTeamTask`.

- [ ] **Step 2: Branch inside `sendToChat`**

Replace the `try {` block in `sendToChat` with:

```ts
try {
  let output = '';
  let tokens: number | undefined;
  if (chat.selection.type === 'team') {
    // For the team path, we have to resolve the team name. Today's schema
    // stores team configs keyed by name under config.teams; a chat with
    // selection.type === 'team' means "use the currently active team" —
    // for simplicity, use the first team if there is exactly one, else
    // the first. Users can pick a specific team via selection upgrade later.
    const teamNames = Object.keys(this.config.teams ?? {});
    if (teamNames.length === 0) throw new Error('No teams configured');
    const teamName = teamNames[0];
    const r = await this.runTeamForChat(teamName, prompt, workingDir, sink, chatId);
    output = r.response;
    tokens = r.tokens;
  } else {
    const response = await this.runWithFallback(agent, {
      prompt,
      agent,
      model,
      context: { workingDir },
      onStream,
      onStatus,
    });
    output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
    tokens = (response as any)?.tokens;
  }

  const durationSec = Math.round((Date.now() - started) / 1000);
  const assistantMessage: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: output,
    timestamp: Date.now(),
    toolCalls,
    isComplete: true,
    tokens,
    durationSec,
  };
  this.chatManager.appendMessage(chatId, assistantMessage);
  sink({ type: 'done', chatId, response: output, tokens, durationSec });
  return { response: output, chatId, tokens, durationSec };
} catch (err) {
  const message = `Error: ${(err as Error).message}`;
  const assistantMessage: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: message,
    timestamp: Date.now(),
    toolCalls,
    isComplete: true,
  };
  this.chatManager.appendMessage(chatId, assistantMessage);
  sink({ type: 'error', chatId, message });
  throw err;
} finally {
  this.chatSemaphore.release();
}
```

**Extension point:** `ChatSelection` currently has `{ type: 'team' }` with no team name; the plan intentionally uses the first configured team. If the user later asks to support naming a specific team, extend `ChatSelection` to `{ type: 'team'; name: string }` and read `chat.selection.name` here.

- [ ] **Step 3: Build verification**

```bash
npm --prefix packages/gateway run build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): team-selection path for sendToChat"
```

---

### Task 7: IPC handlers for `chats:*`

**Files:**
- Modify: `codey-mac/electron/main.ts` (append handlers; extend `sendToRenderer` paths)
- Modify: `codey-mac/electron/preload.ts` (expose `chats` + new streaming subscribers)

- [ ] **Step 1: Add IPC handlers in `main.ts`**

In `codey-mac/electron/main.ts`, after the existing `chat:send` handler, append:

```ts
// ── Chats IPC (multi-chat) ────────────────────────────────────────
ipcMain.handle('chats:list', async (_e, workspaceName?: string) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    return inProcessGateway.getChatManager().list(workspaceName)
  })
)

ipcMain.handle('chats:get', async (_e, id: string) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    const c = inProcessGateway.getChatManager().get(id)
    if (!c) throw new Error(`Chat not found: ${id}`)
    return c
  })
)

ipcMain.handle('chats:create', async (_e, input: { workspaceName: string; selection?: any; title?: string }) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    return inProcessGateway.getChatManager().create(input)
  })
)

ipcMain.handle('chats:rename', async (_e, id: string, title: string) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    return inProcessGateway.getChatManager().rename(id, title)
  })
)

ipcMain.handle('chats:delete', async (_e, id: string) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    inProcessGateway.getChatManager().delete(id)
    return null
  })
)

ipcMain.handle('chats:updateSelection', async (_e, id: string, selection: any) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    return inProcessGateway.getChatManager().updateSelection(id, selection)
  })
)

ipcMain.handle('chats:send', async (_e, payload: { chatId: string; text: string }) =>
  wrap(async () => {
    if (!inProcessGateway) throw new Error('Gateway not initialized')
    const sink = (ev: any) => {
      // Mirror each event to the renderer as a single `chats:event` channel
      // so the frontend can route by chatId without sniffing event names.
      sendToRenderer('chats:event', ev)
    }
    return inProcessGateway.sendToChat(payload.chatId, payload.text, sink)
  })
)
```

- [ ] **Step 2: Expose preload surface**

In `codey-mac/electron/preload.ts`, inside the `contextBridge.exposeInMainWorld('codey', { ... })` object, add a `chats` key (alongside `chat`):

```ts
chats: {
  list: (workspaceName?: string) => ipcRenderer.invoke('chats:list', workspaceName),
  get: (id: string) => ipcRenderer.invoke('chats:get', id),
  create: (input: { workspaceName: string; selection?: any; title?: string }) =>
    ipcRenderer.invoke('chats:create', input),
  rename: (id: string, title: string) => ipcRenderer.invoke('chats:rename', id, title),
  delete: (id: string) => ipcRenderer.invoke('chats:delete', id),
  updateSelection: (id: string, selection: any) =>
    ipcRenderer.invoke('chats:updateSelection', id, selection),
  send: (payload: { chatId: string; text: string }) =>
    ipcRenderer.invoke('chats:send', payload),
  onEvent: (handler: (ev: any) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: any) => handler(ev)
    ipcRenderer.on('chats:event', listener)
    return () => ipcRenderer.removeListener('chats:event', listener)
  },
},
```

- [ ] **Step 3: Update `codey-api.d.ts` type declarations**

In `codey-mac/src/codey-api.d.ts`, add typings mirroring the preload surface. Copy existing entries' shape and extend the `codey` interface with:

```ts
chats: {
  list: (workspaceName?: string) => Promise<Result<Chat[]>>
  get: (id: string) => Promise<Result<Chat>>
  create: (input: { workspaceName: string; selection?: ChatSelection; title?: string }) => Promise<Result<Chat>>
  rename: (id: string, title: string) => Promise<Result<Chat>>
  delete: (id: string) => Promise<Result<null>>
  updateSelection: (id: string, selection: ChatSelection) => Promise<Result<Chat>>
  send: (payload: { chatId: string; text: string }) => Promise<Result<{ response: string; chatId: string; tokens?: number; durationSec?: number }>>
  onEvent: (handler: (ev: ChatStreamEvent) => void) => () => void
}
```

Add imports at the top of the file:

```ts
import type { Chat, ChatSelection } from '../../packages/core/src/types/chat'
import type { ChatStreamEvent } from '../../packages/gateway/src/chat-runner'
```

If `Result<T>` is not already defined in this file, scan for the existing result-unwrap shape (`{ ok: true; data: T } | { ok: false; error: string }`) and reuse whatever alias exists.

- [ ] **Step 4: Build verification**

```bash
npm --prefix packages/gateway run build
npm --prefix codey-mac run build
```

Expected: clean builds (Vite + tsc pass).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): expose chats:* IPC and preload surface"
```

---

### Task 8: Smoke-test the full backend via Electron

**Files:** none (exploratory)

- [ ] **Step 1: Launch the app and exercise IPC from DevTools**

```bash
npm --prefix codey-mac run dev
```

Open DevTools (⌘⌥I). In the console run, replacing `<ws>` with an existing workspace name:

```js
const c = await window.codey.chats.create({ workspaceName: '<ws>' })
console.log('created', c)

const off = window.codey.chats.onEvent(ev => console.log('ev', ev))
const result = await window.codey.chats.send({ chatId: c.data.id, text: 'Say hi and nothing else.' })
console.log('result', result)
off()

console.log('list', (await window.codey.chats.list()).data)
```

Expected:
- `created` returns `{ ok: true, data: { id, title: 'New Chat', workspaceName: '<ws>', ... } }`.
- Events stream: some mix of `tool_start` / `stream` / `done`.
- `list` returns an array containing the chat, with a message history length ≥ 2.

- [ ] **Step 2: Verify disk persistence**

From a second terminal:

```bash
ls workspaces/<ws>/chats/
```

Expected: one `<uuid>.json` file; `cat` it to see the full chat shape.

- [ ] **Step 3: Commit (no code change — this is verification)**

If any bug surfaced, fix it inline and commit with `fix(...)`. Otherwise no commit.

---

## Phase 3 — Frontend: Store + API + shell

### Task 9: `apiService.chats` wrapper

**Files:**
- Modify: `codey-mac/src/services/api.ts`
- Modify: `codey-mac/src/types/index.ts` (re-export shared types)

- [ ] **Step 1: Re-export shared types so the Mac app uses one definition**

Replace the local `ChatMessage` and `ToolCallEntry` definitions in `codey-mac/src/types/index.ts` with re-exports. New content for the existing type file (keeping other non-chat types intact):

```ts
export type { ChatMessage, ToolCallEntry, Chat, ChatSelection } from '@codey/core';

// keep existing non-chat types below untouched
// (GatewayStatus, GatewayConfig, Workspace, etc.)
```

If `codey-mac` does not yet resolve `@codey/core` (it lives in its own workspace), check `codey-mac/package.json`. If `@codey/core` is not a dependency, leave the local `ChatMessage`/`ToolCallEntry` definitions intact and instead add a type-only import from the relative path in the files that need `Chat`/`ChatSelection`:

```ts
import type { Chat, ChatSelection } from '../../../packages/core/src/types/chat'
```

- [ ] **Step 2: Add `chats` service methods**

In `codey-mac/src/services/api.ts`, inside the `apiService` object (after `sendMessage`), add:

```ts
chats: {
  list: async (workspaceName?: string): Promise<Chat[]> =>
    unwrap(await window.codey.chats.list(workspaceName)),
  get: async (id: string): Promise<Chat> =>
    unwrap(await window.codey.chats.get(id)),
  create: async (input: { workspaceName: string; selection?: ChatSelection; title?: string }): Promise<Chat> =>
    unwrap(await window.codey.chats.create(input)),
  rename: async (id: string, title: string): Promise<Chat> =>
    unwrap(await window.codey.chats.rename(id, title)),
  delete: async (id: string): Promise<void> => {
    unwrap(await window.codey.chats.delete(id));
  },
  updateSelection: async (id: string, selection: ChatSelection): Promise<Chat> =>
    unwrap(await window.codey.chats.updateSelection(id, selection)),
  send: async (chatId: string, text: string): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> =>
    unwrap(await window.codey.chats.send({ chatId, text })),
  onEvent: (handler: (ev: ChatStreamEvent) => void): (() => void) =>
    window.codey.chats.onEvent(handler),
},
```

Add imports to the top of `api.ts`:

```ts
import type { Chat, ChatSelection } from '../types'
import type { ChatStreamEvent } from '../../../packages/gateway/src/chat-runner'
```

- [ ] **Step 3: Build verification**

```bash
npm --prefix codey-mac run build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/services/api.ts codey-mac/src/types/index.ts
git commit -m "feat(mac): apiService.chats wrapper + unify chat types"
```

---

### Task 10: `useChats` store

**Files:**
- Create: `codey-mac/src/hooks/useChats.tsx`

- [ ] **Step 1: Create the store with reducer + provider**

Create `codey-mac/src/hooks/useChats.tsx`:

```tsx
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { apiService } from '../services/api'
import type { Chat, ChatSelection, ChatMessage, ToolCallEntry } from '../types'
import type { ChatStreamEvent } from '../../../packages/gateway/src/chat-runner'

interface InFlight {
  assistantMessageId: string
  agentStatus: 'idle' | 'thinking' | 'working' | 'writing'
  queuedPosition?: number
}

interface State {
  chats: Record<string, Chat>
  order: string[]                         // newest-updated first
  selectedChatId: string | null
  inFlight: Record<string, InFlight>      // keyed by chatId
  collapsedWorkspaces: Record<string, true>
}

type Action =
  | { type: 'loaded'; chats: Chat[] }
  | { type: 'upsert'; chat: Chat }
  | { type: 'remove'; chatId: string }
  | { type: 'select'; chatId: string | null }
  | { type: 'toggleWorkspace'; workspaceName: string }
  | { type: 'startSend'; chatId: string; userMessage: ChatMessage; assistantMessageId: string }
  | { type: 'streamToken'; chatId: string; token: string }
  | { type: 'toolCall'; chatId: string; entry: ToolCallEntry; status: 'working' | 'writing' }
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'completeSend'; chatId: string; assistantMessageId: string; content: string; tokens?: number; durationSec?: number }
  | { type: 'errorSend'; chatId: string; assistantMessageId: string; error: string }

function reorder(order: string[], chatId: string): string[] {
  return [chatId, ...order.filter(id => id !== chatId)]
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': {
      const chats: Record<string, Chat> = {}
      const sorted = [...action.chats].sort((a, b) => b.updatedAt - a.updatedAt)
      for (const c of sorted) chats[c.id] = c
      return { ...state, chats, order: sorted.map(c => c.id) }
    }
    case 'upsert': {
      const chats = { ...state.chats, [action.chat.id]: action.chat }
      const order = state.order.includes(action.chat.id) ? state.order : [action.chat.id, ...state.order]
      return { ...state, chats, order: reorder(order, action.chat.id) }
    }
    case 'remove': {
      const chats = { ...state.chats }
      delete chats[action.chatId]
      const order = state.order.filter(id => id !== action.chatId)
      const selectedChatId = state.selectedChatId === action.chatId ? (order[0] ?? null) : state.selectedChatId
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return { ...state, chats, order, selectedChatId, inFlight }
    }
    case 'select':
      return { ...state, selectedChatId: action.chatId }
    case 'toggleWorkspace': {
      const collapsed = { ...state.collapsedWorkspaces }
      if (collapsed[action.workspaceName]) delete collapsed[action.workspaceName]
      else collapsed[action.workspaceName] = true
      return { ...state, collapsedWorkspaces: collapsed }
    }
    case 'startSend': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const assistantStub: ChatMessage = {
        id: action.assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [],
        isComplete: false,
      }
      const updated: Chat = {
        ...chat,
        messages: [...chat.messages, action.userMessage, assistantStub],
        updatedAt: Date.now(),
      }
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: updated },
        order: reorder(state.order, chat.id),
        inFlight: {
          ...state.inFlight,
          [chat.id]: { assistantMessageId: action.assistantMessageId, agentStatus: 'thinking' },
        },
      }
    }
    case 'streamToken': {
      const chat = state.chats[action.chatId]
      const fl = state.inFlight[action.chatId]
      if (!chat || !fl) return state
      const messages = chat.messages.map(m =>
        m.id === fl.assistantMessageId ? { ...m, content: m.content + action.token } : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight: { ...state.inFlight, [chat.id]: { ...fl, agentStatus: 'writing' } },
      }
    }
    case 'toolCall': {
      const chat = state.chats[action.chatId]
      const fl = state.inFlight[action.chatId]
      if (!chat || !fl) return state
      const messages = chat.messages.map(m =>
        m.id === fl.assistantMessageId
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), action.entry] }
          : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight: { ...state.inFlight, [chat.id]: { ...fl, agentStatus: action.status } },
      }
    }
    case 'queued': {
      const fl = state.inFlight[action.chatId]
      if (!fl) return state
      return {
        ...state,
        inFlight: { ...state.inFlight, [action.chatId]: { ...fl, queuedPosition: action.position } },
      }
    }
    case 'completeSend': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const messages = chat.messages.map(m =>
        m.id === action.assistantMessageId
          ? { ...m, content: action.content, tokens: action.tokens, durationSec: action.durationSec, isComplete: true }
          : m
      )
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        order: reorder(state.order, chat.id),
        inFlight,
      }
    }
    case 'errorSend': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const messages = chat.messages.map(m =>
        m.id === action.assistantMessageId
          ? { ...m, content: action.error, isComplete: true }
          : m
      )
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight,
      }
    }
    default:
      return state
  }
}

interface ChatsContextValue {
  state: State
  createChat: (workspaceName: string) => Promise<Chat>
  selectChat: (chatId: string | null) => void
  renameChat: (chatId: string, title: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  setSelection: (chatId: string, selection: ChatSelection) => Promise<void>
  sendMessage: (chatId: string, text: string) => Promise<void>
  toggleWorkspace: (workspaceName: string) => void
}

const ChatsContext = createContext<ChatsContextValue | null>(null)

const LS_ACTIVE = 'codey.activeChatId'
const LS_COLLAPSED = 'codey.collapsedWorkspaces'

export const ChatsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, {
    chats: {},
    order: [],
    selectedChatId: null,
    inFlight: {},
    collapsedWorkspaces: (() => {
      try { return JSON.parse(localStorage.getItem(LS_COLLAPSED) ?? '{}') } catch { return {} }
    })(),
  })

  const pendingAssistantId = useRef<Record<string, string>>({})

  // Load chats + restore selection on mount
  useEffect(() => {
    ;(async () => {
      const chats = await apiService.chats.list()
      dispatch({ type: 'loaded', chats })
      const stored = localStorage.getItem(LS_ACTIVE)
      if (stored && chats.some(c => c.id === stored)) {
        dispatch({ type: 'select', chatId: stored })
      } else if (chats.length > 0) {
        dispatch({ type: 'select', chatId: chats[0].id })
      }
    })()
  }, [])

  // Persist active chat
  useEffect(() => {
    if (state.selectedChatId) localStorage.setItem(LS_ACTIVE, state.selectedChatId)
    else localStorage.removeItem(LS_ACTIVE)
  }, [state.selectedChatId])

  // Persist collapsed workspaces
  useEffect(() => {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(state.collapsedWorkspaces))
  }, [state.collapsedWorkspaces])

  // Single subscription to chat events; route by chatId
  useEffect(() => {
    const off = apiService.chats.onEvent((ev: ChatStreamEvent) => {
      switch (ev.type) {
        case 'queued':
          dispatch({ type: 'queued', chatId: ev.chatId, position: ev.position })
          break
        case 'tool_start':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'tool_start', tool: ev.tool, message: ev.message, input: ev.input },
            status: 'working',
          })
          break
        case 'tool_end':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'tool_end', tool: ev.tool, message: ev.message, output: ev.output },
            status: 'working',
          })
          break
        case 'info':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'info', message: ev.message },
            status: 'working',
          })
          break
        case 'stream':
          dispatch({ type: 'streamToken', chatId: ev.chatId, token: ev.token })
          break
        case 'done': {
          const asstId = pendingAssistantId.current[ev.chatId]
          if (asstId) {
            dispatch({
              type: 'completeSend',
              chatId: ev.chatId,
              assistantMessageId: asstId,
              content: ev.response,
              tokens: ev.tokens,
              durationSec: ev.durationSec,
            })
            delete pendingAssistantId.current[ev.chatId]
          }
          break
        }
        case 'error': {
          const asstId = pendingAssistantId.current[ev.chatId]
          if (asstId) {
            dispatch({ type: 'errorSend', chatId: ev.chatId, assistantMessageId: asstId, error: ev.message })
            delete pendingAssistantId.current[ev.chatId]
          }
          break
        }
      }
    })
    return off
  }, [])

  const value = useMemo<ChatsContextValue>(() => ({
    state,
    async createChat(workspaceName) {
      const chat = await apiService.chats.create({ workspaceName })
      dispatch({ type: 'upsert', chat })
      dispatch({ type: 'select', chatId: chat.id })
      return chat
    },
    selectChat(chatId) { dispatch({ type: 'select', chatId }) },
    async renameChat(chatId, title) {
      const chat = await apiService.chats.rename(chatId, title)
      dispatch({ type: 'upsert', chat })
    },
    async deleteChat(chatId) {
      await apiService.chats.delete(chatId)
      dispatch({ type: 'remove', chatId })
    },
    async setSelection(chatId, selection) {
      const chat = await apiService.chats.updateSelection(chatId, selection)
      dispatch({ type: 'upsert', chat })
    },
    async sendMessage(chatId, text) {
      const assistantMessageId = `asst-${Date.now()}-${Math.random()}`
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}-${Math.random()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
        isComplete: true,
      }
      pendingAssistantId.current[chatId] = assistantMessageId
      dispatch({ type: 'startSend', chatId, userMessage, assistantMessageId })
      try {
        await apiService.chats.send(chatId, text)
        // done/error events handled by subscription
      } catch (err) {
        dispatch({ type: 'errorSend', chatId, assistantMessageId, error: `Error: ${(err as Error).message}` })
        delete pendingAssistantId.current[chatId]
      }
    },
    toggleWorkspace(workspaceName) { dispatch({ type: 'toggleWorkspace', workspaceName }) },
  }), [state])

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
}

export function useChats(): ChatsContextValue {
  const ctx = useContext(ChatsContext)
  if (!ctx) throw new Error('useChats must be used inside <ChatsProvider>')
  return ctx
}
```

- [ ] **Step 2: Build verification**

```bash
npm --prefix codey-mac run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx
git commit -m "feat(mac): useChats store with single-subscription event fanout"
```

---

### Task 11: `ChatListPanel` component

**Files:**
- Create: `codey-mac/src/components/ChatListPanel.tsx`

- [ ] **Step 1: Create the component**

Create `codey-mac/src/components/ChatListPanel.tsx`:

```tsx
import React, { useEffect, useState } from 'react'
import { useChats } from '../hooks/useChats'
import { apiService } from '../services/api'
import type { Chat } from '../types'
import { C } from '../theme'

interface Props {
  onOpenSettings: () => void
  activeChatId: string | null
}

export const ChatListPanel: React.FC<Props> = ({ onOpenSettings, activeChatId }) => {
  const { state, createChat, selectChat, renameChat, deleteChat, toggleWorkspace } = useChats()
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [lastWorkspace, setLastWorkspace] = useState<string>('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    apiService.getWorkspaces().then(w => {
      setWorkspaces(w)
      if (w.length > 0) {
        const stored = localStorage.getItem('codey.lastWorkspace')
        setLastWorkspace(stored && w.includes(stored) ? stored : w[0])
      }
    })
  }, [])

  useEffect(() => {
    if (lastWorkspace) localStorage.setItem('codey.lastWorkspace', lastWorkspace)
  }, [lastWorkspace])

  const handleNewChat = async () => {
    if (!lastWorkspace) return
    const chat = await createChat(lastWorkspace)
    setLastWorkspace(chat.workspaceName)
  }

  // Group chats by workspace
  const groups: Record<string, Chat[]> = {}
  for (const id of state.order) {
    const c = state.chats[id]
    if (!c) continue
    ;(groups[c.workspaceName] ??= []).push(c)
  }
  const groupNames = Object.keys(groups).sort()

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <button style={styles.newBtn} onClick={handleNewChat} disabled={!lastWorkspace}>
          + New Chat
        </button>
      </div>
      <div style={styles.scroll}>
        {groupNames.length === 0 && (
          <div style={styles.empty}>No chats yet. Click “New Chat”.</div>
        )}
        {groupNames.map(ws => {
          const collapsed = !!state.collapsedWorkspaces[ws]
          return (
            <div key={ws}>
              <div style={styles.groupHeader} onClick={() => toggleWorkspace(ws)}>
                <span style={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
                <span>{ws}</span>
              </div>
              {!collapsed && groups[ws].map(chat => {
                const active = chat.id === activeChatId
                const flight = state.inFlight[chat.id]
                const isRenaming = renamingId === chat.id
                return (
                  <div
                    key={chat.id}
                    style={{ ...styles.item, background: active ? C.accentDim : 'transparent' }}
                    onClick={() => !isRenaming && selectChat(chat.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenamingId(chat.id)
                      setRenameValue(chat.title)
                    }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={async () => {
                          if (renameValue.trim() && renameValue !== chat.title) {
                            await renameChat(chat.id, renameValue.trim())
                          }
                          setRenamingId(null)
                        }}
                        onKeyDown={async e => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur()
                          } else if (e.key === 'Escape') {
                            setRenamingId(null)
                          }
                        }}
                        style={styles.renameInput}
                      />
                    ) : (
                      <span style={styles.title}>{chat.title}</span>
                    )}
                    {flight && <span style={styles.dot} />}
                    {!isRenaming && (
                      <button
                        style={styles.xBtn}
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (confirm(`Delete chat "${chat.title}"?`)) {
                            await deleteChat(chat.id)
                          }
                        }}
                        title="Delete chat"
                      >×</button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div style={styles.footer}>
        <button style={styles.settingsBtn} onClick={onOpenSettings}>⚙ Settings</button>
      </div>
      <style>{`
        @keyframes codey-pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.7); }
        }
      `}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: 240,
    background: C.surface,
    borderRight: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  header: { padding: '10px 12px', borderBottom: `1px solid ${C.border}` },
  newBtn: {
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${C.border2}`,
    borderRadius: 6,
    background: C.surface3,
    color: C.fg,
    cursor: 'pointer',
    fontSize: 12,
  },
  scroll: { flex: 1, overflowY: 'auto', padding: 6 },
  empty: { color: C.fg3, fontSize: 12, padding: 12, textAlign: 'center' },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 8px', color: C.fg3, fontSize: 11, fontWeight: 600,
    textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none',
  },
  chevron: { fontSize: 10, width: 10 },
  item: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, color: C.fg2, margin: '1px 2px',
  },
  title: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  renameInput: {
    flex: 1, background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 4, padding: '2px 6px', color: C.fg, fontSize: 12, outline: 'none',
  },
  dot: { width: 6, height: 6, borderRadius: '50%', background: C.accent, animation: 'codey-pulse-dot 1.2s infinite' },
  xBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 14, padding: '0 4px',
  },
  footer: { padding: 8, borderTop: `1px solid ${C.border}` },
  settingsBtn: {
    width: '100%', padding: '8px 10px', border: 'none',
    background: 'transparent', color: C.fg2, cursor: 'pointer',
    textAlign: 'left', borderRadius: 6, fontSize: 12,
  },
}
```

- [ ] **Step 2: Build verification**

```bash
npm --prefix codey-mac run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/ChatListPanel.tsx
git commit -m "feat(mac): ChatListPanel with groups, rename, delete"
```

---

### Task 12: `SettingsOverlay` component

**Files:**
- Create: `codey-mac/src/components/SettingsOverlay.tsx`

- [ ] **Step 1: Create the overlay**

Create `codey-mac/src/components/SettingsOverlay.tsx`:

```tsx
import React, { useEffect, useState } from 'react'
import { StatusTab } from './StatusTab'
import { SettingsTab } from './SettingsTab'
import { WorkspacesTab } from './WorkspacesTab'
import WorkersTab from './WorkersTab'
import { useGateway } from '../hooks/useGateway'
import { C } from '../theme'

type Tab = 'workers' | 'workspaces' | 'status' | 'settings'
const TABS: { key: Tab; label: string }[] = [
  { key: 'workers',    label: 'Workers' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'status',     label: 'Status' },
  { key: 'settings',   label: 'Settings' },
]

interface Props { onClose: () => void }

export const SettingsOverlay: React.FC<Props> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('settings')
  const { isRunning, status, logs } = useGateway()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div style={styles.tabs}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                ...styles.tabBtn,
                color: tab === t.key ? C.fg : C.fg3,
                borderBottom: tab === t.key ? `2px solid ${C.accent}` : '2px solid transparent',
              }}
            >{t.label}</button>
          ))}
        </div>
        <button onClick={onClose} style={styles.closeBtn} title="Close (Esc)">×</button>
      </div>
      <div style={styles.body}>
        {tab === 'status'     && <StatusTab status={status} logs={logs} isRunning={isRunning} />}
        {tab === 'workspaces' && <WorkspacesTab isGatewayRunning={isRunning} onWorkspaceChange={() => {}} />}
        {tab === 'workers'    && <WorkersTab />}
        {tab === 'settings'   && <SettingsTab isGatewayRunning={isRunning} />}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'absolute', inset: 0, background: C.bg,
    display: 'flex', flexDirection: 'column', zIndex: 50,
  },
  header: {
    display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 8px',
    flexShrink: 0, background: C.surface,
  },
  tabs: { display: 'flex', flex: 1, gap: 4 },
  tabBtn: {
    background: 'transparent', border: 'none', padding: '12px 14px',
    cursor: 'pointer', fontSize: 13, fontWeight: 500,
  },
  closeBtn: {
    background: 'transparent', border: 'none', fontSize: 20,
    color: C.fg3, cursor: 'pointer', padding: '4px 10px',
  },
  body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
}
```

- [ ] **Step 2: Build verification**

```bash
npm --prefix codey-mac run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/SettingsOverlay.tsx
git commit -m "feat(mac): SettingsOverlay wraps Workers/Workspaces/Status/Settings"
```

---

### Task 13: Rewire `App.tsx`

**Files:**
- Modify: `codey-mac/src/App.tsx` (full replacement — see below)

- [ ] **Step 1: Replace `App.tsx`**

Replace the entire file with:

```tsx
import React, { useState } from 'react'
import { ChatTab } from './components/ChatTab'
import { ChatListPanel } from './components/ChatListPanel'
import { SettingsOverlay } from './components/SettingsOverlay'
import { ChatsProvider, useChats } from './hooks/useChats'
import { useGateway } from './hooks/useGateway'
import { C } from './theme'

const Shell: React.FC = () => {
  const { isRunning } = useGateway()
  const { state } = useChats()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeChat = state.selectedChatId ? state.chats[state.selectedChatId] : null

  return (
    <div style={styles.root}>
      <div style={styles.titleBar}>
        <div style={styles.titleBarDragArea}>
          <div style={{ width: 76 }} />
          <div style={styles.titleCenter}>
            <span style={styles.appName}>Codey</span>
            {activeChat && <span style={styles.workspaceLabel}>· {activeChat.workspaceName}</span>}
          </div>
        </div>
        <div style={{
          ...styles.statusPill,
          borderColor: C.green + '55',
          background: '#32D74B11',
          color: C.green,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.green }} />
          Running
        </div>
      </div>
      <div style={styles.body}>
        <ChatListPanel
          onOpenSettings={() => setSettingsOpen(true)}
          activeChatId={state.selectedChatId}
        />
        <div style={styles.content}>
          {/* Render every loaded chat, show only the active one. Keeps
              parallel streams flowing when the user switches. */}
          {Object.values(state.chats).map(chat => (
            <div
              key={chat.id}
              style={{
                display: state.selectedChatId === chat.id ? 'flex' : 'none',
                flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden',
              }}
            >
              <ChatTab chatId={chat.id} isGatewayRunning={isRunning} />
            </div>
          ))}
          {!activeChat && (
            <div style={styles.emptyMain}>
              {state.order.length === 0
                ? 'No chats yet. Click “New Chat” on the left to start.'
                : 'Select a chat on the left.'}
            </div>
          )}
        </div>
        {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}
      </div>
      <style>{`
        html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
        body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: ${C.fg}; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
        textarea, input, select, button { font-family: inherit; }
        input, select, textarea { color: ${C.fg}; }
        @keyframes codey-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  )
}

const App: React.FC = () => (
  <ChatsProvider>
    <Shell />
  </ChatsProvider>
)

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.fg },
  titleBar: {
    height: 44, background: C.surface, borderBottom: `1px solid ${C.border}`,
    display: 'flex', alignItems: 'center', padding: '0 14px 0 0', flexShrink: 0,
    // @ts-ignore Electron
    WebkitAppRegion: 'drag',
  },
  titleBarDragArea: { flex: 1, display: 'flex', alignItems: 'center', height: '100%' },
  titleCenter: { flex: 1, textAlign: 'center', paddingRight: 76 },
  appName: { color: C.fg2, fontSize: 13, fontWeight: 500 },
  workspaceLabel: { color: C.fg3, fontSize: 11, marginLeft: 6 },
  statusPill: {
    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
    borderRadius: 6, border: '1px solid', fontSize: 11, fontWeight: 600,
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' },
  content: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  emptyMain: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.fg3 },
}

export default App
```

- [ ] **Step 2: Build verification**

This will fail — `ChatTab` does not yet take a `chatId` prop. That is expected; Task 14 fixes it. For now:

```bash
npm --prefix codey-mac run build
```

Expected: a TS error on `<ChatTab chatId={...} />` because `ChatTab` doesn't accept `chatId`. This confirms the refactor signal — proceed to Task 14 immediately; do not commit yet.

---

### Task 14: Refactor `ChatTab` to `chatId`-keyed + new top bar

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx` (full replacement)

- [ ] **Step 1: Replace `ChatTab.tsx`**

Replace the entire file with:

```tsx
import React, { useEffect, useRef, useState } from 'react'
import type { ChatSelection } from '../types'
import { apiService, WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { Markdown } from './Markdown'

interface Props {
  chatId: string
  isGatewayRunning: boolean
}

const SendIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" />
  </svg>
)

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

const TypingDots: React.FC = () => {
  const [n, setN] = useState(0)
  useEffect(() => { const t = setInterval(() => setN(v => (v + 1) % 4), 400); return () => clearInterval(t) }, [])
  return <span style={{ letterSpacing: 2 }}>{'●'.repeat(n + 1).padEnd(3, '○')}</span>
}

export const ChatTab: React.FC<Props> = ({ chatId, isGatewayRunning }) => {
  const { state, sendMessage, setSelection, renameChat } = useChats()
  const chat = state.chats[chatId]
  const flight = state.inFlight[chatId]

  const [input, setInput] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { apiService.listWorkers().then(setWorkers) }, [])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat?.messages?.length])

  if (!chat) return null

  const selectionValue: string = chat.selection.type === 'worker'
    ? `worker:${chat.selection.name}`
    : chat.selection.type === 'team'
      ? 'team'
      : 'none'

  const onSelectionChange = async (v: string) => {
    let next: ChatSelection
    if (v === 'none') next = { type: 'none' }
    else if (v === 'team') next = { type: 'team' }
    else next = { type: 'worker', name: v.slice('worker:'.length) }
    await setSelection(chat.id, next)
  }

  const send = async () => {
    if (!input.trim() || !isGatewayRunning || !!flight) return
    const text = input
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    await sendMessage(chat.id, text)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const isSending = !!flight
  const canSend = isGatewayRunning && !isSending && !!input.trim()
  const statusLabel = flight?.queuedPosition
    ? `Queued (#${flight.queuedPosition})`
    : flight?.agentStatus === 'thinking' ? 'Thinking…'
    : flight?.agentStatus === 'working'  ? 'Working…'
    : flight?.agentStatus === 'writing'  ? 'Writing…'
    : ''

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={async () => {
              if (titleDraft.trim() && titleDraft !== chat.title) await renameChat(chat.id, titleDraft.trim())
              setEditingTitle(false)
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingTitle(false) }}
            style={styles.titleInput}
          />
        ) : (
          <span style={styles.title} onDoubleClick={() => { setEditingTitle(true); setTitleDraft(chat.title) }}>
            {chat.title}
          </span>
        )}
        <span style={styles.workspaceTag}>{chat.workspaceName}</span>
        <div style={{ flex: 1 }} />
        <select value={selectionValue} onChange={e => onSelectionChange(e.target.value)} style={styles.workerSelect}>
          <option value="none">No worker</option>
          <option value="team">Team</option>
          {workers.map(w => <option key={w.name} value={`worker:${w.name}`}>{w.name}</option>)}
        </select>
      </div>

      <div style={styles.messages}>
        {chat.messages.map(msg => {
          const isUser = msg.role === 'user'
          return (
            <div key={msg.id} style={{
              display: 'flex', flexDirection: 'column',
              alignItems: isUser ? 'flex-end' : 'flex-start',
              marginBottom: 12,
            }}>
              <div style={{
                maxWidth: '72%', padding: '10px 14px',
                borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: isUser ? C.userBg : C.aiBg,
                color: C.fg, fontSize: 13, lineHeight: 1.55, wordBreak: 'break-word',
                boxShadow: isUser ? 'none' : '0 1px 3px rgba(0,0,0,0.3)',
                border: isUser ? 'none' : `1px solid ${C.border2}`,
              }}>
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <>
                    <div style={styles.toolCallsContainer}>
                      {msg.toolCalls.map(tc => {
                        const isExpanded = expandedIds.has(tc.id)
                        const hasDetail = tc.type === 'tool_start' && !!tc.input
                        const toggle = () => setExpandedIds(prev => {
                          const next = new Set(prev)
                          next.has(tc.id) ? next.delete(tc.id) : next.add(tc.id)
                          return next
                        })
                        return (
                          <div key={tc.id}>
                            <div
                              style={{
                                ...styles.toolCallRow,
                                ...(tc.type === 'tool_end' ? styles.toolCallEnd : {}),
                                ...(tc.type === 'info' ? styles.toolCallInfo : {}),
                                cursor: hasDetail ? 'pointer' : 'default',
                              }}
                              onClick={hasDetail ? toggle : undefined}
                            >
                              {tc.type === 'tool_end' && '✓ '}
                              {tc.type === 'info' && '• '}
                              {hasDetail && (
                                <span style={{ ...styles.chevron, transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                              )}
                              <span style={{ marginLeft: 2 }}>{tc.message}</span>
                            </div>
                            {hasDetail && isExpanded && (
                              <div style={styles.toolDetail}>
                                {tc.input && (<><div style={styles.detailLabel}>Input:</div><pre style={styles.detailPre}>{JSON.stringify(tc.input, null, 2)}</pre></>)}
                                {tc.output && (<><div style={styles.detailLabel}>Output:</div><pre style={styles.detailPre}>{tc.output}</pre></>)}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {msg.content && <div style={styles.toolCallSep} />}
                  </>
                )}
                {msg.content && <Markdown variant={isUser ? 'user' : 'assistant'}>{msg.content}</Markdown>}
              </div>
              <div style={styles.tsLabel}>
                <span>{fmtTime(msg.timestamp)}</span>
                {(msg.tokens != null || msg.durationSec != null) && (
                  <span style={styles.tsMeta}>
                    {msg.tokens != null && `${formatTokens(msg.tokens)} tok`}
                    {msg.tokens != null && msg.durationSec != null && ' · '}
                    {msg.durationSec != null && `${msg.durationSec}s`}
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {statusLabel && (
          <div style={styles.typingRow}>
            <TypingDots />
            <span>{statusLabel}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={styles.inputContainer}>
        <textarea
          ref={taRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          onInput={e => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 120) + 'px'
          }}
          placeholder={isGatewayRunning ? (isSending ? 'Sending…' : 'Message Codey… (↵ to send)') : 'Start gateway to chat'}
          disabled={!isGatewayRunning || isSending}
          rows={1}
          style={styles.input}
        />
        <button
          onClick={send}
          disabled={!canSend}
          style={{ ...styles.sendButton, background: canSend ? C.accent : C.surface3, cursor: canSend ? 'pointer' : 'default' }}
        >
          <SendIcon color={canSend ? '#fff' : C.fg3} />
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  header: {
    padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
  },
  title: { color: C.fg, fontSize: 13, fontWeight: 600, cursor: 'text' },
  titleInput: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 6px', color: C.fg, fontSize: 13, outline: 'none' },
  workspaceTag: { color: C.fg3, fontSize: 11 },
  workerSelect: {
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6,
    color: C.fg2, fontSize: 12, padding: '4px 8px', outline: 'none',
  },
  messages: { flex: 1, overflowY: 'auto', padding: 16 },
  typingRow: { display: 'flex', alignItems: 'center', gap: 8, color: C.fg3, fontSize: 13, marginBottom: 12 },
  tsLabel: { color: C.fg3, fontSize: 10, marginTop: 4, paddingLeft: 4, paddingRight: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tsMeta: { color: C.fg3, opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
  inputContainer: { padding: '12px 14px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 },
  input: {
    flex: 1, background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 10,
    color: C.fg, fontSize: 13, padding: '10px 12px', outline: 'none', resize: 'none',
    lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
  },
  sendButton: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 0.15s',
  },
  toolCallsContainer: { marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 2 },
  toolCallRow: {
    display: 'flex', alignItems: 'flex-start', fontSize: 12,
    color: '#6ab0f3', fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '2px 0', userSelect: 'text',
  },
  toolCallEnd: { color: '#5c5' },
  toolCallInfo: { color: '#888', fontStyle: 'italic' },
  toolCallSep: { borderTop: `1px solid ${C.border2}`, marginBottom: 6, marginTop: 4 },
  chevron: { display: 'inline-block', fontSize: 10, marginRight: 4, transition: 'transform 0.15s ease', color: '#555' },
  toolDetail: { marginLeft: 20, marginTop: 4, marginBottom: 6, padding: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 6, border: `1px solid ${C.border}` },
  detailLabel: { fontSize: 11, color: '#666', fontFamily: 'Menlo, Monaco, "Courier New", monospace', marginBottom: 4, textTransform: 'uppercase' },
  detailPre: { margin: 0, fontSize: 11, color: '#ccc', fontFamily: 'Menlo, Monaco, "Courier New", monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
}
```

- [ ] **Step 2: Build verification**

```bash
npm --prefix codey-mac run build
```

Expected: clean build (both `App.tsx` and `ChatTab.tsx` compile now).

- [ ] **Step 3: Commit both App and ChatTab together**

```bash
git add codey-mac/src/App.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): multi-chat shell — App rewire + ChatTab refactor"
```

---

### Task 15: End-to-end smoke test

**Files:** none (exploratory)

- [ ] **Step 1: Run the app**

```bash
npm --prefix codey-mac run dev
```

- [ ] **Step 2: Verify flows**

For each step below, observe the stated outcome. If a step fails, file the fix as a follow-up task; do not force-continue.

1. With no chats, left panel shows "New Chat" button and empty state.
2. Click **New Chat** → a chat appears under the last-used workspace; auto-selected; input focused.
3. Send a short message (`"Say hi"`). Typing dots show; tokens stream; final message persists with token count / duration.
4. Click **New Chat** again in a second workspace (switch via Settings overlay → Workspaces if needed). Send a longer prompt.
5. Switch back to the first chat while the second is still responding — the dot indicator stays on chat #2 in the list; content keeps arriving in the background.
6. Switch back to chat #2 — final answer present.
7. Double-click a chat's title in the list → rename → persists after restart (quit + relaunch).
8. Right-click / hover-X → delete → chat disappears; its JSON file gone from `workspaces/<ws>/chats/`.
9. Change the selection dropdown to `Team` → send a message; verify the team path runs (see step labels in the tool-calls stream).
10. Open Settings overlay → confirm Workers/Workspaces/Status/Settings tabs render; `Esc` closes it.

- [ ] **Step 3: Commit any fixes found**

Apply with `fix(mac): ...` messages.

---

## Phase 4 — Polish

### Task 16: Orphaned-chat handling

**Files:**
- Modify: `codey-mac/src/components/ChatListPanel.tsx`
- Modify: `codey-mac/src/hooks/useChats.tsx` (load workspaces list once)

- [ ] **Step 1: Load the workspace list into the store**

Extend state in `useChats.tsx`:

```ts
interface State {
  // ...existing...
  workspaces: string[]
}
```

Add action + reducer case:

```ts
| { type: 'setWorkspaces'; workspaces: string[] }
// reducer:
case 'setWorkspaces':
  return { ...state, workspaces: action.workspaces }
```

On mount, after `chats.list`:

```ts
const workspaces = await apiService.getWorkspaces()
dispatch({ type: 'setWorkspaces', workspaces })
```

Initialize `workspaces: []` in `useReducer`.

- [ ] **Step 2: Mark orphans in `ChatListPanel`**

Inside the chat row in `ChatListPanel.tsx`, compute:

```tsx
const orphaned = !state.workspaces.includes(chat.workspaceName)
```

Apply greyed style when orphaned and block navigation into the input:

```tsx
style={{
  ...styles.item,
  background: active ? C.accentDim : 'transparent',
  opacity: orphaned ? 0.5 : 1,
}}
title={orphaned ? 'Workspace deleted' : undefined}
```

In `ChatTab.tsx`, disable the send button if the chat's workspace is not in `state.workspaces` (import `useChats` to read it). Add a banner above the input:

```tsx
{!state.workspaces.includes(chat.workspaceName) && (
  <div style={styles.orphanBanner}>
    Workspace "{chat.workspaceName}" no longer exists. Sending is disabled.
  </div>
)}
```

Add the style:

```ts
orphanBanner: {
  padding: '8px 12px',
  background: '#ff950033',
  color: '#ffb84d',
  fontSize: 12,
  borderTop: `1px solid ${C.border}`,
},
```

- [ ] **Step 3: Build + manual verify**

```bash
npm --prefix codey-mac run build
npm --prefix codey-mac run dev
```

Manually: create a chat in workspace `A`, quit the app, delete workspace `A`'s folder under `workspaces/`, relaunch. The chat is shown greyed out; sending is disabled; the orphan banner is visible.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx codey-mac/src/components/ChatListPanel.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): orphan-workspace handling for chats"
```

---

### Task 17: Keyboard shortcuts

**Files:**
- Modify: `codey-mac/src/App.tsx`

- [ ] **Step 1: Wire global shortcuts**

Inside `Shell`, add:

```tsx
import { useEffect } from 'react'

// …inside Shell, next to other hooks:
const { state, createChat, selectChat } = useChats()

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    const isMeta = e.metaKey || e.ctrlKey
    if (!isMeta) return
    if (e.key === 'n') {
      e.preventDefault()
      const ws = localStorage.getItem('codey.lastWorkspace')
      if (ws) createChat(ws)
    } else if (e.key === ',') {
      e.preventDefault()
      setSettingsOpen(true)
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1
      const id = state.order[idx]
      if (id) { e.preventDefault(); selectChat(id) }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [state.order, createChat, selectChat])
```

Make sure `useChats()` is already called above this effect (it is, from earlier edits).

- [ ] **Step 2: Build + manual verify**

```bash
npm --prefix codey-mac run build
npm --prefix codey-mac run dev
```

Verify: `⌘N` creates a chat; `⌘,` opens settings; `⌘1`/`⌘2` jump between chats.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/App.tsx
git commit -m "feat(mac): keyboard shortcuts ⌘N / ⌘, / ⌘1..9"
```

---

### Task 18: Full-plan regression sweep

**Files:** none (verification)

- [ ] **Step 1: Re-run the Task 15 scenarios**

Repeat the ten-step flow from Task 15. Everything must still pass, with orphaned chats and shortcuts added.

- [ ] **Step 2: Verify parallel streaming**

Create two chats. Send a message in each back-to-back without waiting. Switch between them repeatedly while both run. Expected: both complete; order-indicator dots in the list reflect live state; neither response is cross-pollinated into the other chat.

- [ ] **Step 3: Verify restart persistence**

Quit the app, relaunch. The last-active chat is restored. Collapsed workspace groups remembered. Settings overlay is closed.

- [ ] **Step 4: Verify concurrency cap**

Temporarily lower `MAX_CONCURRENT_AGENTS` to `1` in `packages/gateway/src/chat-runner.ts`, rebuild the gateway, relaunch. Send in two chats — the second should show `Queued (#1)` before running. Restore the value to `4` and rebuild.

- [ ] **Step 5: No commit**

Only commit if regressions surfaced and were fixed.

---

## Phase 5 — Cleanup

### Task 19: Prune dead code from the pre-multi-chat path

**Files:**
- Modify: `codey-mac/src/App.tsx`
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Confirm nothing references the old single-chat `messages` state**

Search:

```bash
grep -n "setMessages\|ChatMessage\[\]" codey-mac/src/ -r
```

Any hits outside `useChats.tsx` and `ChatTab.tsx`'s toolcall render are leftovers. Remove.

- [ ] **Step 2: Remove the `TabType`/`navItems`/`icons` code path**

These were removed in Task 13. Confirm none remains:

```bash
grep -n "TabType\|navItems\|useGateway\b" codey-mac/src/App.tsx
```

`useGateway` should still be present (for `isRunning`). `TabType`/`navItems` should not.

- [ ] **Step 3: Build + manual re-verify a core flow**

```bash
npm --prefix codey-mac run build
```

Expected: clean build. Open the app, send a message, quit — one last sanity pass.

- [ ] **Step 4: Commit (if any changes)**

```bash
git commit -am "chore(mac): drop unused single-chat scaffolding"
```

---

## Spec Coverage Check

| Spec section                              | Task(s)       |
| ----------------------------------------- | ------------- |
| Data model (types, on-disk shape)         | 1, 2          |
| Write strategy (atomic rename, one-per-turn) | 2          |
| Agent context window (last 40)            | 4             |
| Cascading delete on workspace removal     | 3             |
| `ChatManager` API                         | 2, 3          |
| `sendToChat` + streaming                  | 5, 6          |
| Concurrency cap + queued status           | 4, 5          |
| Team selection path                       | 6             |
| IPC `chats:*` + preload                   | 7             |
| Streaming tagged with `chatId`            | 7, 10         |
| Left chat list + grouping + rename/delete | 11            |
| Settings overlay                          | 12            |
| App rewire; chats kept mounted            | 13            |
| ChatTab refactor to `chatId` + selection dropdown | 14    |
| Auto-title from first user message        | 2             |
| LocalStorage: active chat, collapsed groups | 10          |
| Error handling (send failure, timeout, corrupt JSON, orphan, queued) | 2, 5, 16 |
| Migration (no-op, empty start)            | implicit      |
| Manual testing scenarios                  | 8, 15, 18     |
| Keyboard shortcuts (⌘N / ⌘, / ⌘1..9)      | 17            |
| Explicit out-of-scope items               | (not built)   |

All spec sections have at least one task. No placeholders remain (every code block is complete or references an existing, verifiable shape). Method names used across tasks (`create`, `rename`, `updateSelection`, `delete`, `appendMessage`, `cascadeDeleteWorkspace`, `sendToChat`) match between backend definitions (Tasks 2, 3, 5) and frontend consumers (Tasks 7, 9, 10).
