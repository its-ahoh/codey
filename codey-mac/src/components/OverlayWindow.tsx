import React, { useEffect } from 'react'
import { C } from '../theme'

// Shared chrome for the app's centered modal overlays (Settings, Automations,
// Tools): dimmed blurred backdrop, fixed-size window, mac-style title bar with
// a single dot button. Children render below the title bar and own their own
// body layout/scrolling.
interface Props {
  title: string
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
            <span style={styles.closeDot} />
          </button>
          <div style={styles.titleText}>{title}</div>
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
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(3px)',
    WebkitBackdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  window: {
    width: 'min(900px, 92%)',
    height: 'min(620px, 88%)',
    background: C.bg,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  titleBar: {
    height: 40, flexShrink: 0, display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 12px',
  },
  closeBtn: {
    width: 24, height: 24, borderRadius: '50%', border: 'none',
    background: 'transparent', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeDot: { width: 12, height: 12, borderRadius: '50%', background: C.red },
  titleText: { flex: 1, textAlign: 'center', color: C.fg, fontSize: 13, fontWeight: 600 },
}
