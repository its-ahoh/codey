// Whether the Status panel (right-panel Status tab + the floating sidecar) is
// available at all. Off means it is never rendered and its brief is never
// generated — the setting gates the LLM call, not just the pixels.
import { useEffect, useState } from 'react'

export const STATUS_PANEL_ENABLED_KEY = 'codey.statusPanelEnabled'
const CHANGED_EVENT = 'codey:statusPanelEnabled'

export function getStatusPanelEnabled(): boolean {
  try {
    return localStorage.getItem(STATUS_PANEL_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

export function setStatusPanelEnabled(enabled: boolean): void {
  try { localStorage.setItem(STATUS_PANEL_ENABLED_KEY, enabled ? '1' : '0') } catch { /* ignore */ }
  // Settings and the chat live in the same window, so `storage` never fires
  // between them — broadcast explicitly so the panel reacts immediately.
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT))
}

export function useStatusPanelEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(getStatusPanelEnabled)
  useEffect(() => {
    const sync = () => setEnabled(getStatusPanelEnabled())
    const onStorage = (e: StorageEvent) => { if (e.key === STATUS_PANEL_ENABLED_KEY) sync() }
    window.addEventListener(CHANGED_EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return enabled
}
