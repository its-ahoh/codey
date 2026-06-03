import { describe, it, expect } from 'vitest'
import { updaterReducer, initialUpdaterState, type UpdaterState } from './updaterState'

describe('updaterReducer', () => {
  it('stays idle on checking and not-available', () => {
    expect(updaterReducer(initialUpdaterState, { type: 'checking' })).toEqual({ phase: 'idle' })
    expect(updaterReducer(initialUpdaterState, { type: 'not-available' })).toEqual({ phase: 'idle' })
  })

  it('moves to available with version', () => {
    expect(updaterReducer(initialUpdaterState, { type: 'available', version: '0.6.4' }))
      .toEqual({ phase: 'available', version: '0.6.4' })
  })

  it('tracks download progress then ready', () => {
    const downloading = updaterReducer(
      { phase: 'available', version: '0.6.4' },
      { type: 'progress', percent: 42 },
    )
    expect(downloading).toEqual({ phase: 'downloading', percent: 42 })
    expect(updaterReducer(downloading, { type: 'downloaded', version: '0.6.4' }))
      .toEqual({ phase: 'ready', version: '0.6.4' })
  })

  it('reverts to idle on error', () => {
    const state: UpdaterState = { phase: 'downloading', percent: 10 }
    expect(updaterReducer(state, { type: 'error' })).toEqual({ phase: 'idle' })
  })

  it('leaves an in-progress download untouched on a stray checking event', () => {
    const state: UpdaterState = { phase: 'downloading', percent: 50 }
    expect(updaterReducer(state, { type: 'checking' })).toEqual(state)
  })

  it('keeps a shown available button during a periodic re-check', () => {
    const state: UpdaterState = { phase: 'available', version: '0.6.4' }
    expect(updaterReducer(state, { type: 'checking' })).toEqual(state)
  })
})
