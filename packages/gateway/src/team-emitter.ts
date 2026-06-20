import { ChannelType } from '@codey/core';
import type { WorkerMessageEmitter } from './worker-message-emitter';

/** Surface-agnostic sink for team continuation output. */
export interface TeamEmitter {
  /** A discrete status / result / ASK_USER message to the user. */
  notify(text: string, choices?: string[]): Promise<void>;
  /** An ephemeral status/orchestration line. NOT recorded in the chat transcript. */
  status(text: string): Promise<void>;
  /** Per-worker streamed output token. */
  onStream(token: string): void;
  /** Per-worker streamed thinking token. */
  onThinking(token: string, step: number): void;
  /** Begin a per-worker chat message (chat surface only). */
  beginWorker?(args: { step: number; worker: string; reason?: string }): void;
  /** Finalize the active per-worker chat message (chat surface only). */
  endWorker?(status: 'done' | 'failed' | 'askedUser'): void;
  /** Accumulated assistant transcript (chat surface); '' for channels. */
  readonly transcript: string;
  /** Latest choices passed to notify (for the chat return contract). */
  readonly choices: string[] | undefined;
}

type SinkLike = (ev: any) => void;

/** Emits to a chat sink and accumulates a transcript for persistence/return. */
export class ChatEmitter implements TeamEmitter {
  private parts: string[] = [];
  private _choices: string[] | undefined;
  constructor(private sink: SinkLike, private chatId: string, private workerMsgs?: WorkerMessageEmitter) {}
  async notify(text: string, choices?: string[]): Promise<void> {
    this._choices = choices;
    this.parts.push(text);
    try { this.sink({ type: 'stream', chatId: this.chatId, token: text }); } catch { /* swallow */ }
  }
  async status(text: string): Promise<void> {
    try { this.sink({ type: 'info', chatId: this.chatId, message: text }); } catch { /* swallow */ }
  }
  onStream(token: string): void {
    this.parts.push(token);
    if (this.workerMsgs) { this.workerMsgs.onStream(token); return; }
    try { this.sink({ type: 'stream', chatId: this.chatId, token }); } catch { /* swallow */ }
  }
  onThinking(token: string, step: number): void {
    if (this.workerMsgs) { this.workerMsgs.onThinking(token, step); return; }
    try { this.sink({ type: 'thinking', chatId: this.chatId, token, step }); } catch { /* swallow */ }
  }
  beginWorker(args: { step: number; worker: string; reason?: string }): void { this.workerMsgs?.beginWorker(args); }
  endWorker(status: 'done' | 'failed' | 'askedUser'): void { this.workerMsgs?.endWorker(status); }
  get transcript(): string { return this.parts.join('\n\n'); }
  get choices(): string[] | undefined { return this._choices; }
}

/** Emits to a channel via the gateway's sendResponse + handler.streamText. */
export class ChannelEmitter implements TeamEmitter {
  private _choices: string[] | undefined;
  constructor(
    private send: (r: { chatId: string; channel: ChannelType; text: string; choices?: string[] }) => Promise<void>,
    private streamText: ((text: string) => void) | undefined,
    private chatId: string,
    private channel: ChannelType,
  ) {}
  async notify(text: string, choices?: string[]): Promise<void> {
    this._choices = choices;
    await this.send({ chatId: this.chatId, channel: this.channel, text, choices });
  }
  async status(text: string): Promise<void> {
    await this.send({ chatId: this.chatId, channel: this.channel, text });
  }
  onStream(token: string): void { this.streamText?.(token); }
  onThinking(_token: string, _step: number): void { /* channels don't render thinking today */ }
  get transcript(): string { return ''; }
  get choices(): string[] | undefined { return this._choices; }
}
