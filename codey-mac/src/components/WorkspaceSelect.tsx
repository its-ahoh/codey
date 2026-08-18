import React, { useEffect, useMemo, useRef, useState } from 'react'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import { matchesToolSearch } from './tools-search'

/** Above this many workspaces the popup gets a filter field. */
const SEARCH_THRESHOLD = 8

interface Props {
  value: string
  options: string[]
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
  id?: string
}

/**
 * A workspace picker styled like the rest of the app's controls. A native
 * `<select>` renders as the macOS system popup, which reads as a foreign
 * control beside the segmented switchers it sits next to, and offers no way to
 * filter a long workspace list.
 */
export const WorkspaceSelect: React.FC<Props> = ({ value, options, onChange, disabled = false, label = 'Workspace', id }) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A stale query would silently hide options the next time the popup opens.
  useEffect(() => { if (!open) setQuery('') }, [open])

  const searchable = options.length > SEARCH_THRESHOLD
  const visible = useMemo(
    () => (searchable ? options.filter(name => matchesToolSearch(query, name)) : options),
    [options, query, searchable],
  )

  return (
    <div ref={ref} style={styles.root}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(o => !o)}
        title={value ? `Install into "${value}"` : label}
        style={{ ...styles.trigger, opacity: disabled ? 0.45 : 1 }}
      >
        <span style={styles.triggerLabel}>{value || 'Select…'}</span>
        <span style={{ ...styles.caret, transform: open ? 'rotate(-90deg)' : 'rotate(90deg)' }}>
          <UIIcon name="chevron" size={11} />
        </span>
      </button>

      {open && (
        <div style={styles.menu} role="listbox" aria-label={label}>
          {searchable && (
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter workspaces…"
              aria-label="Filter workspaces"
              style={styles.search}
              autoFocus
            />
          )}
          <div style={styles.scroll}>
            {visible.length === 0 ? (
              <div style={styles.empty}>No matching workspace</div>
            ) : visible.map(name => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={name === value}
                onClick={() => { onChange(name); setOpen(false) }}
                style={{ ...styles.item, ...(name === value ? styles.itemSelected : undefined) }}
                title={name}
              >
                <span style={styles.checkSlot}>
                  {name === value && <UIIcon name="check" size={12} />}
                </span>
                <span style={styles.itemName}>{name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { position: 'relative', display: 'inline-flex' },
  trigger: {
    minHeight: 31, maxWidth: 220, display: 'inline-flex', alignItems: 'center', gap: 6,
    border: `1px solid ${C.border}`, borderRadius: 8, padding: '4px 8px',
    background: C.bg, color: C.fg, cursor: 'pointer',
    fontSize: 11, fontWeight: 650, fontFamily: 'inherit',
  },
  triggerLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  caret: {
    color: C.fg3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 12, height: 12, flexShrink: 0, transformOrigin: 'center', transition: 'transform 0.15s ease',
  },
  menu: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, minWidth: 220,
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
    boxShadow: '0 14px 30px rgba(0,0,0,0.26)', padding: 6,
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  search: {
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6,
    color: C.fg, fontSize: 12, padding: '5px 8px', outline: 'none', fontFamily: 'inherit',
  },
  scroll: { maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  item: {
    width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
    color: C.fg, fontSize: 12, padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, fontFamily: 'inherit',
  },
  itemSelected: { background: C.accentDim, color: C.accent },
  itemName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checkSlot: { width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center' },
  empty: { color: C.fg3, fontSize: 11, padding: '12px 8px', textAlign: 'center' },
}
