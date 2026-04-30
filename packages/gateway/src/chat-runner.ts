import { Chat, ChatMessage, FileAttachment, ToolCallEntry } from '@codey/core';

export const MAX_CONCURRENT_AGENTS = 4;
export const CHAT_CONTEXT_WINDOW = 40;

export type ChatStreamEvent =
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'tool_start'; chatId: string; tool?: string; message: string; input?: Record<string, unknown> }
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string }
  | { type: 'info'; chatId: string; message: string }
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number; title?: string }
  | { type: 'error'; chatId: string; message: string };

export type ChatStreamSink = (e: ChatStreamEvent) => void;

function formatAttachmentList(attachments: FileAttachment[]): string {
  const lines = attachments.map(a => {
    let desc = `- ${a.path} (${a.mimeType})`;
    if (a.mimeType.startsWith('image/')) {
      desc += ' [IMAGE - use vision to analyze]';
    }
    return desc;
  });
  return [
    '[Attachments]',
    ...lines,
    '',
    'Please review the attached files before responding.',
    ...(
      attachments.some(a => a.mimeType.startsWith('image/'))
        ? ['For image files, analyze the visual content carefully.']
        : []
    ),
    '',
  ].join('\n');
}

/** Build the prompt string from the tail of the chat's message history + new user message. */
export function buildChatPrompt(
  chat: Chat,
  userText: string,
  attachments?: FileAttachment[],
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  const tail = chat.messages.slice(-windowSize);
  const lines: string[] = [];

  // Prepend attachment context if present
  if (attachments && attachments.length > 0) {
    lines.push(formatAttachmentList(attachments));
  }

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
