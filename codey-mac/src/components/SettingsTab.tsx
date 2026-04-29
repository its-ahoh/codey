import React, { useState, useEffect, useCallback } from 'react'
import { apiService } from '../services/api'
import { C } from '../theme'

interface SettingsTabProps {
  isGatewayRunning: boolean
}

type ApiType = 'anthropic' | 'openai'
interface ModelEntry {
  apiType: ApiType
  model: string
  baseUrl?: string
  apiKey?: string
  provider?: string
}
interface AgentSlot { enabled?: boolean; defaultModel?: string }
interface FallbackEntry { agent: string; model?: string }
interface FallbackCfg { enabled: boolean; order: FallbackEntry[] }

// Each agent expects a specific apiType — surfacing this in the UI keeps users
// from picking a model the agent's CLI cannot actually authenticate against.
const AGENT_API_TYPE: Record<string, ApiType> = {
  'claude-code': 'anthropic',
  'opencode': 'openai',
  'codex': 'openai',
}
const AGENT_NAMES = ['claude-code', 'opencode', 'codex'] as const

// ── Shared style atoms ───────────────────────────────────────────────

const sectionStyle: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase', marginTop: 22, marginBottom: 8,
}
const fieldStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 0', borderBottom: `1px solid ${C.border}`,
}
const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? '#FF453A22' : C.surface3,
  color: variant === 'primary' ? '#fff' : variant === 'danger' ? C.red : C.fg2,
})

// ── Small helpers ────────────────────────────────────────────────────

const Section: React.FC<{ title: string; right?: React.ReactNode }> = ({ title, right }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...sectionStyle }}>
    <span>{title}</span>
    {right}
  </div>
)

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <div onClick={() => onChange(!on)} style={{
    width: 36, height: 20, borderRadius: 10, flexShrink: 0,
    background: on ? C.accent : C.surface3,
    border: `1px solid ${on ? C.accent : C.border2}`,
    cursor: 'pointer', position: 'relative', transition: 'all 0.2s',
  }}>
    <div style={{
      position: 'absolute', top: 1, left: on ? 17 : 1,
      width: 16, height: 16, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    }}/>
  </div>
)

// ── Model row (view + edit) ─────────────────────────────────────────

