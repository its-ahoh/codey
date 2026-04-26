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
