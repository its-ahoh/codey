import { BlackboardSnapshot, ChannelType, CodingAgent } from '@codey/core';
import type { EndWorkerMeta, WorkerMessageEmitter } from './worker-message-emitter';

/** Surface-agnostic sink for team continuation output. */
export interface TeamEmitter {
  /** A discrete status / result / ASK_USER message to the user. */
  notify(text: string, choices?: string[]): Promise<void>;
  /** An ephemeral progress line ("step 2: architect is working"). Never a
   * message: chat shows it as a transient info event, channels have no
   * transient surface and drop it. A team run's messages are the worker
   * bubbles (where the surface has them), any question, and the Aide final. */
  status(text: string): Promise<void>;
  termination?(reason: string): void;
  /** Per-worker streamed output token. */
  onStream(token: string): void;
  /** Per-worker streamed thinking token. */
  onThinking(token: string, step: number): void;
  /** Begin a per-worker chat message (chat surface only). */
  beginWorker?(args: { step: number; worker: string; reason?: string; agent?: CodingAgent; model?: string }): void;
  /** Finalize the active per-worker chat message (chat surface only). */
  endWorker?(status: 'done' | 'failed' | 'askedUser', meta?: EndWorkerMeta): void;
  /** Publish the latest shared blackboard (chat surface only). */
  updateBlackboard?(blackboard: BlackboardSnapshot): void;
  /** Accumulated assistant transcript (chat surface); '' for channels. */
  readonly transcript: string;
  /** Latest choices passed to notify (for the chat return contract). */
  readonly choices: string[] | undefined;
  /** True when each worker's own output already has its own chat bubble. Such
   * surfaces must not repeat that output inside a group-level notice (an
   * ASK_USER preamble, the whiteboard block) — it would read twice. */
  readonly rendersWorkerBubbles: boolean;
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
  termination(reason: string): void { this.sink({ type: 'team_termination', chatId: this.chatId, reason }); }
  async status(text: string): Promise<void> {
    try { this.sink({ type: 'info', chatId: this.chatId, message: text }); } catch { /* swallow */ }
  }
  onStream(token: string): void {
    // With per-worker bubbles the token already has a home: the member's own
    // message. Keeping a second copy in the transcript is what made a paused
    // run render its answer twice (transcript -> group footer bubble).
    if (this.workerMsgs) { this.workerMsgs.onStream(token); return; }
    this.parts.push(token);
    try { this.sink({ type: 'stream', chatId: this.chatId, token }); } catch { /* swallow */ }
  }
  onThinking(token: string, step: number): void {
    if (this.workerMsgs) { this.workerMsgs.onThinking(token, step); return; }
    try { this.sink({ type: 'thinking', chatId: this.chatId, token, step }); } catch { /* swallow */ }
  }
  beginWorker(args: { step: number; worker: string; reason?: string; agent?: CodingAgent; model?: string }): void { this.workerMsgs?.beginWorker(args); }
  endWorker(status: 'done' | 'failed' | 'askedUser', meta?: EndWorkerMeta): void { this.workerMsgs?.endWorker(status, meta); }
  updateBlackboard(blackboard: BlackboardSnapshot): void { this.workerMsgs?.updateBlackboard(blackboard); }
  get transcript(): string { return this.parts.join('\n\n'); }
  get choices(): string[] | undefined { return this._choices; }
  get rendersWorkerBubbles(): boolean { return !!this.workerMsgs; }
}

/** Emits to a channel via the gateway's sendResponse + handler.streamText. */
export class ChannelEmitter implements TeamEmitter {
  termination(_reason: string): void { /* Channel status is emitted separately. */ }
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
  async status(_text: string): Promise<void> { /* no transient surface on a channel */ }
  onStream(token: string): void { this.streamText?.(token); }
  onThinking(_token: string, _step: number): void { /* channels don't render thinking today */ }
  get transcript(): string { return ''; }
  get choices(): string[] | undefined { return this._choices; }
  readonly rendersWorkerBubbles = false;
}
