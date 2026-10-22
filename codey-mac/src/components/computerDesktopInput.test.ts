import { describe, expect, it } from 'vitest'
import { desktopKey, windowPoint } from './computerDesktopInput'
describe('live desktop coordinates and keys', () => {
  it('maps only the video content and ignores letterboxing at different scales', () => {
    const rect = { left: 20, top: 10, width: 800, height: 600 }
    expect(windowPoint(rect, 1600, 800, 420, 310)).toEqual({ x: 0.5, y: 0.5 })
    expect(windowPoint(rect, 1600, 800, 420, 40)).toBeNull()
    expect(windowPoint(rect, 1600, 800, 820, 300)).toBeNull()
    expect(windowPoint(rect, 0, 0, 20, 10)).toBeNull()
  })
  it('separates text/IME and explicit paste from special keys and shortcuts', () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
    expect(desktopKey({ ...base, key: 'a' })).toBeNull()
    expect(desktopKey({ ...base, key: 'Process' })).toBeNull()
    expect(desktopKey({ ...base, key: 'Enter' })).toEqual({ tool: 'press_key', key: 'Return' })
    expect(desktopKey({ ...base, key: 's', metaKey: true })).toEqual({ tool: 'hotkey', keys: ['cmd', 's'] })
    expect(desktopKey({ ...base, key: 'v', metaKey: true })).toBeNull()
    expect(desktopKey({ ...base, key: 'ArrowLeft', shiftKey: true })).toEqual({ tool: 'hotkey', keys: ['shift', 'Left'] })
  })
})
