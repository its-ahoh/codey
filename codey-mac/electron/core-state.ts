// Pure state store for the in-process core's lifecycle phase. Kept free of
// Electron imports so it is unit-testable; main.ts injects the notify
// callback that forwards transitions to the renderer.
export type CorePhase = 'booting' | 'ready' | 'failed'

export interface CoreState {
  phase: CorePhase
  error?: string
}

export interface CoreStateStore {
  get(): CoreState
  setBooting(): void
  setReady(): void
  setFailed(error: string): void
}

export function createCoreStateStore(notify: (state: CoreState) => void): CoreStateStore {
  let state: CoreState = { phase: 'booting' }
  const set = (next: CoreState) => {
    state = next
    try { notify(state) } catch { /* renderer gone */ }
  }
  return {
    get: () => state,
    setBooting: () => set({ phase: 'booting' }),
    setReady: () => set({ phase: 'ready' }),
    setFailed: (error: string) => set({ phase: 'failed', error }),
  }
}
