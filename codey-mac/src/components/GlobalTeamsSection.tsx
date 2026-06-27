import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react'
import { apiService, WorkerDto } from '../services/api'
import type { TeamConfigRaw } from '../../../packages/core/src/workspace'
import type { TeamGraph } from '../../../packages/core/src/team-graph'
import { C } from '../theme'
import FlowEditor from './FlowEditor'
import { emptyGraph } from './flowEditorModel'
import { emitTeamsChanged } from './teamsChanged'

// Editor for the global team library stored in gateway.json. Teams defined
// here are available to every workspace.

type DispatchMode = 'all' | 'auto' | 'parallel'
interface TeamState { members: string[]; dispatch: DispatchMode; graph?: TeamGraph }
type TeamsState = Record<string, TeamState>

const DISPATCH: { id: DispatchMode; label: string; desc: string }[] = [
  { id: 'all', label: 'Sequential', desc: 'Members run in order, each passing its output to the next.' },
  { id: 'auto', label: 'Auto', desc: 'The advisor picks the relevant subset for each task.' },
  { id: 'parallel', label: 'Parallel', desc: 'All members discuss concurrently in an advisor-moderated roundtable.' },
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
    <div style={{ marginTop: 8 }}>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        Teams defined here are available to every workspace.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginBottom: 8 }}>
        {savedAt > 0 && Date.now() - savedAt < 2000 && <span style={{ fontSize: 11, color: C.green }}>✓ Saved</span>}
        <button onClick={addTeam} style={{ padding: '4px 10px', fontSize: 12, background: 'transparent', color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 6, cursor: 'pointer' }}>+ New team</button>
      </div>
      {error && <div style={{ background: C.dangerBg, color: C.dangerFg, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {Object.keys(teams).length === 0 && <div style={{ fontSize: 12, color: C.fg3 }}>No teams yet. Click &quot;+ New team&quot;.</div>}
      {Object.entries(teams).map(([name, team]) => {
        const showOrder = team.dispatch === 'all' && !team.graph
        return (
        <div key={name} style={{ marginBottom: 12, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {/* Header: name · member count · delete */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
            <input defaultValue={name} onBlur={e => renameTeam(name, e.target.value.trim())} aria-label="Team name"
              style={{ flex: 1, background: 'transparent', color: C.fg, border: 'none', fontSize: 15, fontWeight: 700, outline: 'none' }} />
            <span style={{ fontSize: 11, color: C.fg3 }}>{team.members.length} {team.members.length === 1 ? 'member' : 'members'}</span>
            <button onClick={() => removeTeam(name)} title="Delete team"
              style={{ background: 'transparent', color: C.fg3, border: 'none', cursor: 'pointer', fontSize: 11, padding: '2px 4px' }}>Delete</button>
          </div>

          <div style={{ padding: 12 }}>
            {/* Dispatch: segmented control + description */}
            <div style={labelStyle}>Dispatch mode</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <div style={{ display: 'inline-flex', background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2, gap: 2 }}>
                {DISPATCH.map(d => {
                  const on = team.dispatch === d.id
                  return (
                    <button key={d.id} onClick={() => setDispatch(name, d.id)}
                      style={{ fontSize: 11, padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                        background: on ? C.accent : 'transparent', color: on ? C.onAccent : C.fg2, fontWeight: on ? 600 : 400 }}>
                      {d.label}
                    </button>
                  )
                })}
              </div>
              <span style={{ fontSize: 11, color: C.fg3, flex: 1, minWidth: 180 }}>{DISPATCH.find(d => d.id === team.dispatch)?.desc}</span>
            </div>

            {/* Members. Show run-order (numbers + arrows + drag) only for a plain
                Sequential team — when a flow graph exists it defines the order,
                so the linear numbering would just be misleading. */}
            <div style={labelStyle}>
              {showOrder
                ? <>Run order <span style={{ textTransform: 'none', letterSpacing: 0, color: C.fg3 }}>· drag to reorder</span></>
                : 'Members'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: showOrder ? 4 : 6, alignItems: 'center' }}>
              {team.members.length === 0 && <span style={{ fontSize: 12, color: C.fg3 }}>No members yet —</span>}
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
                        display: 'inline-flex', alignItems: 'center', gap: 6, padding: showOrder ? '4px 8px 4px 5px' : '4px 8px 4px 6px',
                        background: C.surface2, borderRadius: 14, fontSize: 12,
                        cursor: 'grab', opacity: isDragging ? 0.4 : 1,
                        border: isOver ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
                      }}
                    >
                      <span style={{ color: C.fg3, cursor: 'grab', fontSize: 10 }}>⋮⋮</span>
                      {showOrder && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 9, background: C.accent, color: C.onAccent, fontSize: 10, fontWeight: 700 }}>{i + 1}</span>
                      )}
                      <span>{m}</span>
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
                style={{ background: 'transparent', color: C.accent, border: `1px dashed ${C.accent}`, borderRadius: 14, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>
                <option value="">+ add worker</option>
                {available(name).map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
                <option value="__create__">+ Create new worker…</option>
              </select>
            </div>

            {/* Flow (Sequential only) */}
            {team.dispatch === 'all' && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: C.fg3 }}>Workflow</span>
                <button onClick={() => setEditingFlow(name)}
                  style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                    background: team.graph ? C.accent : 'transparent', color: team.graph ? C.onAccent : C.accent, border: `1px solid ${C.accent}` }}>
                  {team.graph ? '✎ Edit workflow' : '+ Add workflow'}
                </button>
                {team.graph
                  ? <span style={{ fontSize: 11, color: C.fg3 }}>{team.graph.nodes.filter(n => n.type === 'worker').length} worker nodes wired</span>
                  : <span style={{ fontSize: 11, color: C.fg3 }}>Optional — branch &amp; loop between members on a workflow canvas.</span>}
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
