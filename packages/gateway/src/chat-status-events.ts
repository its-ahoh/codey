// packages/gateway/src/chat-status-events.ts
//
// Turns an adapter's StatusUpdate into the chat surface's stream event.
// Split out from the gateway's inline handler so the routing — in particular
// that a checklist is state rather than a tool call — is testable on its own.

import { ChecklistItem } from '@codey/core';
import { ChatStreamEvent } from './chat-runner';

interface ParsedStatus {
  type?: string;
  tool?: string;
  message?: string;
  input?: Record<string, unknown>;
  output?: string;
  checklist?: ChecklistItem[];
}

export function chatStreamEventForStatus(chatId: string, parsed: ParsedStatus): ChatStreamEvent | null {
  const message = parsed.message ?? '';
  switch (parsed.type) {
    case 'tool_start':
      return { type: 'tool_start', chatId, tool: parsed.tool, message, input: parsed.input };
    case 'tool_end':
      return { type: 'tool_end', chatId, tool: parsed.tool, message, output: parsed.output };
    case 'checklist':
      // No items means nothing to show; emitting it would blank a panel that
      // is currently displaying a perfectly good list.
      if (!parsed.checklist?.length) return null;
      return { type: 'checklist', chatId, message, items: parsed.checklist };
    default:
      return { type: 'info', chatId, message };
  }
}

/** Whether a status update belongs in the message's saved tool transcript.
 *  A checklist restates the whole list on every revision — recording each
 *  restatement would fill the transcript with rows that were never tools. */
export function isPersistableToolCall(type?: string): boolean {
  return type !== 'checklist';
}
