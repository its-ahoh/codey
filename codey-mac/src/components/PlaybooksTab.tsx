import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import { timelineRows, playbookActions, relativeTime, TimelineRow } from './playbooksModel'

interface Summary {
  name: string
  description: string
  version: number
  useCount: number
  lastUsedAt: number
  archived: boolean
  successSignals: { cleanRuns: number; corrections: number }
  canRollback: boolean
}

export const PlaybooksTab: React.FC = () => {
  const [skills, setSkills] = useState<Summary[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [trail, setTrail] = useState<TimelineRow[]>([])
  const [openSteps, setOpenSteps] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setSkills(unwrap(await window.codey.playbooks.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggleExpand = useCallback(async (name: string) => {
    if (expanded === name) { setExpanded(null); return }
    try {
      const events = unwrap(await window.codey.playbooks.history(name))
      setTrail(timelineRows(events, Date.now()))
      setOpenSteps(null)
      setExpanded(name)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [expanded])

  const act = useCallback(async (kind: 'forget' | 'restore' | 'rollback', name: string) => {
    const messages = {
      forget: `Archive playbook "${name}"? It stops being applied but can be restored.`,
      restore: `Restore playbook "${name}"?`,
      rollback: `Roll back "${name}" to its previous version?`,
    } as const
    if (!confirm(messages[kind])) return
    try {
      // Widen: rollback returns data: number, forget/restore data: void — the
      // raw union collapses unwrap's generic to void and rejects number.
      const res: { ok: true; data: unknown } | { ok: false; error: string } =
        await window.codey.playbooks[kind](name)
      unwrap(res)
      await reload()
      if (expanded === name) setExpanded(null) // trail is stale after a mutation
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [reload, expanded])

  const renderTimeline = () => (
    <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 10 }}>
      {trail.length === 0 ? (
        <div style={{ color: C.fg3, fontSize: 12 }}>No recorded evolution events yet.</div>
      ) : trail.map((row, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <button
              onClick={() => setOpenSteps(openSteps === i ? null : i)}
              title={openSteps === i ? 'Hide steps' : 'Show steps'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                color: C.fg2, fontSize: 12, fontWeight: 600, font: 'inherit',
              }}
            >
              {openSteps === i ? '▾' : '▸'} {row.label}
            </button>
            <span style={{ color: C.fg3, fontSize: 11 }}>{row.when}</span>
            {row.trigger && (
              <span style={{ color: C.fg3, fontSize: 11, fontStyle: 'italic', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                ← “{row.trigger}”
              </span>
            )}
          </div>
          {openSteps === i && (
            <pre style={{
              margin: '6px 0 0 14px', padding: '8px 10px', borderRadius: 6,
              background: C.surface3, color: C.fg2, fontSize: 11, lineHeight: '1.5',
              fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {row.steps}
            </pre>
          )}
        </div>
      ))}
    </div>
  )

  const renderCard = (s: Summary) => {
    const actions = playbookActions(s)
    const isExpanded = expanded === s.name
    return (
      <div key={s.name} style={{ ...cardStyle, opacity: s.archived ? 0.65 : 1 }}>
        <div
          onClick={() => void toggleExpand(s.name)}
          style={{ cursor: 'pointer' }}
          title={isExpanded ? 'Hide evolution timeline' : 'Show evolution timeline'}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: C.fg, fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.name}
            </span>
            <span style={{ color: C.fg3, fontSize: 11, flexShrink: 0 }}>v{s.version}</span>
            {s.archived && (
              <span style={{
                fontSize: 9, fontWeight: 600, letterSpacing: 0.3,
                padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                background: C.surface3, color: C.fg3,
              }}>
                Archived
              </span>
            )}
            <span style={{ flex: 1 }} />
            <span style={{ color: C.fg3, fontSize: 11, flexShrink: 0 }}>{isExpanded ? '▾' : '▸'}</span>
          </div>
          {s.description && (
            <div style={{ color: C.fg3, fontSize: 12, lineHeight: '1.5', marginBottom: 6 }}>
              {s.description}
            </div>
          )}
          <div style={{ color: C.fg3, fontSize: 11, display: 'flex', gap: 12 }}>
            <span>used {s.useCount}×</span>
            <span>last {relativeTime(s.lastUsedAt, Date.now())}</span>
            <span title="Clean runs / corrections">✓{s.successSignals.cleanRuns} ✗{s.successSignals.corrections}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {actions.forget && (
            <button onClick={() => void act('forget', s.name)} style={{ ...pillButton('ghost'), color: C.red }}>Forget</button>
          )}
          {actions.restore && (
            <button onClick={() => void act('restore', s.name)} style={pillButton('primary')}>Restore</button>
          )}
          {actions.rollback && (
            <button onClick={() => void act('rollback', s.name)} style={pillButton('ghost')}>⏪ Roll back</button>
          )}
        </div>
        {isExpanded && renderTimeline()}
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && (
        <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          {error}
        </div>
      )}
      {loading ? (
        <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>Loading…</div>
      ) : skills.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '36px 20px', color: C.fg3, fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>🧩</div>
          <div style={{ fontWeight: 500, color: C.fg2, marginBottom: 4 }}>No playbooks yet</div>
          <div style={{ fontSize: 12 }}>Playbooks crystallize from your repeated work patterns.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {skills.map(renderCard)}
        </div>
      )}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: '14px 16px',
}
