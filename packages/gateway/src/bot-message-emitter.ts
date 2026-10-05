import { randomUUID } from 'crypto';
import type { BlackboardSnapshot, ChatMessage, ToolCallEntry, WriteDiff } from '@codey/core';
import type { ChatStreamEvent } from './chat-runner';

type Sink = (e: ChatStreamEvent) => void;

/** Minimal store surface the emitter needs (satisfied by ChatManager). */
export interface BotMessageStore {
  appendMessage(chatId: string, m: ChatMessage): unknown;
  updateMessage(chatId: string, id: string, patch: Partial<ChatMessage>): unknown;
}

interface Buf { messageId: string; step: number; bot: string; content: string; toolCalls: ToolCallEntry[]; thinking: string; }

export interface BeginBotArgs { step: number; bot: string; reason?: string; agent?: ChatMessage['agent']; model?: string; }
export interface EndBotMeta {
  tokens?: number;
  durationSec?: number;
  failureReason?: string;
  nextUserAction?: { text: string; options?: string[] };
}

/**
 * Owns the per-bot chat-message lifecycle for a single team run. All
 * bot-scoped events (stream/thinking/tool) flow through here so they carry a
 * stable, backend-authoritative `messageId`. Serial modes use `beginBot`
 * (active message); parallel uses `teamStart` (pre-created, routed by bot
 * name).
 */
export class BotMessageEmitter {
  private active: Buf | null = null;
  private byBot = new Map<string, Buf>();

  constructor(
    private sink: Sink,
    private store: BotMessageStore,
    private chatId: string,
    private meta: { teamTurnId: string; teamName: string; mode: ChatMessage['teamMode']; taskId?: string },
    private newId: () => string = randomUUID,
  ) {}

  /** Pre-create the full roster so the UI can show every member immediately. */
  teamStart(bots: Array<{ step: number; bot: string; agent?: ChatMessage['agent']; model?: string }>): void {
    const list = bots.map(w => {
      const initialStatus = this.meta.mode === 'roundtable' ? 'running' : 'pending';
      const buf = this.createStub(w.step, w.bot, undefined, w.agent, w.model, initialStatus);
      this.byBot.set(w.bot, buf);
      return { messageId: buf.messageId, step: w.step, bot: w.bot, agent: w.agent, model: w.model };
    });
    this.sink({ type: 'team_start', taskId: this.meta.taskId, chatId: this.chatId, teamTurnId: this.meta.teamTurnId, teamName: this.meta.teamName, mode: this.meta.mode!, bots: list });
  }

  /** Start a bot (serial). Flushes any still-active bot as done first. */
  beginBot(args: BeginBotArgs): string {
    if (this.active) this.endBot('done');
    // Serial teams already have pending roster stubs. Reuse the member's first
    // stub when their turn arrives so the card gains live content in place.
    const waiting = this.byBot.get(args.bot);
    const buf = waiting ?? this.createStub(args.step, args.bot, args.reason, args.agent, args.model, 'running');
    if (waiting) {
      this.byBot.delete(args.bot);
      buf.step = args.step;
      this.store.updateMessage(this.chatId, buf.messageId, {
        step: args.step, botStatus: 'running', isComplete: false,
        ...(args.reason ? { advisorReason: args.reason } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.model ? { model: args.model } : {}),
      });
    }
    this.active = buf;
    this.sink({ type: 'bot_start', taskId: this.meta.taskId, chatId: this.chatId, teamTurnId: this.meta.teamTurnId, messageId: buf.messageId, step: args.step, bot: args.bot, reason: args.reason, agent: args.agent, model: args.model });
    return buf.messageId;
  }

  onStream(token: string, bot?: string): void {
    const buf = this.target(bot);
    if (!buf) return;
    buf.content += token;
    this.sink({ type: 'stream', chatId: this.chatId, token, messageId: buf.messageId, step: buf.step });
  }

  onThinking(token: string, step: number, bot?: string): void {
    const buf = this.target(bot);
    if (!buf) return;
    buf.thinking += token;
    this.sink({ type: 'thinking', chatId: this.chatId, token, step, messageId: buf.messageId });
  }

