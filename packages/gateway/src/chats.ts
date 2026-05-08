import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Chat, ChatMessage, ChatSelection, ChatRoute, ChannelKind } from '@codey/core';
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

  /**
   * Set or clear the per-chat agent/model override. Pass `undefined` (or null
   * via JSON) to clear a field and fall back to the gateway default.
   */
  updateAgentModel(chatId: string, agent?: Chat['agent'] | null, model?: string | null): Chat {
    const chat = this.requireChat(chatId);
    if (agent === null || agent === undefined) delete chat.agent;
    else chat.agent = agent;
    if (model === null || model === undefined || model === '') delete chat.model;
    else chat.model = model;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
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

  addRoute(chatId: string, route: ChatRoute): Chat {
    const chat = this.requireChat(chatId);
    chat.routes ??= [];
    const exists = chat.routes.some(r =>
      r.channel === route.channel &&
      r.channelUserId === route.channelUserId &&
      r.channelChatId === route.channelChatId
    );
    if (!exists) {
      chat.routes.push(route);
      chat.updatedAt = Date.now();
      this.persist(chat);
    }
    return chat;
  }

  removeRoute(chatId: string, channel: ChannelKind, channelUserId: string, channelChatId: string): Chat {
    const chat = this.requireChat(chatId);
    if (!chat.routes) return chat;
    const before = chat.routes.length;
    chat.routes = chat.routes.filter(r =>
      !(r.channel === channel && r.channelUserId === channelUserId && r.channelChatId === channelChatId)
    );
    if (chat.routes.length !== before) {
      chat.updatedAt = Date.now();
      this.persist(chat);
    }
    return chat;
  }

  findByRoute(channel: ChannelKind, channelUserId: string, channelChatId: string): Chat | undefined {
    this.ensureLoaded();
    for (const chat of this.cache.values()) {
      if (chat.routes?.some(r =>
        r.channel === channel &&
        r.channelUserId === channelUserId &&
        r.channelChatId === channelChatId
      )) {
        return chat;
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
