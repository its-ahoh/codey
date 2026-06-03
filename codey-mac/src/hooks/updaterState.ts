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
      // A periodic re-check must not disturb the current phase: the follow-up
      // available/not-available/error event sets the correct state. Clearing to
      // idle here would flicker (or permanently drop) a shown update button.
      return state
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
