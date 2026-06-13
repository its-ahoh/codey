import { describe, it, expect } from 'vitest'
import { captureAccelerator, screenshotAccelerator, resolveCaptureSubmit, normalizeAccelerator, DEFAULT_CAPTURE_HOTKEY, DEFAULT_SCREENSHOT_HOTKEY } from './capture'

describe('captureAccelerator', () => {
  it('defaults to Alt+Space when unset', () => {
    expect(captureAccelerator(undefined)).toBe(DEFAULT_CAPTURE_HOTKEY)
    expect(DEFAULT_CAPTURE_HOTKEY).toBe('Alt+Space')
  })

  it('blank string disables', () => {
    expect(captureAccelerator('')).toBeNull()
    expect(captureAccelerator('   ')).toBeNull()
  })

  it('normalizes the WhisperTab-stored format to an Electron accelerator', () => {
    expect(captureAccelerator('Meta+Shift+K')).toBe('CommandOrControl+Shift+K')
    expect(captureAccelerator('Alt+ ')).toBe('Alt+Space')
    expect(captureAccelerator('option+space')).toBe('Alt+Space')
    expect(captureAccelerator('ctrl+j')).toBe('Control+J')
  })

  it('rejects Fn (not bindable via globalShortcut)', () => {
    expect(captureAccelerator('Fn')).toBeNull()
    expect(captureAccelerator(' fn ')).toBeNull()
  })
})

describe('screenshotAccelerator', () => {
  it('defaults to Option+Control+Space when unset', () => {
    expect(screenshotAccelerator(undefined)).toBe('Control+Alt+Space')
    expect(DEFAULT_SCREENSHOT_HOTKEY).toBe('Control+Alt+Space')
  })

  it('blank string disables (clear-to-disable)', () => {
    expect(screenshotAccelerator('')).toBeNull()
    expect(screenshotAccelerator('   ')).toBeNull()
  })

  it('normalizes an assigned binding like captureAccelerator', () => {
    expect(screenshotAccelerator('Meta+Shift+2')).toBe('CommandOrControl+Shift+2')
    expect(screenshotAccelerator('option+space')).toBe('Alt+Space')
  })

  it('rejects Fn', () => {
    expect(screenshotAccelerator('Fn')).toBeNull()
  })
})

// Shared with main.ts's toElectronAccelerator (voice global hotkey). Space is
// recorded by HotkeyRecorder as e.key === ' ', so a stored hotkey like "Meta+ "
// must survive trim() and still normalize to a real Space accelerator rather
// than dropping the part and yielding an invalid "CommandOrControl+".
describe('normalizeAccelerator (voice hotkey)', () => {
  it('keeps a space part recorded as " " (not dropped after trim)', () => {
    expect(normalizeAccelerator('Meta+ ')).toBe('CommandOrControl+Space')
    expect(normalizeAccelerator('Meta+Shift+ ')).toBe('CommandOrControl+Shift+Space')
    expect(normalizeAccelerator('Control+space')).toBe('Control+Space')
  })
})

describe('resolveCaptureSubmit', () => {
  const ws = ['codey', 'default']

  it('trims text and resolves a known workspace', () => {
    expect(resolveCaptureSubmit('  do the thing  ', 'default', ws))
      .toEqual({ ok: true, text: 'do the thing', workspaceName: 'default' })
  })

  it('rejects empty text', () => {
    expect(resolveCaptureSubmit('   ', 'codey', ws)).toEqual({ ok: false, error: 'Nothing to send' })
  })

  it('rejects when no workspaces exist', () => {
    expect(resolveCaptureSubmit('task', 'codey', [])).toEqual({ ok: false, error: 'No workspaces configured' })
  })

  it('falls back to the first workspace when the name is missing or unknown', () => {
    expect(resolveCaptureSubmit('task', undefined, ws))
      .toEqual({ ok: true, text: 'task', workspaceName: 'codey' })
    expect(resolveCaptureSubmit('task', 'ghost', ws))
      .toEqual({ ok: true, text: 'task', workspaceName: 'codey' })
  })
})
