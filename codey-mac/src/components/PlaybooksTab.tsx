import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import { timelineRows, playbookActions, relativeTime, TimelineRow } from './playbooksModel'
import { UIIcon } from './UIIcons'
import { matchesToolSearch } from './tools-search'

interface Summary {
  /** Owning workspace — the list spans all of them, and names collide across
   *  workspaces, so every row and every action is keyed by (workspace, name). */
  workspace: string
  workingDir: string
  name: string
  description: string
  version: number
  useCount: number
  lastUsedAt: number
  archived: boolean
  promotedToSkill: boolean
  successSignals: { cleanRuns: number; corrections: number }
  canRollback: boolean
}

interface Detail {
  name: string
  description: string
  whenToUse: string
  steps: string
  version: number
}

const rowKey = (s: { workspace: string; name: string }) => `${s.workspace}/${s.name}`

export const PlaybooksTab: React.FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const [playbooks, setPlaybooks] = useState<Summary[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [trail, setTrail] = useState<TimelineRow[]>([])
  const [openSteps, setOpenSteps] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const filteredPlaybooks = useMemo(
    () => playbooks.filter(playbook => matchesToolSearch(
      searchQuery,
      playbook.name,
      playbook.description,
      playbook.workspace,
      playbook.workingDir,
    )),
    [playbooks, searchQuery],
  )

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPlaybooks(unwrap(await window.codey.playbooks.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggleExpand = useCallback(async (s: Summary) => {
    if (expanded === rowKey(s)) { setExpanded(null); setDetail(null); return }
    try {
      const [current, events] = await Promise.all([
        window.codey.playbooks.detail(s.workspace, s.name).then(unwrap),
        window.codey.playbooks.history(s.workspace, s.name).then(unwrap),
      ])
      setDetail(current)
      setTrail(timelineRows(events, Date.now()))
      setOpenSteps(null)
      setExpanded(rowKey(s))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [expanded])

  const renderCurrentVersion = () => detail && (
    <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: C.fg, fontSize: 13, fontWeight: 650 }}>Current version</span>
        <span style={{ color: C.accent, background: C.accentDim, borderRadius: 5, padding: '2px 6px', fontSize: 11, fontWeight: 650 }}>
          v{detail.version}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <DetailSection label="Description" content={detail.description} />
        <DetailSection label="When to use" content={detail.whenToUse} />
        <DetailSection label="Procedure" content={detail.steps} code />
      </div>
    </div>
  )

  const act = useCallback(async (kind: 'archive' | 'restore' | 'delete' | 'rollback', s: Summary) => {
    const messages = {
      archive: `Archive playbook "${s.name}"? It will stop being applied but can be restored later.`,
      restore: `Restore playbook "${s.name}"?`,
      delete: `Permanently delete playbook "${s.name}"? This removes its full history and cannot be undone.`,
      rollback: `Roll back "${s.name}" to its previous version?`,
    } as const
    if (!confirm(messages[kind])) return
    try {
      // Widen: rollback returns data: number, other mutations return void — the
      // raw union collapses unwrap's generic to void and rejects number.
      const res: { ok: true; data: unknown } | { ok: false; error: string } =
        await window.codey.playbooks[kind](s.workspace, s.name)
      unwrap(res)
      await reload()
      if (expanded === rowKey(s)) setExpanded(null) // trail is stale after a mutation
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [reload, expanded])

  const promote = useCallback(async (s: Summary) => {
    if (!confirm(`Turn "${s.name}" into a project skill? It becomes a coding skill every agent can discover, and the playbook will no longer be archived automatically.`)) return
    try {
      unwrap(await window.codey.playbooks.promote(s.workspace, s.name))
      await reload()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [reload])

  const renderTimeline = () => (
    <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12 }}>
      <div style={{ color: C.fg, fontSize: 13, fontWeight: 650, marginBottom: 10 }}>Version history</div>
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
    const isExpanded = expanded === rowKey(s)
    return (
      <div key={rowKey(s)} style={{ ...cardStyle, opacity: s.archived ? 0.72 : 1 }}>
        <div
          onClick={() => void toggleExpand(s)}
          style={{ cursor: 'pointer' }}
          title={isExpanded ? 'Hide playbook details' : 'Show playbook details'}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: C.fg, fontSize: 15, fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.name}
            </span>
            <span style={{ color: C.fg3, fontSize: 12, flexShrink: 0 }}>v{s.version}</span>
            {s.archived && (
              <span style={{
                fontSize: 10, fontWeight: 650, letterSpacing: 0.3,
                padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                background: C.surface3, color: C.fg3,
              }}>
                Archived
              </span>
            )}
            {s.promotedToSkill && (
              <span style={{
                fontSize: 10, fontWeight: 650, letterSpacing: 0.3,
                padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                background: C.accentDim, color: C.accent,
              }}>
                Skill
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-label={isExpanded ? 'Collapse playbook details' : 'Expand playbook details'}
              aria-expanded={isExpanded}
              onClick={event => { event.stopPropagation(); void toggleExpand(s) }}
              style={{ ...expandButtonStyle, transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              <UIIcon name="chevron" size={16} />
            </button>
          </div>
          {s.description && (
            <div style={{ color: C.fg2, fontSize: 13, lineHeight: '1.55', marginBottom: 8 }}>
              {s.description}
            </div>
          )}
          <div
            title={`Workspace: ${s.workspace}\nProject folder: ${s.workingDir}`}
            style={{ color: C.fg3, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, marginBottom: 8 }}
          >
            <UIIcon name="folder" size={11} />
            <span style={{ flexShrink: 0 }}>{s.workspace}</span>
            <span>·</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
              {s.workingDir}
            </span>
          </div>
          <div style={{ color: C.fg3, fontSize: 12, display: 'flex', gap: 14 }}>
            <span>used {s.useCount}×</span>
            <span>last {relativeTime(s.lastUsedAt, Date.now())}</span>
            <span title="Clean runs / corrections" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><UIIcon name="check" size={12} />{s.successSignals.cleanRuns}<UIIcon name="close" size={11} />{s.successSignals.corrections}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {actions.promote && (
              <button onClick={() => void promote(s)} style={pillButton('primary')}>Turn into skill</button>
            )}
            {actions.rollback && (
              <button onClick={() => void act('rollback', s)} style={{ ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6 }}><UIIcon name="refresh" size={14} />Roll back</button>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginLeft: 'auto' }}>
            {actions.archive && (
              <button onClick={() => void act('archive', s)} style={{ ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6 }}><UIIcon name="archive" size={14} />Archive</button>
            )}
            {actions.restore && (
              <button onClick={() => void act('restore', s)} style={pillButton('primary')}>Restore</button>
            )}
            {actions.delete && (
              <button onClick={() => void act('delete', s)} style={{ ...pillButton('danger'), display: 'inline-flex', alignItems: 'center', gap: 6 }}><UIIcon name="trash" size={14} />Delete</button>
            )}
          </div>
        </div>
        {isExpanded && (
          <>
            {renderCurrentVersion()}
            {renderTimeline()}
          </>
        )}
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
      ) : playbooks.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '36px 20px', color: C.fg3, fontSize: 13 }}>
          <div style={{ width: 52, height: 52, margin: '0 auto 12px', borderRadius: 16, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent }}><UIIcon name="archive" size={24} /></div>
          <div style={{ fontWeight: 500, color: C.fg2, marginBottom: 4 }}>No playbooks yet</div>
          <div style={{ fontSize: 12 }}>Playbooks crystallize from your repeated work patterns.</div>
        </div>
      ) : filteredPlaybooks.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '36px 20px', color: C.fg3, fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: C.fg2, marginBottom: 4 }}>No matching playbooks</div>
          <div style={{ fontSize: 12 }}>Try a different name or description keyword.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filteredPlaybooks.map(renderCard)}
        </div>
      )}
    </div>
  )
}

const DetailSection: React.FC<{ label: string; content: string; code?: boolean }> = ({ label, content, code = false }) => (
  <div>
    <div style={{ color: C.fg3, fontSize: 11, fontWeight: 650, letterSpacing: 0.2, marginBottom: 5 }}>{label}</div>
    <div style={{
      margin: 0,
      padding: code ? '10px 12px' : 0,
      borderRadius: code ? 7 : 0,
      background: code ? C.surface3 : 'transparent',
      color: C.fg2,
      fontSize: 12,
      lineHeight: '1.55',
      fontFamily: code ? 'monospace' : 'inherit',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {content || '—'}
    </div>
  </div>
)

const cardStyle: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: '16px 18px',
}

const expandButtonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  borderRadius: 8,
  border: `1px solid ${C.border2}`,
  background: C.surface3,
  color: C.fg2,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'transform 160ms ease, border-color 160ms ease, background 160ms ease',
}
