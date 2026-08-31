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
  const [hovered, setHovered] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const filteredPlaybooks = useMemo(
    () => playbooks.filter(playbook => matchesToolSearch(searchQuery, playbook.name, playbook.description, playbook.workspace)),
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
    <div>
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
    const isHovered = hovered === rowKey(s)
    return (
      <div
        key={rowKey(s)}
        onMouseEnter={() => setHovered(rowKey(s))}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...cardStyle,
          opacity: s.archived ? 0.72 : 1,
          borderColor: isExpanded ? C.accent : isHovered ? C.border2 : C.border,
          boxShadow: isExpanded
            ? `0 0 0 3px ${C.accentDim}, 0 10px 28px rgba(0,0,0,0.10)`
            : isHovered ? '0 8px 22px rgba(0,0,0,0.08)' : '0 2px 8px rgba(0,0,0,0.03)',
          transform: isHovered && !isExpanded ? 'translateY(-1px)' : 'none',
        }}
      >
        <div
          onClick={() => void toggleExpand(s)}
          style={{ cursor: 'pointer', padding: '17px 18px 15px' }}
          title={isExpanded ? 'Hide playbook details' : 'Show playbook details'}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span style={playbookIconStyle}>
              <UIIcon name={s.promotedToSkill ? 'sparkle' : 'book'} size={17} strokeWidth={2} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, minHeight: 24 }}>
                <span style={{ color: C.fg, fontSize: 15, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </span>
                <span style={versionBadgeStyle}>v{s.version}</span>
                {s.archived && <span style={neutralBadgeStyle}>Archived</span>}
                {s.promotedToSkill && <span style={accentBadgeStyle}><UIIcon name="sparkle" size={10} />Skill</span>}
              </div>
              {s.description && (
                <div style={{
                  color: C.fg2, fontSize: 13, lineHeight: '1.55', marginTop: 5,
                  display: isExpanded ? 'block' : '-webkit-box', WebkitLineClamp: isExpanded ? undefined : 2,
                  WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {s.description}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={isExpanded ? 'Collapse playbook details' : 'Expand playbook details'}
              aria-expanded={isExpanded}
              onClick={event => { event.stopPropagation(); void toggleExpand(s) }}
              style={expandButtonStyle}
            >
              <span style={{ ...expandChevronStyle, transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                <UIIcon name="chevron" size={16} />
              </span>
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 13, marginLeft: 48 }}>
            <span title="Workspace this playbook belongs to" style={metaChipStyle}>
              <UIIcon name="folder" size={12} />{s.workspace}
            </span>
            <span title="Times used" style={metaChipStyle}><UIIcon name="play" size={11} />{s.useCount} uses</span>
            <span title="Last used" style={metaChipStyle}><UIIcon name="clock" size={12} />{relativeTime(s.lastUsedAt, Date.now())}</span>
            <span title="Clean runs" style={{ ...metaChipStyle, color: C.green }}><UIIcon name="check" size={12} />{s.successSignals.cleanRuns} clean</span>
            {s.successSignals.corrections > 0 && (
              <span title="Corrections" style={{ ...metaChipStyle, color: C.red }}><UIIcon name="refresh" size={11} />{s.successSignals.corrections} corrected</span>
            )}
          </div>
        </div>
        {isExpanded && (
          <div style={expandedContentStyle}>
            {renderCurrentVersion()}
            {renderTimeline()}
          </div>
        )}
        <div style={actionBarStyle}>
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
  borderRadius: 14,
  overflow: 'hidden',
  transition: 'border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease',
}

const playbookIconStyle: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center',
  flexShrink: 0, color: C.accent, background: C.accentDim,
  boxShadow: `inset 0 0 0 1px ${C.accentDim}`,
}

const versionBadgeStyle: React.CSSProperties = {
  color: C.fg3, background: C.surface3, borderRadius: 5,
  padding: '2px 6px', fontSize: 10, fontWeight: 700, flexShrink: 0,
}

const neutralBadgeStyle: React.CSSProperties = {
  ...versionBadgeStyle, letterSpacing: 0.25,
}

const accentBadgeStyle: React.CSSProperties = {
  ...versionBadgeStyle, display: 'inline-flex', alignItems: 'center', gap: 3,
  background: C.accentDim, color: C.accent, letterSpacing: 0.25,
}

const metaChipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
  padding: '4px 7px', borderRadius: 6, background: C.surface2,
  color: C.fg3, fontSize: 11, lineHeight: 1, whiteSpace: 'nowrap',
}

const expandedContentStyle: React.CSSProperties = {
  padding: '15px 18px 17px', borderTop: `1px solid ${C.border}`,
  background: C.surface2,
}

const actionBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '11px 14px', borderTop: `1px solid ${C.border}`,
  background: C.surface, minHeight: 36,
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
  transition: 'border-color 0.15s ease, background 0.15s ease',
}

// Only the chevron turns; spinning the whole button spun its border and
// background too, which read as a different animation from every other
// disclosure in the app.
const expandChevronStyle: React.CSSProperties = {
  display: 'inline-flex',
  transition: 'transform 0.15s ease',
}
