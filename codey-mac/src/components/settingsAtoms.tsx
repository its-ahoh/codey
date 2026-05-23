import React from 'react'
import { C } from '../theme'

export const sectionStyle: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase', marginTop: 22, marginBottom: 8,
}
export const fieldStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 0', borderBottom: `1px solid ${C.border}`,
}
export const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

export const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? '#fff' : variant === 'danger' ? C.red : C.fg2,
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
