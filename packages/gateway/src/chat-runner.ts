import { Chat, ChatMessage, ChecklistItem, CodingAgent, FileAttachment, TaskBrief, TeamRunSummary, ToolCallEntry, TranscriptSlice, renderSliceSection, WriteDiff } from '@codey/core';

export const MAX_CONCURRENT_AGENTS = 4;
export const CHAT_CONTEXT_WINDOW = 40;

/**
 * Above this many windowed messages a bootstrap stops inlining prior history
 * and hands over a transcript slice instead. Below it, inlining is cheaper
 * than making the agent spend a tool call on a handful of short turns.
 */
export const BOOTSTRAP_INLINE_LIMIT = 20;

/**
 * Materialises lines `first`..`last` (1-based, inclusive) of the chat's
 * transcript sidecar as a standalone file. Injected rather than called
 * directly so the prompt builders stay free of filesystem access; the gateway
 * supplies the real writer.
 */
export type SliceWriter = (first: number, last: number) => TranscriptSlice | undefined;

export interface HistoryDeliveryOptions {
  /** Absolute path of the transcript sidecar, when one exists. */
  transcriptPath?: string;
  /** Writer used to cut the un-inlined range out into its own file. */
  writeSlice?: SliceWriter;
  inlineLimit?: number;
}

/** Recent messages kept inline even in pointer mode, so a self-contained
 *  follow-up can be answered without reading the transcript at all. */
export const BOOTSTRAP_TAIL_INLINE = 4;

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
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string; messageId?: string; step?: number; writes?: string[]; writeDiffs?: WriteDiff[] }
  | { type: 'info'; chatId: string; message: string; skillNotice?: boolean }
  // The agent's own task list, restated in full. Consumers replace whatever
  // they were showing; the list is authoritative, not incremental.
  | { type: 'checklist'; chatId: string; message: string; items: ChecklistItem[] }
  | { type: 'stream'; chatId: string; token: string; messageId?: string; step?: number }
  | { type: 'thinking'; chatId: string; token: string; step?: number; messageId?: string }
  | { type: 'team_start'; chatId: string; teamTurnId: string; teamName: string; mode: 'sequential' | 'graph' | 'auto' | 'parallel'; workers?: Array<{ messageId: string; step: number; worker: string; agent?: CodingAgent; model?: string }> }
  | { type: 'worker_start'; chatId: string; teamTurnId: string; messageId: string; step: number; worker: string; agent?: CodingAgent; model?: string; reason?: string }
  | { type: 'worker_end'; chatId: string; messageId: string; step: number; status: 'done' | 'failed' | 'askedUser'; tokens?: number; durationSec?: number }
  | { type: 'team_end'; chatId: string; teamTurnId: string; summary: TeamRunSummary; taskBrief?: TaskBrief }
  | { type: 'workspace_ready'; chatId: string }
  | { type: 'done'; chatId: string; response: string; thinking?: string; tokens?: number; durationSec?: number; agent?: 'claude-code' | 'opencode' | 'codex' | 'pi'; model?: string; title?: string; choices?: string[]; userQuestion?: { question: string; options: Array<{ label: string; description?: string }> }; fallback?: { from: string; to: string; reason?: string }; teamTurnId?: string }
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
function renderChatContextSections(
  chat: Chat,
  windowSize: number,
  opts?: HistoryDeliveryOptions,
): string[] {
  const sections: string[] = [];

  const summarizedUpTo = chat.compaction?.summarizedUpTo ?? 0;
  if (chat.compaction?.summary) {
    sections.push(
      `[Earlier conversation summary — covers messages before this point]\n${chat.compaction.summary}`,
    );
  }

  let start = Math.max(summarizedUpTo, chat.messages.length - windowSize);
  const inlineLimit = opts?.inlineLimit ?? BOOTSTRAP_INLINE_LIMIT;

  // Past the inline limit, hand over a transcript cursor instead of the
  // replay. Sidecar line N holds messages[N-1]. The pointer deliberately
  // reaches back further than `windowSize` — reading more costs the agent a
  // longer `sed` range, not a longer prompt — while a short tail stays inlined
  // so a self-contained follow-up needs no tool round-trip at all.
  if (opts?.transcriptPath && chat.messages.length - start > inlineLimit) {
    const pointerFirst = summarizedUpTo + 1;
    const pointerLast = chat.messages.length - BOOTSTRAP_TAIL_INLINE;
    if (pointerLast >= pointerFirst) {
      const slice = opts.writeSlice?.(pointerFirst, pointerLast);
      sections.push(slice
        ? renderSliceSection(slice, {
            heading: 'Earlier conversation',
            closing: 'Context only — do not repeat or fabricate turns.',
          })
        : [
            // No slice (unreadable sidecar, or no writer wired): fall back to
            // naming the range in place. Strictly worse — the agent has to
            // extract it — but better than dropping the history entirely.
            `[Earlier conversation — ${pointerLast - pointerFirst + 1} messages, not inlined]`,
            `Transcript: ${opts.transcriptPath}`,
            'One JSON object per line, one line per message, oldest first.',
            `Lines ${pointerFirst}-${pointerLast} hold this history.`,
            `Read them before answering (e.g. \`sed -n '${pointerFirst},${pointerLast}p'\`) unless the new request below is fully self-contained.`,
            'Context only — do not repeat or fabricate turns.',
          ].join('\n'),
      );
      start = pointerLast;
    }
  }

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
  opts?: HistoryDeliveryOptions,
): string {
  const sections: string[] = [];

  if (attachments && attachments.length > 0) {
    sections.push(formatAttachmentList(attachments));
  }

  sections.push(...renderChatContextSections(chat, windowSize, opts));

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
  opts?: HistoryDeliveryOptions,
): string {
  return buildChatPrompt(chat, userText, attachments, windowSize, opts);
}

