// Bridges right-click "Connect to channel" → newly-selected ChatTab.
// A synchronous window event races React: the just-selected chat's tab
// has not mounted its listener yet, so the event would be dropped.
// Instead we stash the intent here and the new ChatTab drains it on mount.

type Channel = 'telegram' | 'discord' | 'imessage'

let pending: { chatId: string; channel: Channel } | null = null

export function setPendingPairing(chatId: string, channel: Channel): void {
  pending = { chatId, channel }
}

export function consumePendingPairing(chatId: string): Channel | null {
  if (!pending || pending.chatId !== chatId) return null
  const ch = pending.channel
  pending = null
  return ch
}
