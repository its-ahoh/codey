// Notifies mounted views (e.g. the chat sidebar's workspace list) when the set
// of workspaces changes. The workspace editor lives in the Settings overlay, a
// sibling tree that stays mounted alongside ChatListPanel, which otherwise only
// re-fetches workspaces on a 5s poll — so a delete/create/rename appears to
// require a refresh. Both live in the same renderer, so a synchronous window
// event reaches the sidebar immediately. Mirrors teamsChanged.ts.

const EVENT = 'codey:workspaces-changed'

export function emitWorkspacesChanged(): void {
  window.dispatchEvent(new Event(EVENT))
}

export function onWorkspacesChanged(handler: () => void): () => void {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
