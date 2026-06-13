import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  C, applyTheme, applyPalette, getStoredThemeMode, getStoredPalette,
  paletteToCssVars, classicLight, classicDark, terminalLight, terminalDark,
} from '../theme'

// Spotlight-style capture UI rendered in its own frameless BrowserWindow
// (#/capture route). Enter dispatches via capture:submit; main hides the
// window on success. Escape hides; main also hides on blur.
type PickedFile = { path: string; name: string; size: number }

// Icons mirrored from the chat composer (QuickQuestionView) so the capture
// input reads like the main chat input: paperclip on the left, send on the right.
const PaperclipIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05L12.25 20.24a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 11-2.83-2.83l8.49-8.48" />
  </svg>
)
const SendIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" />
  </svg>
)

export const CaptureWindow: React.FC = () => {
  const [text, setText] = useState('')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<PickedFile[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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

  // Report the real content height so main can size the (bottom-anchored)
  // window to fit — short when empty, taller only when chips/text grow it.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = () => {
      try { void window.codey.capture.setHeight?.(Math.ceil(el.getBoundingClientRect().height)) }
      catch { /* main not ready */ }
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
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
    <div ref={rootRef} style={styles.root}>
      {/* Single bordered composer box, mirroring the chat input: attach button
          on the left, textarea, workspace picker, and a tall Send on the right. */}
      <div style={styles.composer}>
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
        <div style={styles.composerRow}>
          <button
            type="button"
            onClick={() => void pickFiles()}
            title="Attach files"
            style={styles.attachBtn}
          >
            <PaperclipIcon color={C.fg2} />
          </button>
          <textarea
            ref={taRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onInput={e => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            }}
            placeholder="What should Codey do?"
            rows={1}
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
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending}
            title="Send"
            style={{ ...styles.sendBtn, ...(sending ? styles.sendBtnDisabled : null) }}
          >
            {sending ? '…' : <SendIcon color={C.onAccent} />}
          </button>
        </div>
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
  html, body, #root { margin: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; }
  * { box-sizing: border-box; }
`}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  // No fixed height — the window follows this box's content via capture:setHeight.
  root: {
    display: 'flex', flexDirection: 'column', gap: 6,
    padding: 10, background: C.bg, borderRadius: 10,
    border: `1px solid ${C.border}`, overflow: 'hidden',
  },
  composer: {
    background: C.surface2, border: `1px solid ${C.border2}`,
    borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  // Attached-file chips above the input row; wrap so they never force a scroll.
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap', padding: '6px 6px 0' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 200,
    background: C.surface3, color: C.fg2, border: `1px solid ${C.border2}`,
    borderRadius: 6, padding: '2px 4px 2px 8px', fontSize: 11,
  },
  chipName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chipX: {
    background: 'none', border: 'none', color: C.fg2, cursor: 'pointer',
    fontSize: 14, lineHeight: 1, padding: '0 2px',
  },
  composerRow: { display: 'flex', gap: 6, alignItems: 'center', padding: 6 },
  attachBtn: {
    width: 34, height: 34, borderRadius: 9, border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, cursor: 'pointer',
  },
  input: {
    flex: 1, resize: 'none', background: 'transparent', color: C.fg,
    border: 'none', padding: '8px 4px', outline: 'none', fontSize: 14,
    fontFamily: 'inherit', lineHeight: 1.4, minHeight: 34, maxHeight: 120, overflowY: 'auto',
  },
  // Shorter workspace picker so the input gets the room.
  select: {
    width: 96, height: 34, background: C.surface3, color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '0 6px',
    fontSize: 12, cursor: 'pointer', flexShrink: 0,
  },
  // Taller, prominent primary action.
  sendBtn: {
    width: 56, height: 46, borderRadius: 9, border: 'none', background: C.accent,
    color: C.onAccent, fontSize: 14, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.6, cursor: 'default' },
  error: { color: C.dangerFg, fontSize: 11, paddingLeft: 2, flexShrink: 0 },
}
