import { useEffect, useReducer } from 'react'
import { updaterReducer, initialUpdaterState, type UpdaterEvent } from './updaterState'

export function useUpdater() {
  const [state, dispatch] = useReducer(updaterReducer, initialUpdaterState)

  useEffect(() => {
    // Subscribe first, then backfill the last known state — the initial check
    // can resolve before this effect runs, so its event may have been missed.
    const unsubscribe = window.codey.updater.onState((event: UpdaterEvent) => dispatch(event))
    window.codey.updater.lastState().then((result) => {
      if (result.ok && result.data) dispatch(result.data)
    })
    return unsubscribe
  }, [])

  return {
    state,
    check: () => window.codey.updater.check(),
    download: () => window.codey.updater.download(),
    install: () => window.codey.updater.install(),
  }
}
