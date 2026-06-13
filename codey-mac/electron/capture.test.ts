import { describe, it, expect } from 'vitest'
import { captureAccelerator, resolveCaptureSubmit, DEFAULT_CAPTURE_HOTKEY } from './capture'

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
