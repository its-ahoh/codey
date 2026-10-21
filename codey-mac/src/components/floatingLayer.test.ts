import { describe, expect, it } from 'vitest'
import { clampFloatingLeft, clampFloatingPoint } from './floatingLayer'

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

describe('clampFloatingPoint', () => {
  it('keeps a top-left-anchored layer at its requested point when there is room', () => {
    expect(clampFloatingPoint(100, 200, 180, 120, 800, 600)).toEqual({ left: 100, top: 200 })
  })

  it('slides the layer back when it would spill past the right or bottom edge', () => {
    expect(clampFloatingPoint(700, 520, 180, 120, 800, 600)).toEqual({ left: 608, top: 468 })
  })

  it('keeps the layer clear of the top and left edges', () => {
    expect(clampFloatingPoint(2, 2, 180, 120, 800, 600)).toEqual({ left: 12, top: 12 })
  })

  it('degrades to the margin when the layer is larger than the available space', () => {
    expect(clampFloatingPoint(100, 100, 1000, 1000, 800, 600)).toEqual({ left: 12, top: 12 })
  })
})
