// Per-chat composer drafts. ChatTab is remounted on every chat switch (App.tsx
// keys it by chat id), which would otherwise reset its local input/attachment
// state and lose anything the user typed but hasn't sent. We stash drafts in a
// module-level store keyed by chat id so they survive that remount: ChatTab
// seeds its state from getDraft() on mount and writes back with setDraft() on
// change. Attachments are lightweight metadata (path on disk), so this is cheap.
import type { FileAttachment } from '../types'

export interface ChatDraft {
  text: string
  attachments: FileAttachment[]
}

const drafts = new Map<string, ChatDraft>()

const EMPTY: ChatDraft = { text: '', attachments: [] }

export function getDraft(chatId: string): ChatDraft {
  return drafts.get(chatId) ?? { ...EMPTY }
}

export function setDraft(chatId: string, draft: ChatDraft): void {
  if (!draft.text && draft.attachments.length === 0) {
    drafts.delete(chatId)
    return
  }
  drafts.set(chatId, draft)
}

export function clearDraft(chatId: string): void {
  drafts.delete(chatId)
}

// Test-only: reset the store between cases.
export function __resetDrafts(): void {
  drafts.clear()
}
