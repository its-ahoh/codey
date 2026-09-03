import React from 'react'
import { C } from '../theme'

export const sectionStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  color: C.fg, fontSize: 13, fontWeight: 700,
  marginTop: 22, marginBottom: 10, paddingBottom: 8,
  borderBottom: `1px solid ${C.border}`,
}
export const pageStyle: React.CSSProperties = { padding: 20, height: '100%', overflowY: 'auto' }
export const pageIntroStyle: React.CSSProperties = { color: C.fg3, fontSize: 11, lineHeight: 1.5, marginBottom: 14 }
export const fieldStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '13px 14px', border: `1px solid ${C.border}`,
  background: C.surface, borderRadius: 10, marginBottom: 8,
}
export const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 8,
  color: C.fg, fontSize: 13, padding: '8px 10px', outline: 'none', width: 180,
}
export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

export const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 650,
  border: variant === 'ghost' ? `1px solid ${C.border2}` : '1px solid transparent', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? C.onAccent : variant === 'danger' ? C.red : C.fg2,
})

export const Section: React.FC<{ title: string; description?: string; right?: React.ReactNode; first?: boolean }> = ({ title, description, right, first }) => (
  <div style={{ ...sectionStyle, marginTop: first ? 0 : sectionStyle.marginTop }}>
    <div>
      <div>{title}</div>
      {description && <div style={{ color: C.fg3, fontSize: 11, fontWeight: 400, marginTop: 2 }}>{description}</div>}
    </div>
    {right}
  </div>
)

export function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (r.ok) return r.data
  throw new Error(r.error)
}

export const Toggle: React.FC<{
  on: boolean
  onChange: (v: boolean) => void
  label?: string
  /** Greyed out and unclickable while the change it drives is in flight, so a
   *  second click cannot race the first. */
  disabled?: boolean
  title?: string
}> = ({ on, onChange, label, disabled = false, title }) => (
  <div
    onClick={() => { if (!disabled) onChange(!on) }}
    role="switch"
    aria-checked={on}
    aria-label={label}
    aria-disabled={disabled || undefined}
    title={title}
    style={{
    width: 36, height: 20, borderRadius: 10, flexShrink: 0,
    background: on ? C.accent : C.surface3,
    border: `1px solid ${on ? C.accent : C.border2}`,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    position: 'relative', transition: 'all 0.2s',
  }}>
    <div style={{
      position: 'absolute', top: 1, left: on ? 17 : 1,
      width: 16, height: 16, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    }}/>
  </div>
)
