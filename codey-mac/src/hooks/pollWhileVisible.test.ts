import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollWhileVisible } from './pollWhileVisible'

/**
 * The node test environment has no `document`, so these tests install a minimal
 * stub: a `hidden` flag plus real listener bookkeeping. That is enough to drive
 * every branch, and it keeps the suite in the existing `environment: 'node'`
 * config rather than pulling in jsdom for one helper.
 */
type Listener = () => void

function installDocument(): { setHidden: (hidden: boolean) => void; listenerCount: () => number } {
  const listeners = new Map<string, Set<Listener>>()
  const doc = {
    hidden: false,
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn)
    },
  }
  ;(globalThis as { document?: unknown }).document = doc
  return {
    setHidden: (hidden: boolean) => {
      doc.hidden = hidden
      for (const fn of listeners.get('visibilitychange') ?? []) fn()
    },
    listenerCount: () => listeners.get('visibilitychange')?.size ?? 0,
  }
}

describe('pollWhileVisible', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })

  it('ticks on the interval while visible', () => {
    installDocument()
    const fn = vi.fn()
    const stop = pollWhileVisible(fn, 1000)

    vi.advanceTimersByTime(3000)

    expect(fn).toHaveBeenCalledTimes(3)
    stop()
  })

  it('does not tick while hidden', () => {
    const doc = installDocument()
    const fn = vi.fn()
    const stop = pollWhileVisible(fn, 1000)

    doc.setHidden(true)
    fn.mockClear() // ignore the visibility event itself
    vi.advanceTimersByTime(10_000)

    expect(fn).not.toHaveBeenCalled()
    stop()
  })

  it('runs immediately on becoming visible, so the view is never stale', () => {
    const doc = installDocument()
    const fn = vi.fn()
    const stop = pollWhileVisible(fn, 1000)

    doc.setHidden(true)
    vi.advanceTimersByTime(10_000)
    fn.mockClear()

    doc.setHidden(false)

    // Fires at once rather than waiting out the remaining interval.
    expect(fn).toHaveBeenCalledTimes(1)
    stop()
  })

  it('resumes ticking after becoming visible again', () => {
    const doc = installDocument()
    const fn = vi.fn()
    const stop = pollWhileVisible(fn, 1000)

    doc.setHidden(true)
    vi.advanceTimersByTime(5000)
    doc.setHidden(false)
    fn.mockClear()

    vi.advanceTimersByTime(2000)

    expect(fn).toHaveBeenCalledTimes(2)
    stop()
  })

  it('cleanup stops the timer and removes the listener', () => {
    const doc = installDocument()
    const fn = vi.fn()
    const stop = pollWhileVisible(fn, 1000)

    stop()
    vi.advanceTimersByTime(5000)
    doc.setHidden(false)

    expect(fn).not.toHaveBeenCalled()
    expect(doc.listenerCount()).toBe(0)
  })

  it('polls unconditionally when there is no document', () => {
    // Non-DOM host: behave like the plain setInterval it replaced.
    const fn = vi.fn()
    const stop = pollWhileVisible(fn, 1000)

    vi.advanceTimersByTime(2000)

    expect(fn).toHaveBeenCalledTimes(2)
    stop()
  })
})
