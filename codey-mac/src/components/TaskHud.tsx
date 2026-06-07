import React from 'react'
import { C } from '../theme'
import type { TaskBrief } from '../types'
import { statusMeta, formatAgo, splitTimeline, type StatusTone } from './taskHudView'

interface Props {
  brief?: TaskBrief
  loading: boolean
  /** Focus the composer (optionally scrolling to the anchor message). */
  onAnswer: (messageId?: string) => void
}

const toneColor = (tone: StatusTone): string =>
  tone === 'yellow' ? C.yellow : tone === 'red' ? C.red : tone === 'green' ? C.green : C.accent

/** Multiline ellipsis — a UI backstop so an over-long model string can't blow out the panel. */
const clamp = (lines: number): React.CSSProperties => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
})

/** History entries shown before the "Show all" toggle kicks in. */
const TIMELINE_COLLAPSED = 2

export const TaskHud: React.FC<Props> = ({ brief, loading, onAnswer }) => {
  const [timelineExpanded, setTimelineExpanded] = React.useState(false)

  if (!brief) {
    return <div style={{ padding: 16, color: C.fg3, fontSize: 13 }}>
      {loading ? 'Generating…' : 'No task to summarize yet.'}
    </div>
  }

  const sm = statusMeta(brief.state.status)
  const { head, rest } = splitTimeline(brief.timeline)
  const shownRest = timelineExpanded ? rest : rest.slice(0, TIMELINE_COLLAPSED)

  const label = (t: string) => <div style={{ fontSize: 11, color: C.fg3, marginBottom: 8, fontWeight: 500 }}>{t}</div>
  const sect: React.CSSProperties = { padding: '14px 16px', borderTop: `1px solid ${C.border}` }

  return (
    <div style={{ fontSize: 13, color: C.fg }}>
      {loading && <div style={{ padding: '6px 16px', fontSize: 11, color: C.fg3 }}>Updating…</div>}

      {/* Goal */}
      <div style={{ ...sect, borderTop: 'none' }}>
        {label('Goal')}
        <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, ...clamp(2) }}>{brief.goal}</div>
      </div>

      {/* Current State */}
      <div style={sect}>
        {label('Current State')}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><b style={{ fontSize: 15 }}>{brief.state.progress}%</b>{brief.state.stepLabel ? ` · ${brief.state.stepLabel}` : ''}</div>
          <span style={{ fontSize: 12, padding: '3px 9px', borderRadius: 6, color: toneColor(sm.tone),
            background: `${toneColor(sm.tone)}22` }}>{sm.label}</span>
        </div>
        <div style={{ height: 4, background: C.surface3, borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${brief.state.progress}%`, background: C.accent, borderRadius: 2 }} />
        </div>
      </div>

      {/* Next Action */}
      {brief.nextAction && (
        <div style={{ ...sect, background: C.surface2 }}>
          {label('Next Action')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, ...clamp(2) }}>{brief.nextAction.text}</div>
              {brief.nextAction.detail && <div style={{ fontSize: 11, color: C.fg2, marginTop: 3, ...clamp(1) }}>{brief.nextAction.detail}</div>}
            </div>
            <button onClick={() => onAnswer(brief.nextAction?.messageId)}
              style={{ background: C.accent, color: C.onAccent, border: 'none', borderRadius: 7,
                padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Answer
            </button>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div style={sect}>
        {label('Timeline')}
        {head && (
          <div style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '9px 10px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <b>Latest</b>
              {head.when && <span style={{ fontSize: 10, color: C.accent }}>{formatAgo(head.when)}</span>}
            </div>
            {head.detail?.length ? (
              <ul style={{ listStyle: 'none', margin: '7px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {head.detail.map((d, i) => <li key={i} style={{ fontSize: 12, color: C.fg2, ...clamp(2) }}>· {d}</li>)}
              </ul>
            ) : <div style={{ fontSize: 12, color: C.fg2, marginTop: 4, ...clamp(2) }}>{head.text}</div>}
          </div>
        )}
        {shownRest.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 9, padding: '6px 0', fontSize: 12.5, lineHeight: 1.5 }}>
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', marginTop: 6,
              background: e.kind === 'dropped' ? C.fg3 : e.kind === 'decision' ? C.accent : C.green }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, textDecoration: e.kind === 'dropped' ? 'line-through' : 'none',
                  color: e.kind === 'dropped' ? C.fg2 : C.fg, ...clamp(2) }}>{e.text}</span>
                {e.when && <span style={{ color: C.fg3, fontSize: 10, whiteSpace: 'nowrap', flex: 'none' }}>{formatAgo(e.when)}</span>}
              </div>
              {e.why && <div style={{ color: C.fg3, fontSize: 11.5, marginTop: 2, ...clamp(1) }}>{e.why}</div>}
            </div>
          </div>
        ))}
        {rest.length > TIMELINE_COLLAPSED && (
          <button
            onClick={() => setTimelineExpanded(v => !v)}
            style={{ background: 'none', border: 'none', color: C.fg3, fontSize: 11, cursor: 'pointer',
              padding: '4px 0', marginTop: 2 }}
          >{timelineExpanded ? 'Show less' : `Show all (${rest.length})`}</button>
        )}
      </div>
    </div>
  )
}