const ModelRow: React.FC<{
  entry: ModelEntry
  isNew?: boolean
  onSave: (draft: ModelEntry, previousId: string) => Promise<void>
  onDelete?: (modelId: string) => Promise<void>
  onCancel?: () => void
}> = ({ entry, isNew, onSave, onDelete, onCancel }) => {
  const [editing, setEditing] = useState(!!isNew)
  const [draft, setDraft] = useState<ModelEntry>(entry)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Only sync from props when we're not actively editing — otherwise a parent
  // re-render (e.g. status poll) that re-creates the `entry` object literal
  // would wipe in-flight keystrokes. Key on `entry.model` so identity churn
  // alone doesn't trigger a reset.
  useEffect(() => { if (!editing) setDraft(entry) }, [entry.model, editing])

  const save = async () => {
    if (!draft.model.trim()) return
    setBusy(true)
    setErr(null)
    try { await onSave(draft, entry.model); setEditing(false) }
    catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }

  if (!editing) {
    return (
      <div style={{
        padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`,
        background: C.surface2, marginBottom: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {entry.model} <span style={{ color: C.fg3, fontWeight: 400, fontSize: 11, marginLeft: 6 }}>[{entry.apiType}]</span>
          </div>
          <div style={{ color: C.fg3, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.baseUrl || '(default url)'}{entry.apiKey ? ' · 🔑' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => setEditing(true)} style={pillButton('ghost')}>Edit</button>
          {onDelete && <button onClick={() => onDelete(entry.model)} style={pillButton('danger')}>Delete</button>}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: 12, borderRadius: 10, border: `1px solid ${C.border2}`,
      background: C.surface2, marginBottom: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8, alignItems: 'center' }}>
        <label style={{ color: C.fg3, fontSize: 12 }}>Model ID</label>
        <input value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })}
          placeholder="e.g. claude-sonnet-4-5" style={{ ...inputStyle, width: '100%' }}/>
        <label style={{ color: C.fg3, fontSize: 12 }}>API Type</label>
        <select value={draft.apiType} onChange={e => setDraft({ ...draft, apiType: e.target.value as ApiType })}
          style={{ ...selectStyle, width: '100%' }}>
          <option value="anthropic">anthropic (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)</option>
          <option value="openai">openai (OPENAI_BASE_URL + OPENAI_API_KEY)</option>
        </select>
        <label style={{ color: C.fg3, fontSize: 12 }}>Base URL</label>
        <input value={draft.baseUrl ?? ''} onChange={e => setDraft({ ...draft, baseUrl: e.target.value || undefined })}
          placeholder="(optional) override endpoint" style={{ ...inputStyle, width: '100%' }}/>
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <input type="password" value={draft.apiKey ?? ''} onChange={e => setDraft({ ...draft, apiKey: e.target.value || undefined })}
          placeholder="(optional) credentials" style={{ ...inputStyle, width: '100%' }}/>
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        <button onClick={() => { setEditing(false); setDraft(entry); setErr(null); onCancel?.() }} style={pillButton('ghost')} disabled={busy}>Cancel</button>
        <button onClick={save} style={pillButton('primary')} disabled={busy || !draft.model.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Fallback chain editor (agent + optional model per step) ─────────

const FallbackList: React.FC<{
  order: FallbackEntry[]
  models: ModelEntry[]
  enabledAgents: string[]
  disabledAgents: string[]
  onChange: (next: FallbackEntry[]) => void
}> = ({ order, models, enabledAgents, disabledAgents, onChange }) => {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= order.length || to > order.length) return
    const next = order.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to > from ? to - 1 : to, 0, moved)
    onChange(next)
  }
  const remove = (i: number) => onChange(order.filter((_, idx) => idx !== i))
  const update = (i: number, patch: Partial<FallbackEntry>) => {
    const next = order.slice()
    next[i] = { ...next[i], ...patch }
    // Switching agents may invalidate the pinned model — clear it when the
    // apiType no longer matches so we don't ship an unusable combo.
    if (patch.agent && next[i].model) {
      const m = models.find(mm => mm.model === next[i].model)
      if (m && AGENT_API_TYPE[next[i].agent] && m.apiType !== AGENT_API_TYPE[next[i].agent]) {
        next[i] = { agent: next[i].agent }
      }
    }
    onChange(next)
  }
  const add = () => {
    const agent = enabledAgents[0] ?? 'claude-code'
    onChange([...order, { agent }])
  }

  const modelsForAgent = (agent: string) => {
    const want = AGENT_API_TYPE[agent]
    return [...models]
      .filter(m => !want || m.apiType === want)
      .sort((a, b) => a.model.localeCompare(b.model))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {order.length === 0 && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '6px 0' }}>
          No fallback steps. Add one to build a chain.
        </div>
      )}
      {order.map((entry, i) => {
        const isDragging = dragIdx === i
        const showInsertAbove = dropIdx === i && dragIdx !== null && dragIdx !== i && dragIdx !== i - 1
        const isDisabled = disabledAgents.includes(entry.agent)
        return (
          <React.Fragment key={i}>
            {showInsertAbove && <div style={{ height: 2, background: C.accent, borderRadius: 1 }}/>}
            <div
              draggable
              onDragStart={e => {
                setDragIdx(i)
                e.dataTransfer.effectAllowed = 'move'
                // Firefox needs setData to start a drag; value is unused.
                e.dataTransfer.setData('text/plain', String(i))
              }}
              onDragOver={e => {
                if (dragIdx === null) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                const before = e.clientY < rect.top + rect.height / 2
                setDropIdx(before ? i : i + 1)
              }}
              onDragEnd={() => { setDragIdx(null); setDropIdx(null) }}
              onDrop={e => {
                e.preventDefault()
                if (dragIdx !== null && dropIdx !== null) reorder(dragIdx, dropIdx)
                setDragIdx(null); setDropIdx(null)
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: C.surface2, border: `1px solid ${isDragging ? C.accent : C.border}`, borderRadius: 8,
                padding: '8px 12px',
                opacity: isDragging ? 0.4 : 1,
                cursor: 'grab',
              }}
            >
              <span style={{ color: C.fg3, fontSize: 14, cursor: 'grab', userSelect: 'none' }} title="Drag to reorder">⋮⋮</span>
              <span style={{ color: C.fg3, fontSize: 12, width: 18 }}>{i + 1}.</span>
              <select
                value={entry.agent}
                onChange={e => update(i, { agent: e.target.value })}
                style={{ ...selectStyle, width: 130 }}
              >
                {AGENT_NAMES.map(a => (
                  <option key={a} value={a}>{a}{disabledAgents.includes(a) ? ' (off)' : ''}</option>
                ))}
              </select>
              <select
                value={entry.model ?? ''}
                onChange={e => update(i, { model: e.target.value || undefined })}
                style={{ ...selectStyle, flex: 1, minWidth: 0 }}
              >
                <option value="">(default)</option>
                {modelsForAgent(entry.agent).map(m => (
                  <option key={m.model} value={m.model}>{m.model} [{m.apiType}]</option>
                ))}
              </select>
              {isDisabled && (
                <span style={{ color: C.fg3, fontSize: 10 }} title="This agent is disabled and will be skipped">skipped</span>
              )}
              <button onClick={() => remove(i)} style={pillButton('danger')}>✕</button>
            </div>
            {dropIdx === order.length && i === order.length - 1 && dragIdx !== null && dragIdx !== i && (
              <div style={{ height: 2, background: C.accent, borderRadius: 1 }}/>
            )}
          </React.Fragment>
        )
      })}
      <div>
        <button onClick={add} style={pillButton('ghost')}>+ Add step</button>
      </div>
    </div>
  )
}

// ── Main Settings tab ────────────────────────────────────────────────

export const SettingsTab: React.FC<SettingsTabProps> = ({ isGatewayRunning }) => {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [agents, setAgents] = useState<Record<string, AgentSlot>>({})
  const [fallback, setFallback] = useState<FallbackCfg>({ enabled: true, order: [] })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [m, a, f] = await Promise.all([
        unwrap(await window.codey.models.list()),
        unwrap(await window.codey.agents.get()),
        unwrap(await window.codey.fallback.get()),
      ])
      setModels(m); setAgents(a as any); setFallback(f as FallbackCfg)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])

  if (!isGatewayRunning) {
    return (
      <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  const saveModel = async (entry: ModelEntry, previousId: string) => {
    // Rename first so agent references update atomically, then upsert
    // the rest of the entry's fields.
    if (previousId && previousId !== entry.model) {
      await unwrap(await window.codey.models.rename(previousId, entry.model))
    }
    await unwrap(await window.codey.models.save(entry))
    await reload()
    setCreating(false)
  }
  const deleteModel = async (modelId: string) => {
    if (!confirm(`Delete model "${modelId}"?`)) return
    await unwrap(await window.codey.models.delete(modelId))
    await reload()
  }

  const updateAgent = async (agent: string, patch: AgentSlot) => {
    const next = { ...agents, [agent]: { ...(agents[agent] ?? {}), ...patch } }
    setAgents(next)
    await unwrap(await window.codey.agents.set({ [agent]: next[agent] }))
  }

  const updateFallback = async (fb: FallbackCfg) => {
    setFallback(fb)
    await unwrap(await window.codey.fallback.set(fb))
  }

  const enabledAgents = AGENT_NAMES.filter(a => agents[a]?.enabled !== false)

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: '#FF453A22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section title="Models" right={
        <button onClick={() => setCreating(true)} style={pillButton('primary')} disabled={creating}>+ Add</button>
      }/>
      {creating && (
        <ModelRow
          entry={{ apiType: 'anthropic', model: '', baseUrl: '', apiKey: '' }}
          isNew
          onSave={saveModel}
          onCancel={() => setCreating(false)}
        />
      )}
      {models.length === 0 && !creating && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '16px 0' }}>No models yet. Click + Add to create one.</div>
      )}
      {[...models]
        .sort((a, b) => a.apiType.localeCompare(b.apiType) || a.model.localeCompare(b.model))
        .map(m => <ModelRow key={m.model} entry={m} onSave={saveModel} onDelete={deleteModel}/>)}

      <Section title="Agents"/>
      {AGENT_NAMES.map(a => (
        <div key={a} style={fieldStyle}>
          <span style={{ color: C.fg, fontSize: 13 }}>{a}</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <select
              value={agents[a]?.defaultModel ?? ''}
              onChange={e => updateAgent(a, { defaultModel: e.target.value })}
              style={{ ...selectStyle, width: 220 }}
              disabled={agents[a]?.enabled === false || models.length === 0}
            >
              <option value="">(default)</option>
              {[...models]
                .sort((a, b) => a.apiType.localeCompare(b.apiType) || a.model.localeCompare(b.model))
                .map(m => (
                  <option key={m.model} value={m.model}>{m.model} [{m.apiType}]</option>
                ))}
            </select>
            <Toggle on={agents[a]?.enabled !== false} onChange={v => updateAgent(a, { enabled: v })}/>
          </div>
        </div>
      ))}

      <Section title="Fallback" right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.fg3, fontSize: 11 }}>{fallback.enabled ? 'Enabled' : 'Disabled'}</span>
          <Toggle on={fallback.enabled} onChange={enabled => updateFallback({ ...fallback, enabled })}/>
        </div>
      }/>
      {fallback.enabled ? (
        <>
          <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
            When a request fails, the gateway tries each step in order. Pin a specific model to retry the same agent with a different model.
          </div>
          <FallbackList
            order={fallback.order}
            models={models}
            enabledAgents={enabledAgents}
            disabledAgents={AGENT_NAMES.filter(a => agents[a]?.enabled === false)}
            onChange={next => updateFallback({ ...fallback, order: next })}
          />
        </>
      ) : (
        <div style={{ color: C.fg3, fontSize: 12, padding: '8px 0' }}>
          Fallback is off. Failures surface the original error instead of trying another agent.
        </div>
      )}
    </div>
  )
}

function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (r.ok) return r.data
  throw new Error(r.error)
}
