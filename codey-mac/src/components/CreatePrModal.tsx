import React, { useState } from 'react'
import { C } from '../theme'

interface Props {
  defaultTitle: string
  onCancel: () => void
  onCreate: (input: { title: string; body: string }) => Promise<{ ok: boolean; url?: string; error?: string }>
}

export const CreatePrModal: React.FC<Props> = ({ defaultTitle, onCancel, onCreate }) => {
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true); setError(null)
    const r = await onCreate({ title: title.trim(), body })
    setBusy(false)
    if (r.ok && r.url) setUrl(r.url)
    else setError(r.error || 'Failed to create PR')
  }

  const openUrl = (u: string) => {
    if (window.codey?.openExternal) window.codey.openExternal(u)
    else window.open(u, '_blank')
  }

  return (
    <div style={styles.backdrop} onClick={onCancel}>
      <div style={styles.card} onClick={e => e.stopPropagation()}>
        <div style={styles.head}>Create Pull Request</div>
        {url ? (
          <>
            <div style={styles.success}>PR created.</div>
            <button style={styles.primary} onClick={() => openUrl(url)}>Open PR</button>
            <button style={styles.ghost} onClick={onCancel}>Close</button>
          </>
        ) : (
          <>
            <label style={styles.label}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} style={styles.input} />
            <label style={styles.label}>Description</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} style={styles.textarea} rows={5} />
            {error && <div style={styles.err}>{error}</div>}
            <div style={styles.row}>
              <button style={styles.primary} disabled={busy || !title.trim()} onClick={submit}>{busy ? 'Creating…' : 'Create PR'}</button>
              <button style={styles.ghost} onClick={onCancel}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { width: 420, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  head: { fontSize: 14, fontWeight: 600, color: C.fg },
  label: { fontSize: 11, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg, fontSize: 13, padding: '6px 8px', outline: 'none' },
  textarea: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg, fontSize: 13, padding: '6px 8px', outline: 'none', resize: 'vertical' },
  row: { display: 'flex', gap: 8, marginTop: 4 },
  primary: { background: C.accent, color: C.onAccent, border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  ghost: { background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer' },
  success: { fontSize: 13, color: C.green },
  err: { fontSize: 12, color: C.red },
}
