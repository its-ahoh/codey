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

// Drafts written from outside the composer (e.g. the browser panel's "Use in
// chat") have to reach an already-mounted ChatTab, which only seeds itself from
// the store on mount. Subscribers get notified for those writes only —
// ChatTab's own keystroke sync goes through setDraft and stays silent, so there
// is no write-back loop.
type DraftListener = (chatId: string, draft: ChatDraft) => void

const listeners = new Set<DraftListener>()

export function subscribeDrafts(listener: DraftListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Append text to a chat's draft (blank-line separated) and notify the composer. */
export function appendDraftText(chatId: string, text: string): void {
  const current = getDraft(chatId)
  const next: ChatDraft = {
    ...current,
    text: current.text ? `${current.text}\n\n${text}` : text,
  }
  setDraft(chatId, next)
  for (const listener of listeners) listener(chatId, next)
}

// Test-only: reset the store between cases.
export function __resetDrafts(): void {
  drafts.clear()
  listeners.clear()
}
