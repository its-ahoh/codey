import React, { useState } from 'react'
import { C } from '../theme'
import './chatHeaderActions.css'

/** A chat title that can be renamed in place without leaving the header. */
export function InlineRenameTitle({ title, onRename, style }: {
  title: string
  onRename: (title: string) => Promise<unknown>
  style?: React.CSSProperties
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const close = () => {
    setDraft(null)
    setError('')
  }

  const save = async () => {
    if (draft === null || saving) return
    const next = draft.trim()
    if (!next) {
      setError('Name cannot be empty')
      return
    }
    if (next === title) {
      close()
      return
    }

    setSaving(true)
    setError('')
    try {
      await onRename(next)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rename failed')
    } finally {
      setSaving(false)
    }
  }

  if (draft === null) {
    return <span
      data-testid="inline-rename-label"
      className="inline-rename-title"
      title="Double-click to rename"
      onDoubleClick={event => {
        event.stopPropagation()
        setError('')
        setDraft(title)
      }}
      style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text', ...style }}
    >{title}</span>
  }

  return <span className="inline-rename-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
    <input
      autoFocus
      aria-label="Rename chat"
      aria-invalid={error ? true : undefined}
      aria-busy={saving || undefined}
      readOnly={saving}
      maxLength={120}
      value={draft}
      onFocus={event => event.currentTarget.select()}
      onChange={event => {
        setDraft(event.target.value)
        if (error) setError('')
      }}
      onBlur={() => { void save() }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void save()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!saving) close()
        }
      }}
      style={{
        font: 'inherit', color: C.fg, background: C.surface3, border: `1px solid ${error ? C.red : C.border2}`,
        borderRadius: 6, padding: '2px 6px', outline: 'none', minWidth: 120,
        width: `${Math.max(draft.length, 8) + 2}ch`, maxWidth: '100%',
      }}
    />
    {error && <span role="alert" style={{ color: C.red, fontSize: 12, fontWeight: 400, whiteSpace: 'nowrap' }}>{error}</span>}
  </span>
}
