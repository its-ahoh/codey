import { describe, it, expect, beforeEach, vi } from 'vitest'

// The renderer globals this module reads — the suite runs in the node env.
const store = new Map<string, string>()
const events: string[] = []
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}
;(globalThis as any).window = {
  dispatchEvent: (e: any) => { events.push(e.type); return true },
  addEventListener: () => {},
  removeEventListener: () => {},
}
;(globalThis as any).CustomEvent = class { type: string; constructor(type: string) { this.type = type } }

import { getStatusPanelEnabled, setStatusPanelEnabled, STATUS_PANEL_ENABLED_KEY } from './statusPanelPref'

describe('statusPanelPref', () => {
  beforeEach(() => { store.clear(); events.length = 0 })

  it('defaults to enabled when nothing is stored', () => {
    expect(getStatusPanelEnabled()).toBe(true)
  })

  it('round-trips the off state', () => {
    setStatusPanelEnabled(false)
    expect(store.get(STATUS_PANEL_ENABLED_KEY)).toBe('0')
    expect(getStatusPanelEnabled()).toBe(false)
    setStatusPanelEnabled(true)
    expect(getStatusPanelEnabled()).toBe(true)
  })

  it('notifies same-window listeners on change', () => {
    setStatusPanelEnabled(false)
    expect(events).toEqual(['codey:statusPanelEnabled'])
  })

  it('treats unreadable storage as enabled', () => {
    const original = (globalThis as any).localStorage.getItem
    ;(globalThis as any).localStorage.getItem = vi.fn(() => { throw new Error('denied') })
    expect(getStatusPanelEnabled()).toBe(true)
    ;(globalThis as any).localStorage.getItem = original
  })
})
