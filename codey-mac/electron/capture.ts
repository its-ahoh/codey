// Pure logic for the global quick-capture feature. No Electron imports so it
// is unit-testable; main.ts owns the BrowserWindow/globalShortcut glue.

export const DEFAULT_CAPTURE_HOTKEY = 'Alt+Space'

// Shared normalization (WhisperTab format → Electron accelerator), kept pure
// here for testability. Reused by main.ts's toElectronAccelerator so the voice
// and quick-capture hotkeys stay in lockstep. The `low === ''` branch matters:
// HotkeyRecorder stores Space as e.key === ' ', which becomes '' after trim().
export function normalizeAccelerator(hotkey: string): string {
  return hotkey
    .split('+')
    .map(p => p.trim())
    .map(p => {
      const low = p.toLowerCase()
      if (low === 'meta' || low === 'cmd' || low === 'command') return 'CommandOrControl'
      if (low === 'control' || low === 'ctrl') return 'Control'
      if (low === 'alt' || low === 'option') return 'Alt'
      if (low === 'shift') return 'Shift'
      if (low === '' || low === 'space') return 'Space'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join('+')
}

// undefined → feature default; blank → disabled; Fn → disabled (Electron's
// globalShortcut cannot bind Fn — that path exists only for the voice helper).
export function captureAccelerator(hotkey: string | undefined): string | null {
  if (hotkey === undefined) return DEFAULT_CAPTURE_HOTKEY
  const t = hotkey.trim()
  if (!t) return null
  if (t.toLowerCase() === 'fn') return null
  return normalizeAccelerator(t)
}

export type CaptureSubmitResolution =
  | { ok: true; text: string; workspaceName: string }
  | { ok: false; error: string }

export function resolveCaptureSubmit(
  text: string,
  workspaceName: string | undefined,
  knownWorkspaces: string[],
): CaptureSubmitResolution {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Nothing to send' }
  if (knownWorkspaces.length === 0) return { ok: false, error: 'No workspaces configured' }
  const ws = workspaceName && knownWorkspaces.includes(workspaceName)
    ? workspaceName
    : knownWorkspaces[0]
  return { ok: true, text: trimmed, workspaceName: ws }
}
