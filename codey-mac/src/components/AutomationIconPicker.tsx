import React, { useEffect, useRef, useState } from 'react'
import type { AutomationIcon as AutomationIconValue } from '../../../packages/core/src/types/automation'
import { C } from '../theme'
import { pillButton } from './settingsAtoms'

const EMOJIS = ['⚡️', '✨', '🚀', '📰', '🤖', '📊', '🔔', '🧪', '🛠️', '📅', '💡', '✅']
const COLORS = ['#6D5EF7', '#2563EB', '#0891B2', '#059669', '#65A30D', '#D97706', '#E11D48', '#DB2777', '#7C3AED', '#475569']

export const DEFAULT_AUTOMATION_ICON: AutomationIconValue = {
  emoji: '⚡️',
  backgroundColor: '#6D5EF7',
}

export const AutomationIconBadge: React.FC<{
  icon?: AutomationIconValue
  size?: number
  fallback?: React.ReactNode
  fallbackBackground?: string
}> = ({ icon, size = 34, fallback, fallbackBackground }) => (
  <span style={{
    width: size,
    height: size,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    borderRadius: Math.round(size * .29),
    background: icon?.backgroundColor ?? fallbackBackground ?? C.surface3,
    color: C.fg3,
    fontSize: Math.round(size * .47),
    lineHeight: 1,
  }}>
    {icon ? icon.emoji : fallback}
  </span>
)

interface PickerProps {
  icon?: AutomationIconValue
  saving?: boolean
  onSave: (icon: AutomationIconValue) => void
}

export const AutomationIconPicker: React.FC<PickerProps> = ({ icon, saving, onSave }) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AutomationIconValue>(icon ?? DEFAULT_AUTOMATION_ICON)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) setDraft(icon ?? DEFAULT_AUTOMATION_ICON)
  }, [icon, open])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const valid = !!draft.emoji.trim()

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        aria-label="Change automation icon"
        title="Change icon"
        style={iconButton}
        onClick={() => setOpen(value => !value)}
      >
        <AutomationIconBadge icon={icon ?? DEFAULT_AUTOMATION_ICON} size={44} />
        <span style={editMark}>✎</span>
      </button>
      {open && (
        <div style={popover}>
          <div style={pickerTitle}>Automation icon</div>
          <div style={pickerHint}>Choose an emoji and background color.</div>
          <div style={emojiGrid}>
            {EMOJIS.map(emoji => (
              <button
                type="button"
                key={emoji}
                aria-label={`Use ${emoji}`}
                style={emojiChoice(draft.emoji === emoji)}
                onClick={() => setDraft(value => ({ ...value, emoji }))}
              >
                {emoji}
              </button>
            ))}
          </div>
          <label style={fieldLabel}>
            Emoji
            <input
              aria-label="Custom emoji"
              style={emojiInput}
              value={draft.emoji}
              maxLength={16}
              onChange={event => setDraft(value => ({ ...value, emoji: event.target.value }))}
            />
          </label>
          <div style={fieldLabel}>
            Background
            <div style={colorRow}>
              {COLORS.map(color => (
                <button
                  type="button"
                  key={color}
                  aria-label={`Use color ${color}`}
                  style={colorChoice(color, draft.backgroundColor === color)}
                  onClick={() => setDraft(value => ({ ...value, backgroundColor: color }))}
                />
              ))}
              <label style={customColor} title="Custom color">
                <input
                  type="color"
                  aria-label="Custom background color"
                  value={draft.backgroundColor}
                  onChange={event => setDraft(value => ({ ...value, backgroundColor: event.target.value.toUpperCase() }))}
                />
              </label>
            </div>
          </div>
          <div style={previewRow}>
            <AutomationIconBadge icon={draft} size={36} />
            <span style={{ flex: 1, color: C.fg2, fontSize: 11 }}>Preview</span>
            <button
              type="button"
              style={pillButton('primary')}
              disabled={!valid || saving}
              onClick={() => {
                onSave({ ...draft, emoji: draft.emoji.trim() })
                setOpen(false)
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const iconButton: React.CSSProperties = {
  position: 'relative', display: 'grid', padding: 0, border: 'none',
  borderRadius: 13, background: 'transparent', cursor: 'pointer',
}
const editMark: React.CSSProperties = {
  position: 'absolute', right: -3, bottom: -3, width: 16, height: 16,
  display: 'grid', placeItems: 'center', borderRadius: 999,
  border: `2px solid ${C.bg}`, background: C.surface3, color: C.fg2,
  fontSize: 9, fontWeight: 800,
}
const popover: React.CSSProperties = {
  position: 'absolute', zIndex: 20, top: 52, left: 0, width: 248,
  padding: 13, borderRadius: 12, border: `1px solid ${C.border}`,
  background: C.surface, boxShadow: '0 14px 35px rgba(0,0,0,.28)',
}
const pickerTitle: React.CSSProperties = { color: C.fg, fontSize: 12.5, fontWeight: 750 }
const pickerHint: React.CSSProperties = { color: C.fg3, fontSize: 10.5, marginTop: 2, marginBottom: 11 }
const emojiGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 5 }
const emojiChoice = (active: boolean): React.CSSProperties => ({
  height: 31, borderRadius: 8, border: `1px solid ${active ? C.accent : C.border}`,
  background: active ? C.accentDim : C.surface3, cursor: 'pointer', fontSize: 16,
})
const fieldLabel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 5, color: C.fg2,
  fontSize: 10.5, fontWeight: 650, marginTop: 11,
}
const emojiInput: React.CSSProperties = {
  height: 30, boxSizing: 'border-box', padding: '4px 8px',
  border: `1px solid ${C.border}`, borderRadius: 8,
  background: C.surface3, color: C.fg, fontSize: 15, outline: 'none',
}
const colorRow: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' }
const colorChoice = (color: string, active: boolean): React.CSSProperties => ({
  width: 22, height: 22, padding: 0, borderRadius: 7, cursor: 'pointer',
  background: color, border: `2px solid ${active ? C.fg : 'transparent'}`,
  boxShadow: active ? `0 0 0 1px ${C.bg}` : 'none',
})
const customColor: React.CSSProperties = {
  width: 22, height: 22, overflow: 'hidden', borderRadius: 7,
  border: `1px solid ${C.border}`, cursor: 'pointer',
}
const previewRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, marginTop: 13,
  paddingTop: 11, borderTop: `1px solid ${C.border}`,
}
