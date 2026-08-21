import { describe, expect, it } from 'vitest'
import { clampFloatingLeft } from './floatingLayer'

describe('clampFloatingLeft', () => {
  it('right-aligns a layer to its anchor when there is room', () => {
    expect(clampFloatingLeft(500, 240, 800)).toBe(260)
  })

  it('keeps a layer clear of a native browser boundary', () => {
    expect(clampFloatingLeft(390, 280, 300)).toBe(12)
  })

  it('keeps a layer away from the left viewport edge', () => {
    expect(clampFloatingLeft(100, 240, 800)).toBe(12)
  })
})
