import * as fs from 'fs';
import * as path from 'path';
import { ChannelKind } from '@codey/core';

export interface PairingPrefs {
  workspace?: string;
  agent?: 'claude-code' | 'opencode' | 'codex';
  model?: string;
}

export interface ChannelBinding {
  channel: ChannelKind;
  channelUserId: string;
  prefs?: PairingPrefs;
  /** Per-binding "current chat" id used for the implicit-routing rule. */
  currentChatId?: string;
  createdAt: number;
}

interface PendingCode {
  code: string;
  channel: ChannelKind;
  expiresAt: number;
}

interface PersistShape {
  bindings: ChannelBinding[];
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class PairingStore {
  private bindings: ChannelBinding[] = [];
  private pending = new Map<string, PendingCode>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw) as PersistShape;
      this.bindings = data.bindings ?? [];
    } catch {
      this.bindings = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ bindings: this.bindings }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  startPairing(input: { channel: ChannelKind; ttlMs?: number }): string {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    this.pending.set(code, {
      code,
      channel: input.channel,
      expiresAt: Date.now() + ttl,
    });
    return code;
  }

  completePairing(code: string, input: { channel: ChannelKind; channelUserId: string }): boolean {
    const entry = this.pending.get(code);
    if (!entry) return false;
    this.pending.delete(code);
    if (entry.channel !== input.channel) return false;
    if (Date.now() > entry.expiresAt) return false;

    this.bindings = this.bindings.filter(b =>
      !(b.channel === input.channel && b.channelUserId === input.channelUserId)
    );
    this.bindings.push({
      channel: input.channel,
      channelUserId: input.channelUserId,
      createdAt: Date.now(),
    });
    this.persist();
    return true;
  }

  findByChannelUser(channel: ChannelKind, channelUserId: string): ChannelBinding | undefined {
    return this.bindings.find(b => b.channel === channel && b.channelUserId === channelUserId);
  }

  listForChannel(channel: ChannelKind): ChannelBinding[] {
    return this.bindings.filter(b => b.channel === channel);
  }

  list(): ChannelBinding[] {
    return [...this.bindings];
  }

  updatePrefs(channel: ChannelKind, channelUserId: string, patch: PairingPrefs): void {
    const b = this.findByChannelUser(channel, channelUserId);
    if (!b) return;
    b.prefs = { ...(b.prefs ?? {}), ...patch };
    this.persist();
  }

  setCurrentChat(channel: ChannelKind, channelUserId: string, chatId: string | undefined): void {
    const b = this.findByChannelUser(channel, channelUserId);
    if (!b) return;
    if (chatId) b.currentChatId = chatId;
    else delete b.currentChatId;
    this.persist();
  }

  remove(channel: ChannelKind, channelUserId: string): void {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter(b =>
      !(b.channel === channel && b.channelUserId === channelUserId)
    );
    if (this.bindings.length !== before) this.persist();
  }
}
