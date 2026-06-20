import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Chat, ChatCompaction, ChatMessage, ChatSelection, ChatRoute, ChannelKind, TaskBrief } from '@codey/core';
import { Logger } from './logger';

const log = Logger.getInstance();

export interface CreateChatInput {
  workspaceName: string;
  selection?: ChatSelection;
  title?: string;
}

/**
 * Async hook that produces a new ChatCompaction for `chat`. Called from
 * appendMessage when the unsummarized tail crosses the threshold. Implementor
 * (gateway) decides which messages to fold and runs the Aide. Returning null
 * signals "not enough new material yet" or "skip".
 */
export type CompactionRunner = (chat: Chat) => Promise<ChatCompaction | null>;

/** Append at least this many uncompacted messages before triggering. */
const COMPACTION_TRIGGER_UNSUMMARIZED = 80;

export class ChatManager {
  private cache = new Map<string, Chat>();
  private loaded = false;
  private compactionRunner?: CompactionRunner;
  private compactingChats = new Set<string>();

  constructor(private readonly workspacesRoot: string) {}

  /**
   * Wire the Aide-backed compaction job. The gateway calls this once at boot.
   * Without a runner, appendMessage just skips compaction entirely — safe
   * default for tests and tooling that don't need a live LLM.
   */
  setCompactionRunner(runner: CompactionRunner | undefined): void {
    this.compactionRunner = runner;
  }

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
            // Heal titles persisted before the fallback banner was moved out of
            // the response text: such titles are just the leaked "[Fallback: …]"
            // line. Re-derive from the first user message and persist once.
            if (chat.title && /^\[Fallback:/.test(chat.title)) {
              const firstUser = chat.messages?.find(m => m.role === 'user');
              chat.title = firstUser ? deriveTitle(firstUser.content) : 'New Chat';
              this.cache.set(chat.id, chat);
              this.persist(chat);
            } else {
              this.cache.set(chat.id, chat);
            }
          }
        } catch (err) {
          log.warn(`ChatManager: skipped corrupt chat file ${full}: ${(err as Error).message}`);
        }
      }
    }
    this.reconcileExclusiveRoutes();
  }

  /**
   * Enforce the one-channel-one-chat invariant for routes already on disk.
   * Before addRoute became exclusive, the same (channel, channelUserId) could
   * end up attached to multiple chats — leaving stale ✈ icons in the UI.
   * Keep it on the most recently updated chat; strip from the rest.
   */
  private reconcileExclusiveRoutes(): void {
    const owner = new Map<string, Chat>();
    for (const chat of this.cache.values()) {
      if (!chat.routes?.length) continue;
      for (const r of chat.routes) {
        const key = `${r.channel}:${r.channelUserId}`;
        const incumbent = owner.get(key);
        if (!incumbent || chat.updatedAt > incumbent.updatedAt) owner.set(key, chat);
      }
    }
    for (const chat of this.cache.values()) {
      if (!chat.routes?.length) continue;
      const before = chat.routes.length;
      chat.routes = chat.routes.filter(r =>
        owner.get(`${r.channel}:${r.channelUserId}`)?.id === chat.id
      );
      if (chat.routes.length !== before) {
        this.persist(chat);
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
    const changedKind = chat.selection.type !== selection.type
      || (chat.selection.type === selection.type && (chat.selection as { name?: string }).name !== (selection as { name?: string }).name);
    chat.selection = selection;
    if (changedKind) delete chat.sessionAnchor;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  /** Persist the warm CLI session for this chat. */
  setSessionAnchor(chatId: string, anchor: NonNullable<Chat['sessionAnchor']>): void {
    const chat = this.cache.get(chatId);
    if (!chat) return;
    chat.sessionAnchor = anchor;
    chat.updatedAt = Date.now();
    this.persist(chat);
  }

  /** Drop the warm CLI session — next turn will bootstrap. */
  clearSessionAnchor(chatId: string): void {
    const chat = this.cache.get(chatId);
    if (!chat || !chat.sessionAnchor) return;
    delete chat.sessionAnchor;
    chat.updatedAt = Date.now();
    this.persist(chat);
  }

  /**
   * Set or clear the per-chat agent/model override. Pass `undefined` (or null
   * via JSON) to clear a field and fall back to the gateway default.
   */
  updateAgentModel(chatId: string, agent?: Chat['agent'] | null, model?: string | null): Chat {
    const chat = this.requireChat(chatId);
    const prevAgent = chat.agent;
    if (agent === null || agent === undefined) delete chat.agent;
    else chat.agent = agent;
    if (model === null || model === undefined || model === '') delete chat.model;
    else chat.model = model;
    if (chat.agent !== prevAgent) delete chat.sessionAnchor;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  /** Set or clear the per-chat context-panel preference. Pass null to clear
   *  (returns to "undecided" so auto-open logic applies again). */
  updateContextPanelOpen(chatId: string, open: boolean | null): Chat {
    const chat = this.requireChat(chatId);
    if (open === null) delete chat.contextPanelOpen;
    else chat.contextPanelOpen = open;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  /** Set or clear the per-chat solo-advisor toggle. */
  setSoloAdvisor(chatId: string, enabled: boolean): Chat {
    const chat = this.requireChat(chatId);
    if (enabled) chat.soloAdvisor = true;
    else delete chat.soloAdvisor;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  /** Set lastAskedOptions on a non-team chat (the question message id + options). */
  setLastAskedOptions(chatId: string, messageId: string, options: string[]): void {
    const chat = this.cache.get(chatId);
    if (!chat) return;
    chat.lastAskedOptions = { messageId, options };
    chat.updatedAt = Date.now();
    this.persist(chat);
  }

  /** Cache the on-demand Task HUD brief. Does NOT bump updatedAt so that
   *  staleness can be detected via `chat.updatedAt > taskBrief.generatedAt`. */
  setTaskBrief(chatId: string, brief: TaskBrief): void {
    const chat = this.cache.get(chatId);
    if (!chat) return;
    chat.taskBrief = brief;
    this.persist(chat);
  }

  /** Clear lastAskedOptions when the user sends any reply. */
  clearLastAskedOptions(chatId: string): void {
    const chat = this.cache.get(chatId);
    if (!chat || !chat.lastAskedOptions) return;
    delete chat.lastAskedOptions;
    chat.updatedAt = Date.now();
    this.persist(chat);
  }

  /** Set or clear pendingTeam state for a chat. Pass null to clear. */
  setPendingTeam(chatId: string, pending: NonNullable<Chat['pendingTeam']> | null): Chat {
    this.ensureLoaded();
    const chat = this.cache.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    if (pending) chat.pendingTeam = pending;
    else delete chat.pendingTeam;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }

  delete(chatId: string): void {
    const chat = this.cache.get(chatId);
    if (!chat) return;
    const file = this.chatFile(chat.workspaceName, chat.id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const chatDir = path.join(this.workspacesRoot, chat.workspaceName, 'chats', chatId);
    if (fs.existsSync(chatDir)) {
      fs.rmSync(chatDir, { recursive: true, force: true });
    }
    this.cache.delete(chatId);
  }

  /**
   * Remove a message by id and persist. Used when a turn is aborted and we
   * want to roll the conversation back so the user can re-edit the prompt.
   */
  removeMessage(chatId: string, messageId: string): Chat | undefined {
    const chat = this.cache.get(chatId);
    if (!chat) return undefined;
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return chat;
    chat.messages.splice(idx, 1);
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
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
    this.maybeScheduleCompaction(chat);
    return chat;
  }

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

  /**
   * Kick off a background compaction job if the unsummarized tail has grown
   * past the threshold and one isn't already running for this chat. Errors
   * are logged and swallowed — compaction is best-effort and never blocks a
   * user-visible turn. The next turn after success picks up the new summary
   * via `buildChatBootstrapPrompt`.
   */
  private maybeScheduleCompaction(chat: Chat): void {
    if (!this.compactionRunner) return;
    const already = chat.compaction?.summarizedUpTo ?? 0;
    const unsummarized = chat.messages.length - already;
    if (unsummarized < COMPACTION_TRIGGER_UNSUMMARIZED) return;
    if (this.compactingChats.has(chat.id)) return;
    this.compactingChats.add(chat.id);
    // Run in a microtask so the caller (turn completion) returns immediately.
    queueMicrotask(async () => {
      try {
        const next = await this.compactionRunner!(chat);
        if (next) {
          const current = this.cache.get(chat.id);
          if (current) {
            current.compaction = next;
            this.persist(current);
          }
        }
      } catch (err) {
        log.warn(`ChatManager: compaction failed for ${chat.id}: ${(err as Error).message}`);
      } finally {
        this.compactingChats.delete(chat.id);
      }
    });
  }

  /**
   * Update the `workspaceName` field on every chat that referenced `oldName`
   * after the workspace folder has been renamed on disk. The chat files
   * themselves move with the folder; this just rewrites the in-memory cache
   * and re-persists each chat under its new path.
   */
  cascadeRenameWorkspace(oldName: string, newName: string): void {
    this.ensureLoaded();
    for (const chat of this.cache.values()) {
      if (chat.workspaceName !== oldName) continue;
      chat.workspaceName = newName;
      this.persist(chat);
    }
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

  addRoute(chatId: string, route: ChatRoute): Chat {
    this.ensureLoaded();
    const chat = this.requireChat(chatId);
    // A given (channel, channelUserId) is exclusive: one channel-user maps to
    // one chat at a time. Strip the route from every other chat first so the
    // UI doesn't end up showing two chats as "linked" to the same Telegram /
    // Discord / iMessage user.
    for (const other of this.cache.values()) {
      if (other.id === chatId || !other.routes?.length) continue;
      const before = other.routes.length;
      other.routes = other.routes.filter(r =>
        !(r.channel === route.channel && r.channelUserId === route.channelUserId)
      );
      if (other.routes.length !== before) {
        other.updatedAt = Date.now();
        this.persist(other);
      }
    }
    chat.routes ??= [];
    const exists = chat.routes.some(r =>
      r.channel === route.channel &&
      r.channelUserId === route.channelUserId
    );
    if (!exists) {
      chat.routes.push(route);
      chat.updatedAt = Date.now();
      this.persist(chat);
    }
    return chat;
  }

  removeRoute(chatId: string, channel: ChannelKind, channelUserId: string): Chat {
    const chat = this.requireChat(chatId);
    if (!chat.routes) return chat;
    const before = chat.routes.length;
    chat.routes = chat.routes.filter(r =>
      !(r.channel === channel && r.channelUserId === channelUserId)
    );
    if (chat.routes.length !== before) {
      chat.updatedAt = Date.now();
      this.persist(chat);
    }
    return chat;
  }

  clearRoutesForChannel(channel: ChannelKind): number {
    this.ensureLoaded();
    let removed = 0;
    for (const chat of this.cache.values()) {
      if (!chat.routes?.length) continue;
      const before = chat.routes.length;
      chat.routes = chat.routes.filter(r => r.channel !== channel);
      if (chat.routes.length !== before) {
        removed += before - chat.routes.length;
        chat.updatedAt = Date.now();
        this.persist(chat);
      }
    }
    return removed;
  }

  findByRoute(channel: ChannelKind, channelUserId: string): Chat | undefined {
    this.ensureLoaded();
    for (const chat of this.cache.values()) {
      if (!chat.routes?.length) continue;
      for (const r of chat.routes) {
        if (r.channel === channel && r.channelUserId === channelUserId) return chat;
      }
    }
    return undefined;
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