  onTool(entry: { type: 'tool_start' | 'tool_end'; tool?: string; message?: string; input?: Record<string, unknown>; output?: string; writes?: string[]; writeDiffs?: WriteDiff[] }, bot?: string): void {
    const buf = this.target(bot);
    if (!buf) return;
    const tc: ToolCallEntry = {
      id: this.newId(), type: entry.type, tool: entry.tool, message: entry.message ?? '', input: entry.input, output: entry.output,
      ...(entry.writes?.length ? { writes: entry.writes } : {}),
      ...(entry.writeDiffs?.length ? { writeDiffs: entry.writeDiffs } : {}),
    };
    buf.toolCalls.push(tc);
    if (entry.type === 'tool_start') this.sink({ type: 'tool_start', chatId: this.chatId, tool: entry.tool, message: entry.message ?? '', input: entry.input, messageId: buf.messageId, step: buf.step });
    else this.sink({
      type: 'tool_end', chatId: this.chatId, tool: entry.tool, message: entry.message ?? '', output: entry.output, messageId: buf.messageId, step: buf.step,
      ...(entry.writes?.length ? { writes: entry.writes } : {}),
      ...(entry.writeDiffs?.length ? { writeDiffs: entry.writeDiffs } : {}),
    });
  }

  /** Persist and publish the authoritative board after a bot contributes. */
  updateBlackboard(blackboard: BlackboardSnapshot, bot?: string): void {
    const buf = this.target(bot);
    if (!buf) return;
    this.store.updateMessage(this.chatId, buf.messageId, { teamBlackboard: blackboard });
    this.sink({
      type: 'blackboard_update',
      chatId: this.chatId,
      teamTurnId: this.meta.teamTurnId,
      messageId: buf.messageId,
      blackboard,
    });
  }

  /** Finalize a bot. For parallel pass `bot`; for serial it finalizes the active one. */
  endBot(status: 'done' | 'failed' | 'askedUser', extra?: EndBotMeta, bot?: string): void {
    const buf = bot ? this.byBot.get(bot) : this.active;
    if (!buf) return;
    this.store.updateMessage(this.chatId, buf.messageId, {
      content: buf.content,
      toolCalls: buf.toolCalls,
      thinking: buf.thinking || undefined,
      botStatus: status,
      isComplete: true,
      ...(extra?.tokens != null ? { tokens: extra.tokens } : {}),
      ...(extra?.durationSec != null ? { durationSec: extra.durationSec } : {}),
      ...(extra?.failureReason ? { botFailureReason: extra.failureReason } : {}),
      ...(extra?.nextUserAction ? { botNextUserAction: extra.nextUserAction } : {}),
    });
    this.sink({ type: 'bot_end', chatId: this.chatId, messageId: buf.messageId, step: buf.step, status, tokens: extra?.tokens, durationSec: extra?.durationSec, failureReason: extra?.failureReason, nextUserAction: extra?.nextUserAction });
    if (buf === this.active) this.active = null;
    if (bot) this.byBot.delete(bot);
  }

  setWaiting(bot: string, waiting: boolean): void {
    const buf = this.target(bot);
    if (!buf) return;
    const status = waiting ? 'askedUser' : 'running';
    this.store.updateMessage(this.chatId, buf.messageId, {
      content: buf.content, toolCalls: buf.toolCalls, thinking: buf.thinking,
      botStatus: status, isComplete: false,
    });
    this.sink({ type: 'bot_end', chatId: this.chatId, messageId: buf.messageId, step: buf.step, status });
  }

  /** The message id of the currently-active serial bot (for resume mapping). */
  get activeMessageId(): string | null { return this.active?.messageId ?? null; }

  private target(bot?: string): Buf | null {
    return bot ? (this.byBot.get(bot) ?? null) : this.active;
  }

  private createStub(step: number, bot: string, reason?: string, agent?: ChatMessage['agent'], model?: string, status: NonNullable<ChatMessage['botStatus']> = 'running'): Buf {
    const messageId = this.newId();
    const buf: Buf = { messageId, step, bot, content: '', toolCalls: [], thinking: '' };
    const stub: ChatMessage = {
      id: messageId, taskId: this.meta.taskId, role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [], isComplete: false,
      teamTurnId: this.meta.teamTurnId, teamName: this.meta.teamName, teamMode: this.meta.mode,
      step, bot, botStatus: status,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(reason ? { advisorReason: reason } : {}),
    };
    this.store.appendMessage(this.chatId, stub);
    return buf;
  }
}
