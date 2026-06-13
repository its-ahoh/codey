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

export const StatusSidecar: React.FC<Props> = ({ view, loading, onOpen, width }) => {
  const sm = statusMeta(view.status)
  return (
    <div
      style={{ ...styles.root, width }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      title="Open status panel"
    >
      <div style={styles.header}>
        <span style={styles.headerLabel}>Status</span>
        {loading && <span style={styles.headerLoading}>updating…</span>}
      </div>

      <div style={styles.goal}>{view.goal}</div>

      <div style={styles.statusRow}>
        <span style={{ ...styles.pill, color: toneColor(sm.tone), background: `${toneColor(sm.tone)}22` }}>{sm.label}</span>
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
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%', background: C.surface2, borderLeft: `1px solid ${C.border}`,
    flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10,
    padding: '12px 12px', overflowY: 'auto', cursor: 'pointer',
  },
  header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
  headerLabel: { fontSize: 10, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: C.fg3 },
  headerLoading: { fontSize: 10, color: C.fg3, fontStyle: 'italic' },
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
  footer: { marginTop: 'auto', fontSize: 11, color: C.fg3, paddingTop: 8 },
}