const RESUME_CONTEXT_MAX_CHARS = 8_000;
const RESUME_CONTEXT_HEAD_CHARS = 2_000;

/** Keep a bounded head + tail checkpoint for warm-session turns. */
export function resumeContextExcerpt(text: string): string {
  if (text.length <= RESUME_CONTEXT_MAX_CHARS) return text;
  const tailChars = RESUME_CONTEXT_MAX_CHARS - RESUME_CONTEXT_HEAD_CHARS;
  return text.slice(0, RESUME_CONTEXT_HEAD_CHARS)
    + '\n\n[… middle of prior assistant message omitted …]\n\n'
    + text.slice(-tailChars);
}

/**
 * Resume-turn prompt. Always pin the most recent persisted assistant message
 * so Codey's durable transcript remains the semantic checkpoint even when the
 * CLI inserts permission/interruption events or automatically replays a prompt.
 * The checkpoint is bounded to avoid repeatedly injecting an unbounded reply.
 */
export function buildChatResumePrompt(
  chat: Chat,
  userText: string,
  attachments?: FileAttachment[],
): string {
  const parts: string[] = [];
  if (attachments && attachments.length > 0) {
    parts.push(formatAttachmentList(attachments));
  }
  const latestAssistant = [...chat.messages].reverse()
    .find(message => message.role === 'assistant' && message.content.trim());
  if (latestAssistant) {
    parts.push(
      '[Most recent persisted assistant message — conversation checkpoint. ' +
      'CLI-internal permission or interruption events may have occurred afterward; use this ' +
      'checkpoint together with the new user message below.]\n' + resumeContextExcerpt(latestAssistant.content),
      `[Respond to this new user message]\n${userText}`,
    );
    return parts.join('\n\n');
  }
  parts.push(userText);
  return parts.join('\n\n');
}

/**
 * Resume a previously used agent after another agent handled some turns.
 * Only messages newer than this session's sync cursor are replayed, so an
 * agent receives the gap exactly once instead of being polluted by the full
 * transcript every time the user switches back.
 */
/**
 * Above this many missed messages a catch-up stops inlining the replay and
 * points at the transcript sidecar instead. Inlining is cheaper for a short
 * gap (no extra tool round-trip); past the threshold the replay is what
 * actually blows up the argv the CLI is spawned with.
 */
export const CATCHUP_INLINE_LIMIT = 20;

export function buildChatCatchupPrompt(
  chat: Chat,
  syncedThroughMessageId: string,
  userText: string,
  attachments?: FileAttachment[],
  opts?: HistoryDeliveryOptions,
): string {
  const cursor = chat.messages.findIndex(message => message.id === syncedThroughMessageId);
  if (cursor < 0 || cursor === chat.messages.length - 1) {
    return buildChatResumePrompt(chat, userText, attachments);
  }

  const parts: string[] = [];
  if (attachments && attachments.length > 0) parts.push(formatAttachmentList(attachments));

  const missed = chat.messages.slice(cursor + 1);
  const inlineLimit = opts?.inlineLimit ?? CATCHUP_INLINE_LIMIT;

  if (opts?.transcriptPath && missed.length > inlineLimit) {
    // Sidecar line N holds messages[N-1], so the first unseen message sits on
    // line cursor + 2. Codey owns this cursor — the agent is a fresh process
    // every turn and cannot be asked to remember where it left off.
    const firstUnseenLine = cursor + 2;
    const lastLine = chat.messages.length;
    const slice = opts.writeSlice?.(firstUnseenLine, lastLine);
    parts.push(slice
      ? renderSliceSection(slice, {
          heading: 'Codey conversation updates since this agent was last active',
          closing: 'Context only — do not repeat or fabricate turns.',
        })
      : [
          `[Codey conversation updates since this agent was last active — ${missed.length} messages, not inlined]`,
          `Transcript: ${opts.transcriptPath}`,
          'One JSON object per line, one line per message, oldest first.',
          `You last saw line ${cursor + 1}. Lines ${firstUnseenLine}-${lastLine} are new.`,
          `Read them if you need the detail (e.g. \`sed -n '${firstUnseenLine},${lastLine}p'\`); skip it if the new request stands on its own.`,
          'Context only — do not repeat or fabricate turns.',
        ].join('\n'),
    );
  } else {
    const updates = missed.map(message => {
      if (message.role === 'user') return `[user]\n${message.content}`;
      const identity = [message.agent, message.model].filter(Boolean).join(' / ');
      return `[assistant${identity ? ` via ${identity}` : ''}]\n${message.content}`;
    }).join('\n\n');
    parts.push(
      `[Codey conversation updates since this agent was last active — context only; do not repeat or fabricate turns]\n${updates}`,
    );
  }

  parts.push(`[Respond to this new user message]\n${userText}`);
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
  | { type: 'tool'; chatId: string; message: string; tool?: string }
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
  opts?: HistoryDeliveryOptions,
): string {
  const sections: string[] = [];

  if (attachments && attachments.length > 0) {
    sections.push(formatAttachmentList(attachments));
  }

  const ctx = renderChatContextSections(chat, windowSize, opts);
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
