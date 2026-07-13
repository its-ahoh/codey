import React, { useEffect } from 'react'
import { C } from '../theme'
import { UIIcon, type IconName } from './UIIcons'

// Shared chrome for the app's centered modal overlays (Settings, Automations,
// Tools): dimmed blurred backdrop, fixed-size window, mac-style title bar with
// a single dot button. Children render below the title bar and own their own
// body layout/scrolling.
interface Props {
  title: string
  /** Semantic icon for the overlay title bar. */
  icon?: IconName
  /** The title-bar dot button. */
  onClose: () => void
  closeTitle?: string
  closeAriaLabel?: string
  /** Escape key + backdrop click. Defaults to onClose; pass null to disable
   *  dismissal while an inner panel needs the button to act as Back. */
  onDismiss?: (() => void) | null
  children: React.ReactNode
}

export const OverlayWindow: React.FC<Props> = ({
  title,
  icon = 'sparkle',
  onClose,
  closeTitle = 'Close (Esc)',
  closeAriaLabel = 'Close',
  onDismiss = onClose,
  children,
}) => {
  useEffect(() => {
    if (!onDismiss) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div style={styles.backdrop} onClick={onDismiss ?? undefined}>
      <div style={styles.window} onClick={e => e.stopPropagation()}>
        <div style={styles.titleBar}>
          <button onClick={onClose} style={styles.closeBtn} title={closeTitle} aria-label={closeAriaLabel}>
            <span style={styles.closeDot}>×</span>
          </button>
          <div style={styles.titleText}><span style={styles.titleMark}><UIIcon name={icon} size={13} /></span>{title}</div>
          <div style={{ width: 60 }} />
        </div>
        {children}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0,
    background: 'rgba(9,12,20,0.66)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  window: {
    width: 'min(960px, 92%)',
    height: 'min(680px, 88%)',
    background: C.surface,
    border: `1px solid ${C.border2}`,
    borderRadius: 16,
    boxShadow: '0 30px 90px rgba(0,0,0,0.5), 0 2px 10px rgba(0,0,0,0.2)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  titleBar: {
    height: 48, flexShrink: 0, display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 14px', background: C.surface2,
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 8, border: `1px solid ${C.border2}`,
    background: C.surface3, cursor: 'pointer', color: C.fg2,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeDot: { fontSize: 16, lineHeight: 1, marginTop: -1 },
  titleText: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, color: C.fg, fontSize: 13, fontWeight: 750 },
  titleMark: { width: 23, height: 23, borderRadius: 7, background: C.accentDim, color: C.accent, display: 'grid', placeItems: 'center' },
}
