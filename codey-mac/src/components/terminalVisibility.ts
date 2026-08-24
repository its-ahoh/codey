// Per-chat bottom-Terminal visibility. ChatTab is remounted on every chat
// switch (App.tsx keys it by chat id), so its local `bottomTerminalOpen` state
// reset to false and the Terminal vanished when the user came back — even
// though the shell sessions themselves live on in the main process. We keep the
// open/closed flag in a module-level store keyed by chat id so it survives that
// remount, mirroring chatDrafts.ts.
const openChats = new Set<string>()

export function isBottomTerminalOpen(chatId: string): boolean {
  return openChats.has(chatId)
}

export function setBottomTerminalOpen(chatId: string, open: boolean): void {
  if (open) openChats.add(chatId)
  else openChats.delete(chatId)
}

// Test-only: reset the store between cases.
export function __resetBottomTerminalVisibility(): void {
  openChats.clear()
}
