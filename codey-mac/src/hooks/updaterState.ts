export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string }

export const initialUpdaterState: UpdaterState = { phase: 'idle' }

export function updaterReducer(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case 'checking':
      // Don't disturb an in-progress download/ready state on a periodic re-check.
      return state.phase === 'downloading' || state.phase === 'ready' ? state : { phase: 'idle' }
    case 'available':
      return { phase: 'available', version: event.version }
    case 'not-available':
      return { phase: 'idle' }
    case 'progress':
      return { phase: 'downloading', percent: event.percent }
    case 'downloaded':
      return { phase: 'ready', version: event.version }
    case 'error':
      return { phase: 'idle' }
  }
}
