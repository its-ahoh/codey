import React, { useEffect, useRef, useState } from 'react'
import {
  C, applyTheme, applyPalette, getStoredThemeMode, getStoredPalette,
  paletteToCssVars, classicLight, classicDark, terminalLight, terminalDark,
} from '../theme'

// Spotlight-style capture UI rendered in its own frameless BrowserWindow
// (#/capture route). Enter dispatches via capture:submit; main hides the
// window on success. Escape hides; main also hides on blur.
type PickedFile = { path: string; name: string; size: number }

export const CaptureWindow: React.FC = () => {
  const [text, setText] = useState('')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<PickedFile[]>([])
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
    const off = window.codey.capture.onShown(payload => {
      setError(null)
      const incoming = payload?.files ?? []
      // A plain summon (no payload) starts fresh; a screenshot/prefill summon
      // adds its file(s) to whatever is already staged, deduped by path.
      setFiles(prev => {
        if (incoming.length === 0) return []
        const seen = new Set(prev.map(f => f.path))
        return [...prev, ...incoming.filter(f => !seen.has(f.path))]
      })
      void loadWorkspaces()
      setTimeout(() => taRef.current?.focus(), 0)
    })
    return off
  }, [])

  const pickFiles = async () => {
    try {
      const res = await window.codey.capture.pickFiles()
      if (res.ok && res.data) {
        setFiles(prev => {
          const seen = new Set(prev.map(f => f.path))
          return [...prev, ...res.data!.files.filter(f => !seen.has(f.path))]
        })
      }
    } catch { /* dialog cancelled or core offline — nothing to attach */ }
    taRef.current?.focus()
  }

  const removeFile = (path: string) => setFiles(prev => prev.filter(f => f.path !== path))

  const submit = async () => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const res = await window.codey.capture.submit({
        workspaceName: workspace || undefined,
        text,
        filePaths: files.length > 0 ? files.map(f => f.path) : undefined,
      })
      if (res.ok) {
        setText('')
        setFiles([])
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
        <div style={styles.rightCol}>
          <button
            type="button"
            onClick={() => void pickFiles()}
            title="Attach files"
            style={styles.attachBtn}
          >
            📎 Attach
          </button>
          <select
            aria-label="Workspace"
            value={workspace}
            onChange={e => setWorkspace(e.target.value)}
            style={styles.select}
          >
            {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending}
            style={{ ...styles.sendBtn, ...(sending ? styles.sendBtnDisabled : null) }}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      {files.length > 0 && (
        <div style={styles.chips}>
          {files.map(f => (
            <span key={f.path} style={styles.chip} title={f.name}>
              <span style={styles.chipName}>{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(f.path)}
                aria-label={`Remove ${f.name}`}
                style={styles.chipX}
              >×</button>
            </span>
          ))}
        </div>
      )}
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
  // Right-hand controls share one fixed-width column: attach, project picker,
  // and the primary Send action stacked top-to-bottom.
  rightCol: {
    display: 'flex', flexDirection: 'column', gap: 6, width: 132, flexShrink: 0,
  },
  attachBtn: {
    background: C.surface2, color: C.fg2, border: `1px solid ${C.border2}`,
    borderRadius: 8, padding: '0 8px', height: 30, fontSize: 12,
    cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
  },
  select: {
    flex: 1, minHeight: 0, background: C.surface2, color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '0 8px',
    fontSize: 12, cursor: 'pointer',
  },
  sendBtn: {
    background: C.accent, color: C.onAccent, border: 'none',
    borderRadius: 8, height: 34, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
  },
  sendBtnDisabled: { opacity: 0.6, cursor: 'default' },
  // Attached-file chips, horizontally scrollable so a long list never grows
  // the fixed-size capture window.
  chips: {
    display: 'flex', gap: 6, flexShrink: 0, overflowX: 'auto',
    paddingBottom: 2,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
    maxWidth: 180, background: C.surface2, color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 6,
    padding: '2px 4px 2px 8px', fontSize: 11,
  },
  chipName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chipX: {
    background: 'none', border: 'none', color: C.fg2, cursor: 'pointer',
    fontSize: 14, lineHeight: 1, padding: '0 2px',
  },
  error: { color: C.dangerFg, fontSize: 11, paddingLeft: 2, flexShrink: 0 },
}
