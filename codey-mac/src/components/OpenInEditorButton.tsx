import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { UIIcon } from './UIIcons'

interface EditorInfo { id: string; name: string; installed: boolean }

const PREFERRED_KEY = 'codey.preferredEditor'

const primaryStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
  background: C.surface3, color: C.fg2, border: `1px solid ${C.border2}`,
  borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 'none',
  whiteSpace: 'nowrap',
}
const dropdownStyle: React.CSSProperties = {
  padding: '3px 6px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
  background: C.surface3, color: C.fg2, border: `1px solid ${C.border2}`,
  borderTopLeftRadius: 0, borderBottomLeftRadius: 0, display: 'inline-flex', alignItems: 'center',
}
const menuStyle: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 1000,
  background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
  boxShadow: '0 6px 20px rgba(0,0,0,0.25)', minWidth: 170, padding: 4,
  display: 'flex', flexDirection: 'column',
}
const menuItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 6,
  background: 'transparent', border: 'none', color: C.fg, fontSize: 12, cursor: 'pointer',
  textAlign: 'left', width: '100%',
}

/**
 * Compact "Open in" split button: opens a file (or directory) in the user's
 * preferred editor, with a chevron to pick another installed editor. Shares
 * the `codey.preferredEditor` preference with the chat toolbar's Open-in.
 */
export const OpenInEditorButton: React.FC<{ path: string }> = ({ path }) => {
  const [editors, setEditors] = useState<EditorInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [preferredId, setPreferredId] = useState(() => localStorage.getItem(PREFERRED_KEY) ?? '')

  const loadEditors = useCallback(async (): Promise<EditorInfo[]> => {
    if (loaded) return editors
    const res = await window.codey.editors.list()
    const next = res.ok ? res.data : []
    if (res.ok) setEditors(next)
    setLoaded(true)
    return next
  }, [loaded, editors])

  useEffect(() => { void loadEditors() }, [])

  const open = useCallback(async (editor: EditorInfo) => {
    setOpening(editor.id)
    setMenuOpen(false)
    const res = await window.codey.editors.open(editor.id, path)
    setOpening(null)
    if (!res.ok) { alert(`Couldn't open ${editor.name}: ${res.error}`); return }
    setPreferredId(editor.id)
    localStorage.setItem(PREFERRED_KEY, editor.id)
  }, [path])

  const openPreferred = useCallback(async () => {
    const available = (loaded ? editors : await loadEditors()).filter(e => e.installed)
    const target = available.find(e => e.id === preferredId) ?? available[0]
    if (target) await open(target)
  }, [loaded, editors, loadEditors, preferredId, open])

  const installed = editors.filter(e => e.installed)
  const preferred = installed.find(e => e.id === preferredId)
  const disabled = opening !== null || (loaded && installed.length === 0)

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch', flexShrink: 0 }}>
      <button
        onClick={() => void openPreferred()}
        disabled={disabled}
        title={preferred ? `Open in ${preferred.name}` : 'Open in editor'}
        style={primaryStyle}
      >
        {opening ? 'Opening…' : 'Open in'}
      </button>
      <button
        onClick={async () => { if (!loaded) await loadEditors(); setMenuOpen(o => !o) }}
        disabled={opening !== null}
        title="Choose another editor"
        aria-label="Choose another editor"
        style={dropdownStyle}
      >
        <UIIcon name="chevron" size={11} />
      </button>
      {menuOpen && (
        <>
          <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div style={menuStyle} onClick={e => e.stopPropagation()}>
            {!loaded ? (
              <div style={{ color: C.fg3, fontSize: 11, padding: '6px 9px' }}>Checking editors…</div>
            ) : installed.length > 0 ? (
              installed.map(editor => (
                <button key={editor.id} style={menuItemStyle} onClick={() => void open(editor)}>
                  <span style={{ flex: 1 }}>{opening === editor.id ? `Opening ${editor.name}…` : editor.name}</span>
                  {editor.id === preferredId && <UIIcon name="check" size={13} />}
                </button>
              ))
            ) : (
              <div style={{ color: C.fg3, fontSize: 11, padding: '6px 9px' }}>No supported editor found.</div>
            )}
          </div>
        </>
      )}
    </span>
  )
}
