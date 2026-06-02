import { useEffect, useState, useCallback, useRef } from 'react'
import { apiService, WorkerDto } from '../services/api'
import type { TeamConfigRaw } from '../../../packages/core/src/workspace'
import { C } from '../theme'

// Mirrors TeamsSection's editor, but operates on the global team library
// stored in gateway.json. Workspaces opt into these teams by name.

type DispatchMode = 'all' | 'auto' | 'parallel'
interface TeamState { members: string[]; dispatch: DispatchMode }
type TeamsState = Record<string, TeamState>

function fromRaw(raw: TeamConfigRaw): TeamState {
  if (Array.isArray(raw)) return { members: raw, dispatch: 'all' }
  const d = raw?.dispatch
  const dispatch: DispatchMode = d === 'auto' ? 'auto' : d === 'parallel' ? 'parallel' : 'all'
  return { members: Array.isArray(raw?.members) ? raw.members : [], dispatch }
}

function toRaw(t: TeamState): TeamConfigRaw {
  if (t.dispatch === 'all') return t.members
  return { members: t.members, dispatch: t.dispatch }
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
      try { await apiService.setGlobalTeams(denormalizeAll(next)); setSavedAt(Date.now()) }
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
        Teams defined here are available to every workspace. Each workspace opts in by enabling the names it wants under Workspaces &rarr; Teams.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginBottom: 8 }}>
        {savedAt > 0 && Date.now() - savedAt < 2000 && <span style={{ fontSize: 11, color: C.green }}>✓ Saved</span>}
        <button onClick={addTeam} style={{ padding: '4px 10px', fontSize: 12, background: 'transparent', color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 6, cursor: 'pointer' }}>+ New team</button>
      </div>
      {error && <div style={{ background: C.dangerBg, color: C.dangerFg, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {Object.keys(teams).length === 0 && <div style={{ fontSize: 12, color: C.fg3 }}>No teams yet. Click &quot;+ New team&quot;.</div>}
      {Object.entries(teams).map(([name, team]) => (
        <div key={name} style={{ marginBottom: 12, padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input defaultValue={name} onBlur={e => renameTeam(name, e.target.value.trim())}
              style={{ flex: 1, background: 'transparent', color: C.fg, border: 'none', fontSize: 14, fontWeight: 600 }} />
            <select
              value={team.dispatch}
              onChange={e => setDispatch(name, e.target.value as DispatchMode)}
              title="Sequential: members run in order, output passed forward. Auto: the advisor picks the relevant subset. Parallel: all members discuss concurrently as a Manager-moderated roundtable."
              style={{
                background: C.surface2, color: C.fg, border: `1px solid ${C.border}`,
                borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer',
              }}
            >
              <option value="all">Sequential</option>
              <option value="auto">Auto</option>
              <option value="parallel">Parallel</option>
            </select>
            <button onClick={() => removeTeam(name)} style={{ background: 'transparent', color: C.dangerFg, border: 'none', cursor: 'pointer', fontSize: 12 }}>Delete</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {team.members.map((m, i) => {
              const isDragging = drag?.team === name && drag.idx === i
              const isOver = dragOver?.team === name && dragOver.idx === i && !isDragging
              return (
                <span
                  key={`${m}-${i}`}
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
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px',
                    background: C.surface2, borderRadius: 14, fontSize: 12,
                    cursor: 'grab', opacity: isDragging ? 0.4 : 1,
                    border: isOver ? `1px solid ${C.accent}` : '1px solid transparent',
                  }}
                >
                  <span style={{ color: C.fg3, cursor: 'grab' }}>⋮⋮</span>
                  {m}
                  <button onClick={() => removeMember(name, i)} style={{ background: 'transparent', color: C.fg3, border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
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
              style={{ background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12 }}>
              <option value="">+ add worker</option>
              {available(name).map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              <option value="__create__">+ Create new worker…</option>
            </select>
          </div>
        </div>
      ))}
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
    </div>
  )
}
