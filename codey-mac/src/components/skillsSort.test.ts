import { describe, expect, it } from 'vitest'
import { usageMeta } from './skillsSort'

describe('usageMeta', () => {
  const now = Date.UTC(2026, 7, 19, 12)

  it('omits skills that have never been called', () => {
    expect(usageMeta({ count: 0, lastUsedAt: 0 }, now)).toBeNull()
  })

  it('formats a single call without inventing recency', () => {
    expect(usageMeta({ count: 1, lastUsedAt: 0 }, now)).toEqual({ calls: '1 call' })
  })

  it('keeps call count and recency separate for the card layout', () => {
    expect(usageMeta({ count: 12, lastUsedAt: now - 3 * 60 * 60 * 1000 }, now)).toEqual({
      calls: '12 calls',
      recency: '3h ago',
    })
  })
})
