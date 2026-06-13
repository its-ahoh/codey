import { describe, it, expect, vi } from 'vitest'
import { createCoreStateStore } from './core-state'

describe('createCoreStateStore', () => {
  it('starts in booting phase without notifying', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    expect(store.get()).toEqual({ phase: 'booting' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('booting → ready notifies with the new state', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    store.setReady()
    expect(store.get()).toEqual({ phase: 'ready' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ phase: 'ready' })
  })

  it('booting → failed carries the error message', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    store.setFailed('ENOENT: gateway.json missing')
    expect(store.get()).toEqual({ phase: 'failed', error: 'ENOENT: gateway.json missing' })
    expect(notify).toHaveBeenCalledWith({ phase: 'failed', error: 'ENOENT: gateway.json missing' })
  })

  it('setBooting resets state (relaunch path) and notifies', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    store.setFailed('boom')
    store.setBooting()
    expect(store.get()).toEqual({ phase: 'booting' })
    expect(notify).toHaveBeenLastCalledWith({ phase: 'booting' })
  })

  it('a thrown notify callback does not corrupt state', () => {
    const store = createCoreStateStore(() => { throw new Error('renderer gone') })
    expect(() => store.setReady()).not.toThrow()
    expect(store.get()).toEqual({ phase: 'ready' })
  })
})
