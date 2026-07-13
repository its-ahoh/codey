import React from 'react'
import { C } from '../theme'

export const sectionStyle: React.CSSProperties = {
  color: C.fg3, fontSize: 10, fontWeight: 750, letterSpacing: 0.8,
  textTransform: 'uppercase', marginTop: 26, marginBottom: 9,
}
export const fieldStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '13px 14px', borderBottom: `1px solid ${C.border}`,
  background: C.surface, borderRadius: 10,
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

export const Section: React.FC<{ title: string; right?: React.ReactNode }> = ({ title, right }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...sectionStyle }}>
    <span>{title}</span>
    {right}
  </div>
)

export function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (r.ok) return r.data
  throw new Error(r.error)
}
