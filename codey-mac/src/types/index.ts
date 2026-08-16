export type { ChatMessage, ToolCallEntry, Chat, ChatSelection, ChecklistItem, FileAttachment, ChatRoute, TaskBrief, TaskEvent, TeamRunSummary, TeamRunSummaryEntry } from '@codey/core';

export interface GatewayStatus {
  status: string;
  uptime: number;
  messagesProcessed: number;
  errors: number;
  channels: {
    telegram: boolean;
    discord: boolean;
    imessage: boolean;
  };
}


