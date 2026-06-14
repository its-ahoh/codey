import React from 'react'
import { C } from '../theme'
import { statusMeta, formatAgo, type SidecarView, type StatusTone } from './taskHudView'

interface Props {
  view: SidecarView
  /** True while a (re)generation of the brief is in flight. */
  loading: boolean
  /** Open the full panel on the Status tab. */
  onOpen: () => void
  width: number
}

const toneColor = (tone: StatusTone): string =>
  tone === 'yellow' ? C.yellow : tone === 'red' ? C.red : tone === 'green' ? C.green : C.accent

const clamp = (lines: number): React.CSSProperties => ({
  display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden',
})

const COLLAPSE_KEY = 'codey.statusSidecarCollapsed'

export const StatusSidecar: React.FC<Props> = ({ view, loading, onOpen, width }) => {
  const sm = statusMeta(view.status)
  const [collapsed, setCollapsed] = React.useState<boolean>(() => localStorage.getItem(COLLAPSE_KEY) === '1')
  React.useEffect(() => { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0') }, [collapsed])

  const pill = (
    <span style={{ ...styles.pill, color: toneColor(sm.tone), background: `${toneColor(sm.tone)}22` }}>{sm.label}</span>
  )

  return (
    <div
      style={{ ...styles.root, width }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      title="Open status panel"
    >
      <div
        style={styles.header}
        onClick={(e) => { e.stopPropagation(); setCollapsed(v => !v) }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setCollapsed(v => !v) }
        }}
        title={collapsed ? 'Expand status' : 'Collapse status'}
        aria-expanded={!collapsed}
      >
        <span style={styles.headerLabel}>Status</span>
        <div style={styles.headerRight}>
          {loading && <span style={styles.headerLoading}>updating…</span>}
          <svg
            style={{ ...styles.chevron, transform: collapsed ? 'rotate(-90deg)' : 'none' }}
            width="14" height="14" viewBox="0 0 14 14" aria-hidden
          >
            <path d="M3.5 5.25 L7 8.75 L10.5 5.25" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {collapsed ? (
        <div style={styles.statusRow}>
          {pill}
          <span style={styles.progress}>{view.progress}%</span>
        </div>
      ) : (
        <>
          <div style={styles.goal}>{view.goal}</div>

          <div style={styles.statusRow}>
            {pill}
            <span style={styles.progress}>{view.progress}%</span>
          </div>
          <div style={styles.barTrack}>
            <div style={{ ...styles.barFill, width: `${view.progress}%` }} />
          </div>

          {view.nextActionText && (
            <div style={styles.nextBox}>
              <div style={styles.sectionLabel}>Next</div>
              <div style={styles.nextText}>{view.nextActionText}</div>
            </div>
          )}

          {view.recent.length > 0 && (
            <div style={styles.recent}>
              <div style={styles.sectionLabel}>Recent</div>
              {view.recent.map((r, i) => (
                <div key={i} style={styles.recentRow}>
                  <span style={styles.dot} />
                  <span style={styles.recentText}>{r.text}</span>
                  {r.when != null && <span style={styles.recentWhen}>{formatAgo(r.when)}</span>}
                </div>
              ))}
            </div>
          )}

          <div style={styles.footer}>Open panel →</div>
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    // Floats over the chat in the top-right corner — does not take layout space.
    position: 'absolute', top: 52, right: 16, zIndex: 6,
    maxHeight: 'calc(100% - 68px)',
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '12px 13px', overflowY: 'auto', cursor: 'pointer',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    cursor: 'pointer', userSelect: 'none',
    // Stretch the click target across the full card width.
    margin: '-12px -13px 0', padding: '12px 13px 8px',
  },
  headerLabel: { fontSize: 10, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: C.fg3 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  headerLoading: { fontSize: 10, color: C.fg3, fontStyle: 'italic' },
  chevron: { color: C.fg2, display: 'block', flex: 'none', transition: 'transform 0.15s ease' },
  goal: { fontSize: 13, fontWeight: 600, color: C.fg, lineHeight: 1.35, ...clamp(2) },
  statusRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  pill: { fontSize: 11, padding: '2px 7px', borderRadius: 6 },
  progress: { fontSize: 12, fontWeight: 600, color: C.fg, fontVariantNumeric: 'tabular-nums' },
  barTrack: { height: 4, background: C.surface3, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', background: C.accent, borderRadius: 2 },
  nextBox: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '8px 9px' },
  sectionLabel: { fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: C.fg3, marginBottom: 5 },
  nextText: { fontSize: 12, fontWeight: 600, color: C.fg, lineHeight: 1.4, ...clamp(2) },
  recent: { display: 'flex', flexDirection: 'column' },
  recentRow: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '4px 0' },
  dot: { flex: 'none', width: 6, height: 6, borderRadius: '50%', background: C.green, marginTop: 5 },
  recentText: { flex: 1, minWidth: 0, fontSize: 12, color: C.fg2, lineHeight: 1.4, ...clamp(2) },
  recentWhen: { flex: 'none', fontSize: 10, color: C.fg3, whiteSpace: 'nowrap' },
  footer: { fontSize: 11, color: C.fg3, paddingTop: 2 },
}
