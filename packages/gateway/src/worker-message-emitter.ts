import { randomUUID } from 'crypto';
import type { ChatMessage, ToolCallEntry } from '@codey/core';
import type { ChatStreamEvent } from './chat-runner';

type Sink = (e: ChatStreamEvent) => void;

/** Minimal store surface the emitter needs (satisfied by ChatManager). */
export interface WorkerMessageStore {
  appendMessage(chatId: string, m: ChatMessage): unknown;
  updateMessage(chatId: string, id: string, patch: Partial<ChatMessage>): unknown;
}

interface Buf { messageId: string; step: number; worker: string; content: string; toolCalls: ToolCallEntry[]; thinking: string; }

export interface BeginWorkerArgs { step: number; worker: string; reason?: string; agent?: ChatMessage['agent']; model?: string; }

/**
 * Owns the per-worker chat-message lifecycle for a single team run. All
 * worker-scoped events (stream/thinking/tool) flow through here so they carry a
 * stable, backend-authoritative `messageId`. Serial modes use `beginWorker`
 * (active message); parallel uses `teamStart` (pre-created, routed by worker
 * name).
 */
export class WorkerMessageEmitter {
  private active: Buf | null = null;
  private byWorker = new Map<string, Buf>();

  constructor(
    private sink: Sink,
    private store: WorkerMessageStore,
    private chatId: string,
    private meta: { teamTurnId: string; teamName: string; mode: ChatMessage['teamMode'] },
    private newId: () => string = randomUUID,
  ) {}

  /** Pre-create one stub per worker (parallel). Emits team_start. */
  teamStart(workers: Array<{ step: number; worker: string; agent?: ChatMessage['agent']; model?: string }>): void {
    const list = workers.map(w => {
      const buf = this.createStub(w.step, w.worker, undefined, w.agent, w.model);
      this.byWorker.set(w.worker, buf);
      return { messageId: buf.messageId, step: w.step, worker: w.worker, agent: w.agent, model: w.model };
    });
    this.sink({ type: 'team_start', chatId: this.chatId, teamTurnId: this.meta.teamTurnId, teamName: this.meta.teamName, mode: this.meta.mode!, workers: list });
  }

  /** Start a worker (serial). Flushes any still-active worker as done first. */
  beginWorker(args: BeginWorkerArgs): string {
    if (this.active) this.endWorker('done');
    const buf = this.createStub(args.step, args.worker, args.reason, args.agent, args.model);
    this.active = buf;
    this.sink({ type: 'worker_start', chatId: this.chatId, teamTurnId: this.meta.teamTurnId, messageId: buf.messageId, step: args.step, worker: args.worker, reason: args.reason, agent: args.agent, model: args.model });
    return buf.messageId;
  }

  onStream(token: string, worker?: string): void {
    const buf = this.target(worker);
    if (!buf) return;
    buf.content += token;
    this.sink({ type: 'stream', chatId: this.chatId, token, messageId: buf.messageId, step: buf.step });
  }

  onThinking(token: string, step: number, worker?: string): void {
    const buf = this.target(worker);
    if (!buf) return;
    buf.thinking += token;
    this.sink({ type: 'thinking', chatId: this.chatId, token, step, messageId: buf.messageId });
  }

  onTool(entry: { type: 'tool_start' | 'tool_end'; tool?: string; message?: string; input?: Record<string, unknown>; output?: string }, worker?: string): void {
    const buf = this.target(worker);
    if (!buf) return;
    const tc: ToolCallEntry = { id: this.newId(), type: entry.type, tool: entry.tool, message: entry.message ?? '', input: entry.input, output: entry.output };
    buf.toolCalls.push(tc);
    if (entry.type === 'tool_start') this.sink({ type: 'tool_start', chatId: this.chatId, tool: entry.tool, message: entry.message ?? '', input: entry.input, messageId: buf.messageId, step: buf.step });
    else this.sink({ type: 'tool_end', chatId: this.chatId, tool: entry.tool, message: entry.message ?? '', output: entry.output, messageId: buf.messageId, step: buf.step });
  }

  /** Finalize a worker. For parallel pass `worker`; for serial it finalizes the active one. */
  endWorker(status: 'done' | 'failed' | 'askedUser', extra?: { tokens?: number; durationSec?: number }, worker?: string): void {
    const buf = worker ? this.byWorker.get(worker) : this.active;
    if (!buf) return;
    this.store.updateMessage(this.chatId, buf.messageId, {
      content: buf.content,
      toolCalls: buf.toolCalls,
      thinking: buf.thinking || undefined,
      workerStatus: status,
      isComplete: true,
      ...(extra?.tokens != null ? { tokens: extra.tokens } : {}),
      ...(extra?.durationSec != null ? { durationSec: extra.durationSec } : {}),
    });
    this.sink({ type: 'worker_end', chatId: this.chatId, messageId: buf.messageId, step: buf.step, status, tokens: extra?.tokens, durationSec: extra?.durationSec });
    if (buf === this.active) this.active = null;
  }

  /** The message id of the currently-active serial worker (for resume mapping). */
  get activeMessageId(): string | null { return this.active?.messageId ?? null; }

  private target(worker?: string): Buf | null {
    return worker ? (this.byWorker.get(worker) ?? null) : this.active;
  }

  private createStub(step: number, worker: string, reason?: string, agent?: ChatMessage['agent'], model?: string): Buf {
    const messageId = this.newId();
    const buf: Buf = { messageId, step, worker, content: '', toolCalls: [], thinking: '' };
    const stub: ChatMessage = {
      id: messageId, role: 'assistant', content: '', timestamp: Date.now(),
      toolCalls: [], isComplete: false,
      teamTurnId: this.meta.teamTurnId, teamName: this.meta.teamName, teamMode: this.meta.mode,
      step, worker, workerStatus: 'running',
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(reason ? { advisorReason: reason } : {}),
    };
    this.store.appendMessage(this.chatId, stub);
    return buf;
  }
}
