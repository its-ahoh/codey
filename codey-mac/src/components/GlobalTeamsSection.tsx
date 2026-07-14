import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react'
import { apiService, WorkerDto } from '../services/api'
import type { TeamConfigRaw } from '../../../packages/core/src/workspace'
import type { TeamGraph } from '../../../packages/core/src/team-graph'
import { C } from '../theme'
import FlowEditor from './FlowEditor'
import { emptyGraph } from './flowEditorModel'
import { emitTeamsChanged } from './teamsChanged'
import { UIIcon } from './UIIcons'

// Editor for the global team library stored in gateway.json. Teams defined
// here are available to every workspace.

type DispatchMode = 'all' | 'auto' | 'parallel'
interface TeamState { members: string[]; dispatch: DispatchMode; graph?: TeamGraph }
type TeamsState = Record<string, TeamState>

const DISPATCH: { id: DispatchMode; label: string; desc: string; detail: string; icon: 'activity' | 'sparkle' | 'users' }[] = [
  { id: 'all', label: 'Sequential', desc: 'Best for ordered handoffs.', detail: 'Workers run in a deliberate order. Each worker receives the work produced before it, and an optional workflow can add branches or loops.', icon: 'activity' },
  { id: 'auto', label: 'Adaptive', desc: 'Best when the right specialists vary.', detail: 'The Advisor chooses the relevant workers for each task and can send work back for another pass when a revision is needed.', icon: 'sparkle' },
  { id: 'parallel', label: 'Roundtable', desc: 'Best for multiple perspectives.', detail: 'Workers contribute concurrently while the Advisor moderates the discussion, tracks shared progress, and decides when the team is done.', icon: 'users' },
]

const labelStyle: CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: C.fg3, marginBottom: 6 }

function fromRaw(raw: TeamConfigRaw): TeamState {
  if (Array.isArray(raw)) return { members: raw, dispatch: 'all' }
  const d = raw?.dispatch
  const dispatch: DispatchMode = d === 'auto' ? 'auto' : d === 'parallel' ? 'parallel' : 'all'
  return { members: Array.isArray(raw?.members) ? raw.members : [], dispatch, graph: (raw as any)?.graph }
}

function toRaw(t: TeamState): TeamConfigRaw {
  if (t.dispatch === 'all' && !t.graph) return t.members
  const out: any = { members: t.members, dispatch: t.dispatch }
  if (t.dispatch === 'all' && t.graph) out.graph = t.graph
  return out
}

function normalizeAll(raw: Record<string, TeamConfigRaw>): TeamsState {
  const out: TeamsState = {}
  for (const [k, v] of Object.entries(raw)) out[k] = fromRaw(v)
  return out
}

function denormalizeAll(state: TeamsState): Record<string, TeamConfigRaw> {
  const out: Record<string, TeamConfigRaw> = {}
  for (const [k, v] of Object.entries(state)) out[k] = toRaw(v)
  return out
}

