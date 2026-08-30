import React, { useEffect, useState } from 'react'
import { C } from '../theme'
import type { FileAttachment } from '../types'
import { previewKind } from './attachmentKind'

const assetUrl = (absPath: string): string =>
  `codey-asset://file/${encodeURIComponent(absPath)}`

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/**
 * Full-view of one attachment, opened by clicking its chip or thumbnail.
 *
 * Clicking an attachment used to either do nothing (composer chips) or hand the
 * file to the OS (sent chips), which drops the user out of the app just to see
 * what they attached. Images and PDFs stream straight off the codey-asset
 * protocol; text-ish files are read through the existing capped readTextFile
 * bridge. Anything we can't render keeps the old escape hatch as a button.
 */
export const AttachmentPreview: React.FC<{
  attachment: FileAttachment
  onClose: () => void
}> = ({ attachment, onClose }) => {
  const kind = previewKind(attachment)
  const [text, setText] = useState<string | null>(null)
  const [textFailed, setTextFailed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (kind !== 'text') return
    let live = true
    setText(null)
    setTextFailed(false)
    void (async () => {
      const content = await window.codey?.readTextFile?.(attachment.path).catch(() => null)
      if (!live) return
      if (typeof content === 'string') setText(content)
      else setTextFailed(true)
    })()
    return () => { live = false }
  }, [kind, attachment.path])

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.card} onClick={e => e.stopPropagation()} role="dialog" aria-label={attachment.name}>
        <div style={styles.head}>
          <div style={styles.headText}>
            <span style={styles.name}>{attachment.name}</span>
            <span style={styles.meta}>{formatBytes(attachment.size)}{attachment.mimeType ? ` · ${attachment.mimeType}` : ''}</span>
          </div>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close preview">×</button>
        </div>

        <div style={styles.body}>
          {kind === 'image' && (
            <img src={assetUrl(attachment.path)} alt={attachment.name} style={styles.image} />
          )}
          {kind === 'pdf' && (
            <iframe src={assetUrl(attachment.path)} title={attachment.name} style={styles.frame} />
          )}
          {kind === 'text' && (
            text !== null
              ? <pre style={styles.text}>{text || '(empty file)'}</pre>
              : <div style={styles.note}>{textFailed
                  ? 'Codey couldn’t read this file as text — it may be binary or larger than 2 MB.'
                  : 'Loading…'}</div>
          )}
          {kind === 'other' && (
            <div style={styles.note}>No preview for this file type. Open it in another app to see the contents.</div>
          )}
        </div>

        <div style={styles.row}>
          <button style={styles.secondary} onClick={() => { void window.codey?.revealInFolder?.(attachment.path) }}>
            Show in Finder
          </button>
          <button style={styles.primary} onClick={() => { void window.codey?.openPath?.(attachment.path) }}>
            Open in default app
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 60,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  card: {
    width: 820, maxWidth: '100%', maxHeight: '100%', background: C.surface2,
    border: `1px solid ${C.border}`, borderRadius: 12, padding: 14,
    display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden',
  },
  head: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  headText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  name: { fontSize: 13, fontWeight: 600, color: C.fg, overflowWrap: 'anywhere' },
  meta: { fontSize: 11, color: C.fg3 },
  closeBtn: {
    background: 'transparent', border: 'none', color: C.fg3, fontSize: 20,
    lineHeight: 1, cursor: 'pointer', padding: '0 4px',
  },
  body: {
    flex: 1, minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto',
  },
  image: { maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' },
  frame: { width: '100%', height: '70vh', border: 'none', background: '#fff' },
  text: {
    margin: 0, padding: 12, width: '100%', alignSelf: 'stretch', color: C.fg2,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
    lineHeight: 1.55, maxHeight: '70vh', overflow: 'auto',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  note: { padding: 24, fontSize: 12, color: C.fg3, textAlign: 'center' },
  row: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  secondary: {
    background: C.surface3, color: C.fg2, border: `1px solid ${C.border}`, borderRadius: 7,
    padding: '7px 14px', fontSize: 13, cursor: 'pointer',
  },
  primary: {
    background: C.accent, color: C.onAccent, border: 'none', borderRadius: 7,
    padding: '7px 14px', fontSize: 13, cursor: 'pointer',
  },
}
