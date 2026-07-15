import { Chat, ChatMessage, CodingAgent, FileAttachment, ToolCallEntry } from '@codey/core';

export const MAX_CONCURRENT_AGENTS = 4;
export const CHAT_CONTEXT_WINDOW = 40;

/**
 * Appended to the prompt only when a chat has soloAdvisor enabled. Tells the
 * single agent to self-escalate when stuck via the [ASK_ADVISOR] marker.
 */
export const SOLO_ADVISOR_INSTRUCTION =
  'If you cannot make progress, or you notice you are repeating the same failed ' +
  'approach across turns, end your reply with a single line ' +
  '`[ASK_ADVISOR]: <brief description of where you are stuck>` (a stronger advisor ' +
  'model will give you guidance, then you continue). Do not use this line unless you ' +
  'are genuinely blocked.';

export type ChatStreamEvent =
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'tool_start'; chatId: string; tool?: string; message: string; input?: Record<string, unknown>; messageId?: string; step?: number }
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string; messageId?: string; step?: number }
  | { type: 'info'; chatId: string; message: string; skillNotice?: boolean }
  | { type: 'stream'; chatId: string; token: string; messageId?: string; step?: number }
  | { type: 'thinking'; chatId: string; token: string; step?: number; messageId?: string }
  | { type: 'team_start'; chatId: string; teamTurnId: string; teamName: string; mode: 'sequential' | 'graph' | 'auto' | 'parallel'; workers?: Array<{ messageId: string; step: number; worker: string; agent?: CodingAgent; model?: string }> }
  | { type: 'worker_start'; chatId: string; teamTurnId: string; messageId: string; step: number; worker: string; agent?: CodingAgent; model?: string; reason?: string }
  | { type: 'worker_end'; chatId: string; messageId: string; step: number; status: 'done' | 'failed' | 'askedUser'; tokens?: number; durationSec?: number }
  | { type: 'done'; chatId: string; response: string; thinking?: string; tokens?: number; durationSec?: number; agent?: 'claude-code' | 'opencode' | 'codex'; model?: string; title?: string; choices?: string[]; userQuestion?: { question: string; options: Array<{ label: string; description?: string }> }; fallback?: { from: string; to: string }; teamTurnId?: string }
  | { type: 'stopped'; chatId: string; userMessageId: string; text: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'permission_denials'; chatId: string; denials: Array<{ toolName: string; toolInput?: Record<string, unknown> }> };

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

/**
 * Build the prompt string from the tail of the chat's message history + new
 * user message. Used by paths that don't support session resume (currently
 * team-mode dispatch and as the bootstrap turn of resume-capable chats).
 *
 * History is rendered as a single "Prior conversation" block — NOT as a
 * "User:/Assistant:" transcript — so the model does not treat the prompt as
 * a script to continue (which previously caused it to fabricate further
 * "User:" turns and self-answer).
 */
/**
 * Render the chat's prior history as context sections (compaction summary +
 * windowed transcript). Shared by buildChatPrompt and buildQuickQuestionPrompt
 * so both window/compact identically.
 */
function renderChatContextSections(chat: Chat, windowSize: number): string[] {
  const sections: string[] = [];

  const summarizedUpTo = chat.compaction?.summarizedUpTo ?? 0;
  if (chat.compaction?.summary) {
    sections.push(
      `[Earlier conversation summary — covers messages before this point]\n${chat.compaction.summary}`,
    );
  }

  const start = Math.max(summarizedUpTo, chat.messages.length - windowSize);
  const tail = chat.messages.slice(start);
  if (tail.length > 0) {
    const transcript = tail.map(m => {
      const tag = m.role === 'user' ? '[user]' : '[assistant]';
      return `${tag}\n${m.content}`;
    }).join('\n\n');
    sections.push(
      `[Prior conversation — context only; do not continue or fabricate further turns]\n${transcript}`,
    );
  }

  return sections;
}

export function buildChatPrompt(
  chat: Chat,
  userText: string,
  attachments?: FileAttachment[],
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  const sections: string[] = [];

  if (attachments && attachments.length > 0) {
    sections.push(formatAttachmentList(attachments));
  }

  sections.push(...renderChatContextSections(chat, windowSize));

  sections.push(`[Respond to this new user message]\n${userText}`);
  return sections.join('\n\n');
}

/**
 * Bootstrap prompt for a chat that is about to start (or restart) a CLI
 * session. Always includes prior context — used on the FIRST turn of a fresh
 * session anchor. Subsequent same-agent turns send only userText via resume.
 */
export function buildChatBootstrapPrompt(
  chat: Chat,
  userText: string,
  attachments?: FileAttachment[],
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  return buildChatPrompt(chat, userText, attachments, windowSize);
}

/** Resume-turn prompt: just the new user text, optionally prefixed by attachments. */
export function buildChatResumePrompt(
  userText: string,
  attachments?: FileAttachment[],
): string {
  const parts: string[] = [];
  if (attachments && attachments.length > 0) {
    parts.push(formatAttachmentList(attachments));
  }
  parts.push(userText);
  return parts.join('\n\n');
}

export function assistantPrefixForSelection(chat: Chat): string {
  switch (chat.selection.type) {
    case 'worker': return `[worker:${chat.selection.name}]\n`;
    case 'team': return `[team:${chat.selection.name ?? '(unset)'}]\n`;
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

/** Tools Quick Question is allowed to use — strictly read/inspect only. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'];

export interface QQHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/** Stream events for a Quick Question run. `chatId` is the parent chat it belongs to. */
export type QQStreamEvent =
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'tool'; chatId: string; message: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number }
  | { type: 'stopped'; chatId: string }
  | { type: 'error'; chatId: string; message: string };

/**
 * Build the ephemeral prompt for a Quick Question turn: the parent chat as
 * read-only reference, then the QQ thread's own prior turns, then the new
 * question with an explicit read-only instruction.
 */
export function buildQuickQuestionPrompt(
  chat: Chat,
  qqHistory: QQHistoryEntry[],
  question: string,
  attachments?: FileAttachment[],
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  const sections: string[] = [];

  if (attachments && attachments.length > 0) {
    sections.push(formatAttachmentList(attachments));
  }

  const ctx = renderChatContextSections(chat, windowSize);
  if (ctx.length > 0) {
    sections.push(
      '[Main chat — read-only reference. Do not continue or modify this conversation.]',
      ...ctx,
    );
  }

  if (qqHistory.length > 0) {
    const transcript = qqHistory.map(m => {
      const tag = m.role === 'user' ? '[user]' : '[assistant]';
      return `${tag}\n${m.content}`;
    }).join('\n\n');
    sections.push(`[Quick Question thread so far]\n${transcript}`);
  }

  sections.push(
    '[New quick question — answer using the reference above. You are READ-ONLY: ' +
    'you may read files and search, but must NOT create, edit, delete, or run ' +
    'commands that modify anything.]\n' + question,
  );

  return sections.join('\n\n');
}
