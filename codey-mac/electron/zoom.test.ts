import { describe, it, expect } from 'vitest'
import { ZOOM_STEPS, DEFAULT_ZOOM, clampZoom, zoomIn, zoomOut, formatZoom } from './zoom'

describe('zoom steps', () => {
  it('is ascending and contains 100%', () => {
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS)
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM)
  })
})

describe('clampZoom', () => {
  it('keeps listed steps as-is', () => {
    for (const step of ZOOM_STEPS) expect(clampZoom(step)).toBe(step)
  })

  it('falls back to 100% for junk', () => {
    for (const bad of [undefined, null, 'big', NaN, Infinity, 0, -1]) {
      expect(clampZoom(bad)).toBe(DEFAULT_ZOOM)
    }
  })

  it('accepts numeric strings', () => {
    expect(clampZoom('1.25')).toBe(1.25)
  })

  it('clamps out-of-range values into the supported band', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_STEPS[0])
    expect(clampZoom(12)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1])
  })

  it('snaps a hand-edited value to the nearest step', () => {
    expect(clampZoom(1.12)).toBe(1.1)
    expect(clampZoom(1.2)).toBe(1.25)
  })
})

describe('zoomIn / zoomOut', () => {
  it('walks one step at a time', () => {
    expect(zoomIn(1)).toBe(1.1)
    expect(zoomOut(1)).toBe(0.9)
    expect(zoomIn(zoomOut(1))).toBe(1)
  })

  it('saturates at both ends instead of wrapping', () => {
    const min = ZOOM_STEPS[0]
    const max = ZOOM_STEPS[ZOOM_STEPS.length - 1]
    expect(zoomOut(min)).toBe(min)
    expect(zoomIn(max)).toBe(max)
  })

  it('recovers from an unlisted stored value', () => {
    expect(zoomIn(1.12)).toBe(1.25)
  })
})

describe('formatZoom', () => {
  it('renders whole percentages', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(1.25)).toBe('125%')
    expect(formatZoom(undefined)).toBe('100%')
  })
})
