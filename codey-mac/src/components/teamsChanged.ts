// Notifies mounted views (e.g. ChatTab's team dropdown) when the set of teams
// changes. The teams editor lives in the Settings overlay, a sibling tree that
// stays mounted alongside ChatTab, so ChatTab's one-shot getTeams() effect never
// re-runs after an edit. Both live in the same renderer and ChatTab is already
// mounted when a save fires, so a synchronous window event reaches it.

const EVENT = 'codey:teams-changed'

export function emitTeamsChanged(): void {
  window.dispatchEvent(new Event(EVENT))
}

export function onTeamsChanged(handler: () => void): () => void {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
