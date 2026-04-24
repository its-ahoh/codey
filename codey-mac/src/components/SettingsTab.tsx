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
interface FallbackCfg { enabled: boolean; order: string[] }

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

  useEffect(() => { setDraft(entry) }, [entry])

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

// ── Fallback reorderer (simple up/down controls — drag-free) ────────

const FallbackList: React.FC<{
  order: string[]
  onChange: (next: string[]) => void
}> = ({ order, onChange }) => {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= order.length) return
    const next = order.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {order.map((a, i) => (
        <div key={a} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '10px 14px',
        }}>
          <div style={{ color: C.fg, fontSize: 13 }}>
            <span style={{ color: C.fg3, marginRight: 8 }}>{i + 1}.</span>{a}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...pillButton('ghost'), opacity: i === 0 ? 0.4 : 1 }}>↑</button>
            <button onClick={() => move(i, +1)} disabled={i === order.length - 1} style={{ ...pillButton('ghost'), opacity: i === order.length - 1 ? 0.4 : 1 }}>↓</button>
          </div>
        </div>
      ))}
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
  // Ensure fallback.order is coherent with enabled agents
  const liveOrder = fallback.order.length
    ? fallback.order.filter(a => enabledAgents.includes(a as any))
      .concat(enabledAgents.filter(a => !fallback.order.includes(a)))
    : enabledAgents.slice()

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
      {models.map(m => <ModelRow key={m.model} entry={m} onSave={saveModel} onDelete={deleteModel}/>)}

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
              {models.map(m => (
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
            When an agent fails, the gateway tries these agents in order.
          </div>
          <FallbackList
            order={liveOrder}
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
