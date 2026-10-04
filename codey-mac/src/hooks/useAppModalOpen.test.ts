import { describe, it, expect } from 'vitest'
import { APP_MODAL_SELECTOR, hasAppModalOpen } from './useAppModalOpen'

const doc = (nodes: unknown[]) => ({
  querySelectorAll: (selector: string) => (selector === APP_MODAL_SELECTOR ? nodes : []),
})

describe('hasAppModalOpen', () => {
  const inside = { name: 'browser prompt' }
  const outside = { name: 'Create a group' }
  const browserRoot = { contains: (node: unknown) => node === inside }

  it('is false when no modal is open', () => {
    expect(hasAppModalOpen(doc([]), browserRoot)).toBe(false)
  })

  it('is true when a modal outside the browser panel is open', () => {
    expect(hasAppModalOpen(doc([outside]), browserRoot)).toBe(true)
  })

  it('ignores modals rendered inside the browser panel itself', () => {
    expect(hasAppModalOpen(doc([inside]), browserRoot)).toBe(false)
  })

  it('treats every modal as outside before the panel has mounted', () => {
    expect(hasAppModalOpen(doc([inside]), null)).toBe(true)
  })
})
