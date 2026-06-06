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

export const TaskHud: React.FC<Props> = ({ brief, loading, onAnswer }) => {
  if (!brief) {
    return <div style={{ padding: 16, color: C.fg3, fontSize: 13 }}>
      {loading ? '生成中…' : '这个对话还没有可总结的任务。'}
    </div>
  }

  const sm = statusMeta(brief.state.status)
  const { head, rest } = splitTimeline(brief.timeline)

  const label = (t: string) => <div style={{ fontSize: 11, color: C.fg3, marginBottom: 8, fontWeight: 500 }}>{t}</div>
  const sect: React.CSSProperties = { padding: '14px 16px', borderTop: `1px solid ${C.border}` }

  return (
    <div style={{ fontSize: 13, color: C.fg }}>
      {loading && <div style={{ padding: '6px 16px', fontSize: 11, color: C.fg3 }}>更新中…</div>}

      {/* Goal */}
      <div style={{ ...sect, borderTop: 'none' }}>
        {label('目标')}
        <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{brief.goal}</div>
      </div>

      {/* Current State */}
      <div style={sect}>
        {label('当前状态')}
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
          {label('下一步')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{brief.nextAction.text}</div>
              {brief.nextAction.detail && <div style={{ fontSize: 11, color: C.fg2, marginTop: 3 }}>{brief.nextAction.detail}</div>}
            </div>
            <button onClick={() => onAnswer(brief.nextAction?.messageId)}
              style={{ background: C.accent, color: C.onAccent, border: 'none', borderRadius: 7,
                padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              回答
            </button>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div style={sect}>
        {label('时间线')}
        {head && (
          <div style={{ background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '9px 10px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <b>最新进展</b>
              {head.when && <span style={{ fontSize: 10, color: C.accent }}>{formatAgo(head.when)}</span>}
            </div>
            {head.detail?.length ? (
              <ul style={{ listStyle: 'none', margin: '7px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {head.detail.map((d, i) => <li key={i} style={{ fontSize: 12, color: C.fg2 }}>· {d}</li>)}
              </ul>
            ) : <div style={{ fontSize: 12, color: C.fg2, marginTop: 4 }}>{head.text}</div>}
          </div>
        )}
        {rest.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 9, padding: '6px 0', fontSize: 12.5, lineHeight: 1.5 }}>
            <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', marginTop: 6,
              background: e.kind === 'dropped' ? C.fg3 : e.kind === 'decision' ? C.accent : C.green }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ textDecoration: e.kind === 'dropped' ? 'line-through' : 'none',
                  color: e.kind === 'dropped' ? C.fg2 : C.fg }}>{e.text}</span>
                {e.when && <span style={{ color: C.fg3, fontSize: 10, whiteSpace: 'nowrap' }}>{formatAgo(e.when)}</span>}
              </div>
              {e.why && <div style={{ color: C.fg3, fontSize: 11.5, marginTop: 2 }}>{e.why}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
