import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiService } from '../services/api'
import type { TeamConfigRaw } from '../../../packages/core/src/workspace'
import { C } from '../theme'
import { emitTeamsChanged } from './teamsChanged'

// Per-workspace teams editor. Teams are defined globally in Settings →
// Teams; this component just toggles which of those names are enabled for
// the workspace. Definitions (members, dispatch mode) are read-only here.

interface TeamSummary {
  name: string
  members: string[]
  dispatch: 'all' | 'auto' | 'parallel'
}

function summarize(raw: Record<string, TeamConfigRaw>): TeamSummary[] {
  return Object.entries(raw).map(([name, v]) => {
    if (Array.isArray(v)) return { name, members: v, dispatch: 'all' as const }
    const members = Array.isArray(v?.members) ? v.members : []
    const d = v?.dispatch
    const dispatch: TeamSummary['dispatch'] = d === 'auto' ? 'auto' : d === 'parallel' ? 'parallel' : 'all'
    return { name, members, dispatch }
  })
}

export default function TeamsSection({ workspace }: { workspace: string }) {
  const [library, setLibrary] = useState<TeamSummary[]>([])
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [savedAt, setSavedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<number | null>(null)

  const reload = useCallback(async () => {
    const [lib, names] = await Promise.all([
      apiService.getGlobalTeams(),
      apiService.getTeams(workspace),
    ])
    setLibrary(summarize(lib))
    setEnabled(new Set(names))
  }, [workspace])

  useEffect(() => { reload() }, [reload])

  const queueSave = (next: Set<string>) => {
    setEnabled(next); setError(null)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      try { await apiService.setTeams(workspace, [...next]); setSavedAt(Date.now()); emitTeamsChanged() }
      catch (err: any) { setError(err.message || String(err)) }
    }, 300)
  }

  const toggle = (name: string) => {
    const next = new Set(enabled)
    if (next.has(name)) next.delete(name); else next.add(name)
    queueSave(next)
  }

  // Names enabled here but no longer present in the global library — surface
  // them so the user knows why a previously-working team disappeared.
  const orphans = useMemo(() => {
    const libNames = new Set(library.map(t => t.name))
    return [...enabled].filter(n => !libNames.has(n))
  }, [enabled, library])

  return (
    <div style={{ marginTop: 24, padding: 16, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Teams</div>
        {savedAt > 0 && Date.now() - savedAt < 2000 && <span style={{ fontSize: 11, color: C.green }}>✓ Saved</span>}
      </div>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 10 }}>
        Pick which global teams to enable for this workspace. Edit definitions under Settings → Teams.
      </div>
      {error && <div style={{ background: C.dangerBg, color: C.dangerFg, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {library.length === 0 && (
        <div style={{ fontSize: 12, color: C.fg3 }}>
          No global teams defined yet. Go to Settings → Teams to create one.
        </div>
      )}
      {library.map(t => {
        const on = enabled.has(t.name)
        return (
          <label key={t.name}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', marginBottom: 6,
              background: C.bg, border: `1px solid ${on ? C.accent : C.border}`,
              borderRadius: 6, cursor: 'pointer',
            }}>
            <input type="checkbox" checked={on} onChange={() => toggle(t.name)} style={{ cursor: 'pointer' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {t.name}
                <span style={{ marginLeft: 8, color: C.fg3, fontWeight: 400, fontSize: 11 }}>
                  {t.dispatch === 'parallel' ? '[parallel]' : t.dispatch === 'auto' ? '[auto]' : '[sequential]'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: C.fg3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t.members.length === 0 ? 'no members' : t.members.join(' → ')}
              </div>
            </div>
          </label>
        )
      })}
      {orphans.length > 0 && (
        <div style={{ marginTop: 10, padding: 8, background: C.dangerBg, color: C.dangerFg, borderRadius: 6, fontSize: 12 }}>
          Enabled team{orphans.length > 1 ? 's' : ''} missing from the global library: {orphans.join(', ')}.
          <button onClick={() => {
              const next = new Set(enabled)
              for (const n of orphans) next.delete(n)
              queueSave(next)
            }}
            style={{ marginLeft: 8, background: 'transparent', color: C.dangerFg, border: `1px solid ${C.dangerBorder}`, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>
            Remove
          </button>
        </div>
      )}
    </div>
  )
}
