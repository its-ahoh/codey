import { useEffect, useReducer } from 'react'
import { updaterReducer, initialUpdaterState, type UpdaterEvent } from './updaterState'

export function useUpdater() {
  const [state, dispatch] = useReducer(updaterReducer, initialUpdaterState)

  useEffect(() => {
    const unsubscribe = window.codey.updater.onState((event: UpdaterEvent) => dispatch(event))
    return unsubscribe
  }, [])

  return {
    state,
    download: () => window.codey.updater.download(),
    install: () => window.codey.updater.install(),
  }
}
