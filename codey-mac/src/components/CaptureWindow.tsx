import React, { useEffect, useRef, useState } from 'react'
import {
  C, applyTheme, applyPalette, getStoredThemeMode, getStoredPalette,
  paletteToCssVars, classicLight, classicDark, terminalLight, terminalDark,
} from '../theme'

// Spotlight-style capture UI rendered in its own frameless BrowserWindow
// (#/capture route). Enter dispatches via capture:submit; main hides the
// window on success. Escape hides; main also hides on blur.
export const CaptureWindow: React.FC = () => {
  const [text, setText] = useState('')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const loadWorkspaces = async () => {
    try {
      const res = await window.codey.workspaces.list()
      if (res.ok && res.data) {
        const list = res.data
        setWorkspaces(list)
        const last = localStorage.getItem('codey.lastWorkspace')
        setWorkspace(prev =>
          prev && list.includes(prev) ? prev
            : last && list.includes(last) ? last
            : list[0] ?? '')
      }
    } catch { /* core offline — submit will surface the error */ }
  }

  useEffect(() => {
    applyTheme(getStoredThemeMode())
    applyPalette(getStoredPalette())
    void loadWorkspaces()
    taRef.current?.focus()
    const off = window.codey.capture.onShown(() => {
      setError(null)
      void loadWorkspaces()
      setTimeout(() => taRef.current?.focus(), 0)
    })
    return off
  }, [])

  const submit = async () => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const res = await window.codey.capture.submit({ workspaceName: workspace || undefined, text })
      if (res.ok) {
        setText('')
        if (workspace) localStorage.setItem('codey.lastWorkspace', workspace)
      } else {
        setError(res.error)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void window.codey.capture.hide()
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.row}>
        <textarea
          ref={taRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What should Codey do? (↵ to send, esc to dismiss)"
          rows={2}
          autoFocus
          style={styles.input}
        />
        <select
          aria-label="Workspace"
          value={workspace}
          onChange={e => setWorkspace(e.target.value)}
          style={styles.select}
        >
          {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <style>{`
  /* Same theme matrix as App.tsx so applyTheme/applyPalette take effect. */
  :root { ${paletteToCssVars(classicDark)} }
  :root[data-theme="light"] { ${paletteToCssVars(classicLight)} }
  :root[data-theme="dark"] { ${paletteToCssVars(classicDark)} }
  :root[data-palette="classic"][data-theme="light"] { ${paletteToCssVars(classicLight)} }
  :root[data-palette="classic"][data-theme="dark"] { ${paletteToCssVars(classicDark)} }
  :root[data-palette="terminal"][data-theme="light"] { ${paletteToCssVars(terminalLight)} }
  :root[data-palette="terminal"][data-theme="dark"] { ${paletteToCssVars(terminalDark)} }
  html, body, #root { height: 100%; margin: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; }
  * { box-sizing: border-box; }
`}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100vh', display: 'flex', flexDirection: 'column', gap: 6,
    padding: 12, background: C.bg, borderRadius: 10,
    border: `1px solid ${C.border}`, overflow: 'hidden',
  },
  row: { display: 'flex', gap: 8, flex: 1, minHeight: 0 },
  input: {
    flex: 1, resize: 'none', background: C.surface2, color: C.fg,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '10px 12px',
    fontSize: 14, outline: 'none', fontFamily: 'inherit',
  },
  select: {
    alignSelf: 'stretch', background: C.surface2, color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '0 8px',
    fontSize: 12, cursor: 'pointer', maxWidth: 140,
  },
  error: { color: C.dangerFg, fontSize: 11, paddingLeft: 2, flexShrink: 0 },
}