export default function GlobalTeamsSection() {
  const [teams, setTeams] = useState<TeamsState>({})
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [savedAt, setSavedAt] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<number | null>(null)

  const reload = useCallback(async () => {
    setTeams(normalizeAll(await apiService.getGlobalTeams()))
    setWorkers(await apiService.listWorkers())
  }, [])

  useEffect(() => { reload() }, [reload])

  const queueSave = (next: TeamsState) => {
    setTeams(next); setError(null)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      try { await apiService.setGlobalTeams(denormalizeAll(next)); setSavedAt(Date.now()); emitTeamsChanged() }
      catch (err: any) { setError(err.message || String(err)) }
    }, 400)
  }

  const addTeam = () => {
    let i = 1; while (teams[`team${i}`]) i++
    queueSave({ ...teams, [`team${i}`]: { members: [], dispatch: 'all' } })
  }
  const renameTeam = (oldName: string, newName: string) => {
    if (!newName || oldName === newName || teams[newName]) return
    const next: TeamsState = {}
    for (const [k, v] of Object.entries(teams)) next[k === oldName ? newName : k] = v
    queueSave(next)
  }
  const removeTeam = (name: string) => {
    const next = { ...teams }; delete next[name]; queueSave(next)
  }
  const setDispatch = (name: string, dispatch: DispatchMode) => {
    queueSave({ ...teams, [name]: { ...teams[name], dispatch } })
  }
  const addMember = (team: string, member: string) => {
    if (teams[team].members.includes(member)) return
    queueSave({ ...teams, [team]: { ...teams[team], members: [...teams[team].members, member] } })
  }
  const removeMember = (team: string, idx: number) => {
    queueSave({ ...teams, [team]: { ...teams[team], members: teams[team].members.filter((_, i) => i !== idx) } })
  }
  const reorderMember = (team: string, from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return
    const members = [...teams[team].members]
    if (from >= members.length || to >= members.length) return
    const [moved] = members.splice(from, 1)
    members.splice(to, 0, moved)
    queueSave({ ...teams, [team]: { ...teams[team], members } })
  }
  const [drag, setDrag] = useState<{ team: string; idx: number } | null>(null)
  const [dragOver, setDragOver] = useState<{ team: string; idx: number } | null>(null)
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const [editingFlow, setEditingFlow] = useState<string | null>(null)
  const [createPrompt, setCreatePrompt] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [dispatchHelpOpen, setDispatchHelpOpen] = useState(false)

  const submitCreate = async () => {
    if (!creatingFor || !createPrompt.trim() || createBusy) return
    setCreateBusy(true); setCreateError(null)
    try {
      const worker = await apiService.generateWorker(createPrompt)
      const team = creatingFor
      const next: TeamsState = { ...teams, [team]: { ...teams[team], members: [...teams[team].members, worker.name] } }
      setWorkers(await apiService.listWorkers())
      queueSave(next)
      setCreatingFor(null); setCreatePrompt('')
    } catch (err: any) {
      setCreateError(err.message || String(err))
    } finally {
      setCreateBusy(false)
    }
  }

  const available = (team: string) => workers.filter(w => !teams[team].members.includes(w.name))

  return (
    <div>
      <div style={styles.topRow}>
        <div style={styles.libraryNote}><span style={styles.libraryDot} />Available in every workspace</div>
        <div style={styles.topActions}>
          {savedAt > 0 && Date.now() - savedAt < 2000 && <span style={styles.saved}><span>✓</span> Saved</span>}
          <button onClick={addTeam} style={styles.newTeamBtn}><UIIcon name="add" size={15} />New team</button>
        </div>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {Object.keys(teams).length === 0 && <div style={styles.empty}><span style={styles.emptyIcon}><UIIcon name="users" size={24} /></span><div style={styles.emptyTitle}>Build a specialist team</div><div style={styles.emptyText}>Add workers, choose how they collaborate, then reuse the team in any workspace.</div><button onClick={addTeam} style={{ ...styles.newTeamBtn, marginTop: 15 }}><UIIcon name="add" size={15} />Create a team</button></div>}
      {Object.entries(teams).map(([name, team]) => {
        const showOrder = team.dispatch === 'all' && !team.graph
        return (
        <div key={name} style={styles.teamCard}>
          {/* Header: name · member count · delete */}
          <div style={styles.teamHeader}>
            <span style={styles.teamAvatar}><UIIcon name="users" size={17} /></span>
            <input defaultValue={name} onBlur={e => renameTeam(name, e.target.value.trim())} aria-label="Team name"
              style={styles.teamName} />
            <span style={styles.memberCount}><UIIcon name="users" size={12} />{team.members.length}</span>
            <button onClick={() => removeTeam(name)} title="Delete team"
              style={styles.deleteBtn}><UIIcon name="trash" size={14} /></button>
          </div>

          <div style={styles.cardBody}>
            {/* Compact dispatch selector. Detailed guidance lives in one shared
                help dialog instead of being repeated in every team card. */}
            <div style={styles.dispatchLabelRow}>
              <div style={{ ...labelStyle, marginBottom: 0 }}>Dispatch mode</div>
              <button
                type="button"
                onClick={() => setDispatchHelpOpen(true)}
                aria-label="Explain dispatch modes"
                title="What is the difference?"
                style={styles.dispatchHelpBtn}
              >?</button>
            </div>
            <div style={styles.modeGrid}>
              {DISPATCH.map(d => {
                const on = team.dispatch === d.id
                return (
                  <button key={d.id} onClick={() => setDispatch(name, d.id)} style={{ ...styles.modeCard, ...(on ? styles.modeCardActive : {}) }}>
                    <span style={{ ...styles.modeIcon, color: on ? C.onAccent : C.accent, background: on ? 'rgba(255,255,255,0.16)' : C.accentDim }}><UIIcon name={d.icon} size={15} /></span>
                    <span style={{ fontWeight: 700, color: on ? C.onAccent : C.fg2 }}>{d.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Members. Show run-order (numbers + arrows + drag) only for a plain
                Sequential team — when a flow graph exists it defines the order,
                so the linear numbering would just be misleading. */}
            <div style={labelStyle}>
              {showOrder
                ? <>Run order <span style={{ textTransform: 'none', letterSpacing: 0, color: C.fg3 }}>· drag to reorder</span></>
                : 'Members'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: showOrder ? 5 : 7, alignItems: 'center' }}>
              {team.members.length === 0 && <span style={styles.memberHint}>No specialists yet</span>}
              {team.members.map((m, i) => {
                const isDragging = drag?.team === name && drag.idx === i
                const isOver = dragOver?.team === name && dragOver.idx === i && !isDragging
                return (
                  <span key={`${m}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {showOrder && i > 0 && <span style={{ color: C.fg3, fontSize: 13 }}>→</span>}
                    <span
                      draggable
                      onDragStart={e => { setDrag({ team: name, idx: i }); e.dataTransfer.effectAllowed = 'move' }}
                      onDragOver={e => {
                        if (drag?.team !== name) return
                        e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                        if (dragOver?.team !== name || dragOver.idx !== i) setDragOver({ team: name, idx: i })
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        if (drag?.team === name) reorderMember(name, drag.idx, i)
                        setDrag(null); setDragOver(null)
                      }}
                      onDragEnd={() => { setDrag(null); setDragOver(null) }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, padding: showOrder ? '5px 9px 5px 5px' : '5px 9px 5px 6px',
                        background: C.surface2, borderRadius: 16, fontSize: 12,
                        cursor: 'grab', opacity: isDragging ? 0.4 : 1,
                        border: isOver ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
                      }}
                    >
                      <span style={{ color: C.fg3, cursor: 'grab', fontSize: 10 }}>⋮⋮</span>
                      {showOrder && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 9, background: C.accent, color: C.onAccent, fontSize: 10, fontWeight: 700 }}>{i + 1}</span>
                      )}
                      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}><span>{m}</span>{workers.find(w => w.name === m)?.personality.role && <span style={{ color: C.fg3, fontSize: 9, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workers.find(w => w.name === m)?.personality.role}</span>}</span>
                      <button onClick={() => removeMember(name, i)} title="Remove" style={{ background: 'transparent', color: C.fg3, border: 'none', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
                    </span>
                  </span>
                )
              })}
              <select value="" onChange={e => {
                  const v = e.target.value
                  if (!v) return
                  if (v === '__create__') { setCreatingFor(name); setCreatePrompt(''); setCreateError(null) }
                  else addMember(name, v)
                  e.target.value = ''
                }}
                style={{ background: C.accentDim, color: C.accent, border: `1px dashed ${C.accent}`, borderRadius: 16, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>
                <option value="">+ add worker</option>
                {available(name).map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
                <option value="__create__">+ Create new worker…</option>
              </select>
            </div>

            {/* Flow (Sequential only) */}
            {team.dispatch === 'all' && (
              <div style={styles.workflowRow}>
                <span style={styles.workflowIcon}><UIIcon name="activity" size={14} /></span>
                <div style={{ flex: 1, minWidth: 0 }}><span style={styles.workflowTitle}>Workflow</span><span style={styles.workflowSub}> · {team.graph ? `${team.graph.nodes.filter(n => n.type === 'worker').length} steps` : 'Linear order'}</span></div>
                <button onClick={() => setEditingFlow(name)}
                  style={styles.workflowBtn}>
                  {team.graph ? 'Edit' : 'Customize'}<UIIcon name="chevron" size={12} />
                </button>
              </div>
            )}
          </div>
        </div>
        )
      })}
      {creatingFor && (
        <div onClick={() => !createBusy && setCreatingFor(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 520, padding: 20, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>New worker for "{creatingFor}"</div>
            <div style={{ fontSize: 12, color: C.fg3, marginBottom: 10 }}>The active coding agent will generate a personality and config from your description.</div>
            {createError && <div style={{ background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, color: C.dangerFg, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{createError}</div>}
            <textarea value={createPrompt} onChange={e => setCreatePrompt(e.target.value)} disabled={createBusy}
              placeholder="e.g. A reviewer that audits PRs for security issues, leans on Opus."
              style={{ width: '100%', minHeight: 120, padding: 10, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }} />
            <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCreatingFor(null)} disabled={createBusy}
                style={{ padding: '6px 14px', background: 'transparent', color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              <button onClick={submitCreate} disabled={createBusy || !createPrompt.trim()}
                style={{ padding: '6px 14px', background: createBusy ? C.fg3 : C.accent, color: C.onAccent, border: 'none', borderRadius: 6, cursor: createBusy ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                {createBusy ? 'Generating…' : 'Create & Add'}
              </button>
            </div>
          </div>
        </div>
      )}
      {dispatchHelpOpen && (
        <div
          onClick={() => setDispatchHelpOpen(false)}
          style={styles.modalBackdrop}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dispatch-help-title"
            onClick={e => e.stopPropagation()}
            style={styles.dispatchHelpDialog}
          >
            <div style={styles.dispatchHelpHeader}>
              <div>
                <div id="dispatch-help-title" style={styles.dispatchHelpTitle}>Dispatch modes</div>
                <div style={styles.dispatchHelpIntro}>Choose how workers collaborate on a team task.</div>
              </div>
              <button type="button" onClick={() => setDispatchHelpOpen(false)} aria-label="Close" style={styles.modalCloseBtn}><UIIcon name="close" size={15} /></button>
            </div>
            <div style={styles.dispatchHelpList}>
              {DISPATCH.map(d => (
                <div key={d.id} style={styles.dispatchHelpItem}>
                  <span style={styles.dispatchHelpIcon}><UIIcon name={d.icon} size={17} /></span>
                  <div>
                    <div style={styles.dispatchHelpMode}>{d.label}</div>
                    <div style={styles.dispatchHelpDesc}>{d.detail}</div>
                    <div style={styles.dispatchHelpBest}>{d.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {editingFlow && teams[editingFlow] && (
        <FlowEditor
          teamName={editingFlow}
          workerNames={workers.map(w => w.name)}
          workerRoles={Object.fromEntries(workers.map(w => [w.name, w.personality.role]))}
          graph={teams[editingFlow].graph ?? emptyGraph()}
          onSave={(graph) => { queueSave({ ...teams, [editingFlow]: { ...teams[editingFlow], graph } }) }}
          onClose={() => setEditingFlow(null)}
        />
      )}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  topRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 14 },
  libraryNote: { display: 'inline-flex', alignItems: 'center', gap: 7, color: C.fg3, fontSize: 11 },
  libraryDot: { width: 7, height: 7, borderRadius: '50%', background: C.green, boxShadow: `0 0 8px ${C.green}` },
  topActions: { display: 'flex', alignItems: 'center', gap: 10 },
  saved: { color: C.green, fontSize: 11, fontWeight: 650, display: 'inline-flex', gap: 4 },
  newTeamBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', fontSize: 12, fontWeight: 700, background: C.accent, color: C.onAccent, border: 'none', borderRadius: 9, cursor: 'pointer', boxShadow: `0 6px 16px ${C.accentDim}` },
  error: { background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`, padding: '10px 12px', borderRadius: 9, fontSize: 12, marginBottom: 12 },
  empty: { minHeight: 270, border: `1px dashed ${C.border2}`, borderRadius: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24 },
  emptyIcon: { width: 56, height: 56, borderRadius: 17, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent },
  emptyTitle: { color: C.fg, fontSize: 15, fontWeight: 750, marginTop: 14 },
  emptyText: { color: C.fg3, fontSize: 12, lineHeight: 1.5, maxWidth: 300, marginTop: 5 },
  teamCard: { marginBottom: 16, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 6px 18px rgba(0,0,0,0.05)' },
  teamHeader: { display: 'flex', alignItems: 'center', gap: 9, padding: '13px 15px', borderBottom: `1px solid ${C.border}`, background: C.surface2 },
  teamAvatar: { width: 32, height: 32, borderRadius: 10, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent },
  teamName: { flex: 1, background: 'transparent', color: C.fg, border: 'none', fontSize: 15, fontWeight: 750, outline: 'none' },
  memberCount: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.fg3, background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 12, padding: '4px 7px' },
  deleteBtn: { width: 28, height: 28, display: 'grid', placeItems: 'center', background: 'transparent', color: C.fg3, border: 'none', cursor: 'pointer', borderRadius: 7 },
  cardBody: { padding: 15 },
  dispatchLabelRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 },
  dispatchHelpBtn: { width: 18, height: 18, display: 'grid', placeItems: 'center', padding: 0, borderRadius: '50%', border: `1px solid ${C.border2}`, background: C.surface3, color: C.fg2, cursor: 'pointer', fontSize: 11, fontWeight: 750, lineHeight: 1 },
  modeGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 7, marginBottom: 18 },
  modeCard: { display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left', padding: '7px 9px', minHeight: 42, background: C.surface2, color: C.fg2, border: `1px solid ${C.border}`, borderRadius: 9, cursor: 'pointer', fontSize: 11 },
  modeCardActive: { background: C.accent, color: C.onAccent, borderColor: C.accent, boxShadow: `0 7px 15px ${C.accentDim}` },
  modeIcon: { width: 25, height: 25, flexShrink: 0, borderRadius: 7, display: 'grid', placeItems: 'center' },
  memberHint: { color: C.fg3, fontSize: 12, padding: '5px 2px' },
  workflowRow: { marginTop: 14, paddingTop: 11, borderTop: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 },
  workflowIcon: { width: 25, height: 25, borderRadius: 7, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent },
  workflowTitle: { color: C.fg2, fontSize: 11, fontWeight: 700 },
  workflowSub: { color: C.fg3, fontSize: 10 },
  workflowBtn: { display: 'inline-flex', alignItems: 'center', gap: 3, padding: '5px 7px', fontSize: 10, fontWeight: 680, color: C.accent, background: 'transparent', border: 'none', borderRadius: 7, cursor: 'pointer' },
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.48)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 1000 },
  dispatchHelpDialog: { width: 'min(520px, 100%)', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.28)', overflow: 'hidden' },
  dispatchHelpHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '17px 18px 14px', borderBottom: `1px solid ${C.border}` },
  dispatchHelpTitle: { color: C.fg, fontSize: 15, fontWeight: 750 },
  dispatchHelpIntro: { color: C.fg3, fontSize: 11, marginTop: 3 },
  modalCloseBtn: { width: 28, height: 28, display: 'grid', placeItems: 'center', padding: 0, background: C.surface2, color: C.fg2, border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'pointer' },
  dispatchHelpList: { display: 'flex', flexDirection: 'column', gap: 9, padding: 14 },
  dispatchHelpItem: { display: 'grid', gridTemplateColumns: '34px 1fr', gap: 10, padding: 11, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10 },
  dispatchHelpIcon: { width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 9, background: C.accentDim, color: C.accent },
  dispatchHelpMode: { color: C.fg, fontSize: 12, fontWeight: 750 },
  dispatchHelpDesc: { color: C.fg2, fontSize: 11, lineHeight: 1.45, marginTop: 3 },
  dispatchHelpBest: { color: C.accent, fontSize: 10, fontWeight: 650, marginTop: 5 },
}
