import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'

const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? C.onAccent : variant === 'danger' ? C.red : C.fg2,
})

export const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
export const LOCK_KEYS = new Set(['CapsLock', 'NumLock', 'ScrollLock'])

export function formatKeyCombo(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key) || LOCK_KEYS.has(e.key)) return null

  const parts: string[] = []
  if (e.metaKey) parts.push('⌘')
  if (e.ctrlKey) parts.push('⌃')
  if (e.altKey) parts.push('⌥')
  if (e.shiftKey) parts.push('⇧')

  const keyMap: Record<string, string> = {
    ' ': 'Space', 'ArrowUp': '↑', 'ArrowDown': '↓',
    'ArrowLeft': '←', 'ArrowRight': '→', 'Backspace': '⌫',
    'Delete': '⌦', 'Enter': '↵', 'Tab': '⇥', 'Escape': '⎋',
  }
  const keyLabel = keyMap[e.key] ?? e.key.toUpperCase()
  parts.push(keyLabel)

  return parts.join('')
}

export function formatHotkeyString(hotkey: string): string {
  if (!hotkey) return ''
  if (/[⌘⌃⌥⇧]/.test(hotkey)) return hotkey

  const parts = hotkey.split('+').map(s => s.trim())
  const result: string[] = []
  let mainKey = ''

  for (const p of parts) {
    switch (p.toLowerCase()) {
      case 'meta': case 'cmd': case 'command': result.push('⌘'); break
      case 'ctrl': case 'control': result.push('⌃'); break
      case 'alt': case 'option': result.push('⌥'); break
      case 'shift': result.push('⇧'); break
      default: mainKey = p; break
    }
  }
  if (mainKey) result.push(mainKey)
  return result.join('')
}

export const HotkeyRecorder: React.FC<{
  value: string
  onChange: (hotkey: string) => void
}> = ({ value, onChange }) => {
  const [recording, setRecording] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (LOCK_KEYS.has(e.key)) return

    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      setRecording(false)
      return
    }

    const combo = formatKeyCombo(e)
    if (combo) {
      const parts: string[] = []
      if (e.metaKey) parts.push('Meta')
      if (e.ctrlKey) parts.push('Control')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (!MODIFIER_KEYS.has(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
      onChange(parts.join('+'))
      setRecording(false)
    }
  }, [onChange])

  useEffect(() => {
    if (!recording) return
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, handleKeyDown])

  useEffect(() => {
    if (!recording) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setRecording(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [recording])

  const displayValue = recording ? 'Press keys...' : (value ? formatHotkeyString(value) : 'Not set')

  return (
    <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        ...inputStyle,
        width: 140,
        textAlign: 'center',
        cursor: 'pointer',
        color: recording ? C.accent : value ? C.fg : C.fg3,
        border: recording ? `1px solid ${C.accent}` : inputStyle.border,
        background: recording ? C.accentDim : inputStyle.background,
        animation: recording ? 'pulse 1.5s ease-in-out infinite' : 'none',
        userSelect: 'none',
      }} onClick={() => setRecording(true)}>
        {displayValue}
      </div>
      {value && !recording && (
        <button onClick={() => onChange('')} style={pillButton('ghost')} title="Clear hotkey">
          Reset
        </button>
      )}
      {recording && (
        <span style={{ color: C.fg3, fontSize: 11 }}>Esc to cancel</span>
      )}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  )
}
