import React, { useState, useEffect, useCallback } from 'react'
import { apiService } from '../services/api'
import { C } from '../theme'
import { sectionStyle, fieldStyle, inputStyle, selectStyle, pillButton, Section, unwrap } from './settingsAtoms'

interface SettingsTabProps {
  isGatewayRunning: boolean
}

type ApiType = 'anthropic' | 'openai'
interface ApiKeyEntry { name: string; apiKey: string; anthropicBaseUrl?: string; openaiBaseUrl?: string }
interface ModelEntry {
  apiType: ApiType
  model: string
  apiKeyRef?: string
  provider?: string
}
interface AgentSlot { enabled?: boolean }
interface FallbackEntry { agent: string; model?: string }
interface FallbackCfg { enabled: boolean; order: FallbackEntry[] }
// Each agent expects a specific apiType — surfacing this in the UI keeps users
// from picking a model the agent's CLI cannot actually authenticate against.
export const AGENT_API_TYPE: Record<string, ApiType> = {
  'claude-code': 'anthropic',
  'opencode': 'openai',
  'codex': 'openai',
}
export const AGENT_NAMES = ['claude-code', 'opencode', 'codex'] as const

// Where the user goes to install each agent's CLI when it isn't on PATH.
// Picked to land on the official quickstart / install page rather than a
// generic homepage so the next click is "run this command".
export const AGENT_INSTALL_URL: Record<string, string> = {
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/quickstart',
  'opencode':    'https://opencode.ai',
  'codex':       'https://github.com/openai/codex',
}

// ── Small helpers ────────────────────────────────────────────────────

// One of three states: probe in flight, installed, not installed. We render
// the green pill with the resolved path as a tooltip so power users can see
// *which* binary the gateway will spawn (helpful when a stale node version
// is on PATH).
export const AgentInstallChip: React.FC<{
  status?: { installed: boolean; path?: string }
  checking: boolean
  onInstall: () => void
}> = ({ status, checking, onInstall }) => {
  if (!status) {
    return (
      <span style={{ color: C.fg3, fontSize: 11, fontStyle: 'italic' }}>
        {checking ? 'checking…' : ''}
      </span>
    )
  }
  if (status.installed) {
    return (
      <span
        title={status.path ? `Found at ${status.path}` : undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          color: C.green, fontSize: 11, fontWeight: 600,
          padding: '3px 8px', borderRadius: 999,
          background: 'rgba(52,199,89,0.12)',
          border: '1px solid rgba(52,199,89,0.35)',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 3, background: C.green }}/>
        Installed
      </span>
    )
  }
  return (
    <button
      onClick={onInstall}
      style={{
        ...pillButton('ghost'),
        color: C.warningFg,
        background: 'rgba(255,159,10,0.12)',
        border: '1px solid rgba(255,159,10,0.35)',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
      title="Open the install instructions in your browser"
    >
      Install ↗
    </button>
  )
}

// ── Per-agent env-var editor ─────────────────────────────────────────
// Renders a tiny KEY=VALUE list with add/remove. Edits are debounced upward
// via `onChange(nextRecord)` so the parent can persist with a single IPC call.
// Empty key rows are filtered out before save — lets the user clear a row.
export const EnvEditor: React.FC<{
  env: Record<string, string>
  onChange: (next: Record<string, string>) => void | Promise<void>
}> = ({ env, onChange }) => {
  // Local draft state preserves row order while the user is editing — using
  // the parent's record directly would re-sort on every keystroke because
  // object key order isn't stable across rebuilds.
  const [draft, setDraft] = React.useState<Array<{ k: string; v: string }>>(() =>
    Object.entries(env).map(([k, v]) => ({ k, v }))
  )
  // Resync when the parent's env actually changes (e.g. on reload), without
  // wiping in-flight edits when our own commit echoes back.
  React.useEffect(() => {
    const current = Object.fromEntries(
      draft.filter(r => r.k.trim().length > 0).map(r => [r.k.trim(), r.v])
    )
    const isSame = JSON.stringify(current) === JSON.stringify(env)
    if (!isSame) setDraft(Object.entries(env).map(([k, v]) => ({ k, v })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(env)])

  const commit = (rows: Array<{ k: string; v: string }>) => {
    const next: Record<string, string> = {}
    for (const r of rows) {
      const k = r.k.trim()
      if (k) next[k] = r.v
    }
    void onChange(next)
  }

  const updateRow = (idx: number, patch: Partial<{ k: string; v: string }>) => {
    const next = draft.map((r, i) => i === idx ? { ...r, ...patch } : r)
    setDraft(next)
    commit(next)
  }
  const removeRow = (idx: number) => {
    const next = draft.filter((_, i) => i !== idx)
    setDraft(next)
    commit(next)
  }
  const addRow = () => setDraft([...draft, { k: '', v: '' }])

  return (
    <div style={{ marginTop: 8, paddingLeft: 0 }}>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 4 }}>
        Environment variables (passed to the spawned CLI)
      </div>
      {draft.length === 0 && (
        <div style={{ color: C.fg3, fontSize: 11, fontStyle: 'italic', marginBottom: 6 }}>
          No custom env vars.
        </div>
      )}
      {draft.map((row, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input
            value={row.k}
            onChange={e => updateRow(idx, { k: e.target.value })}
            placeholder="KEY"
            spellCheck={false}
            style={{ ...inputStyle, flex: '0 0 180px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          />
          <input
            value={row.v}
            onChange={e => updateRow(idx, { v: e.target.value })}
            placeholder="value"
            spellCheck={false}
            style={{ ...inputStyle, flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          />
          <button
            onClick={() => removeRow(idx)}
            style={{ ...pillButton('ghost'), color: C.red }}
            title="Remove"
          >✕</button>
        </div>
      ))}
      <button onClick={addRow} style={pillButton('ghost')}>+ Add variable</button>
    </div>
  )
}

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
  apis: ApiKeyEntry[]
  isNew?: boolean
  onSave: (draft: ModelEntry, previousId: string) => Promise<void>
  onDelete?: (modelId: string) => Promise<void>
  onCancel?: () => void
}> = ({ entry, apis, isNew, onSave, onDelete, onCancel }) => {
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
          {entry.apiKeyRef && (
            <div style={{
              color: C.fg3,
              fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              🔑 {entry.apiKeyRef}
            </div>
          )}
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
        <select value={draft.apiType} onChange={e => {
          setDraft({ ...draft, apiType: e.target.value as ApiType })
        }}
          style={{ ...selectStyle, width: '100%' }}>
          <option value="anthropic">anthropic (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)</option>
          <option value="openai">openai (OPENAI_BASE_URL + OPENAI_API_KEY)</option>
        </select>
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <select
          value={draft.apiKeyRef ?? ''}
          onChange={e => setDraft({ ...draft, apiKeyRef: e.target.value || undefined })}
          style={{ ...selectStyle, width: '100%' }}
        >
          <option value="">(use default — env vars)</option>
          {[...apis].sort((a, b) => a.name.localeCompare(b.name)).map(a => (
            <option key={a.name} value={a.name}>{a.name}</option>
          ))}
        </select>
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
  onChange: (next: FallbackEntry[]) => void
}> = ({ order, models, enabledAgents, onChange }) => {
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
              <span style={{
                color: i === 0 ? C.accent : C.fg3,
                fontSize: 11, fontWeight: i === 0 ? 600 : 400,
                width: 56, letterSpacing: 0.3,
              }}>{i === 0 ? 'DEFAULT' : `Step ${i + 1}`}</span>
              <select
                value={entry.agent}
                onChange={e => update(i, { agent: e.target.value })}
                style={{ ...selectStyle, width: 130 }}
              >
                {AGENT_NAMES.map(a => (
                  <option key={a} value={a}>{a}</option>
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
              {i === 0 ? (
                <span style={{ width: 28, fontSize: 10, color: C.fg3, textAlign: 'center' }} title="The default agent — drag a row above to replace it">—</span>
              ) : (
                <button onClick={() => remove(i)} style={pillButton('danger')}>✕</button>
              )}
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

export type InstallStatus = { installed: boolean; path?: string }

export const SettingsTab: React.FC<SettingsTabProps> = ({ isGatewayRunning }) => {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [fallback, setFallback] = useState<FallbackCfg>({ enabled: true, order: [] })
  const [advisor, setAdvisor] = useState<{ agent: string; model: string }>({ agent: '', model: '' })
  const [aide, setAide] = useState<{ agent: string; model: string }>({ agent: '', model: '' })
  const [apis, setApis] = useState<ApiKeyEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [m, f, d, ai, a] = await Promise.all([
        unwrap(await window.codey.models.list()),
        unwrap(await window.codey.fallback.get()),
        unwrap(await window.codey.dispatcher.get()),
        unwrap(await window.codey.aide.get()),
        unwrap(await window.codey.apiKeys.list()),
      ])
      setModels(m); setFallback(f as FallbackCfg)
      setAdvisor({ agent: d.agent ?? '', model: d.model ?? '' })
      setAide({ agent: ai.agent ?? '', model: ai.model ?? '' })
      setApis(a as ApiKeyEntry[])
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

  const updateFallback = async (fb: FallbackCfg) => {
    setFallback(fb)
    await unwrap(await window.codey.fallback.set(fb))
  }

  const updateAdvisor = async (next: { agent: string; model: string }) => {
    setAdvisor(next)
    await unwrap(await window.codey.dispatcher.set({
      agent: next.agent || undefined,
      model: next.model || undefined,
    }))
  }

  const updateAide = async (next: { agent: string; model: string }) => {
    setAide(next)
    await unwrap(await window.codey.aide.set({
      agent: next.agent || undefined,
      model: next.model || undefined,
    }))
  }

  // Mirror the fallback editor's filter: when an agent is picked, only show
  // models compatible with its apiType. When no agent is picked, show all.
  const advisorModels = (() => {
    const want = advisor.agent ? AGENT_API_TYPE[advisor.agent] : undefined
    return [...models]
      .filter(m => !want || m.apiType === want)
      .sort((a, b) => a.model.localeCompare(b.model))
  })()

  const aideModels = (() => {
    const want = aide.agent ? AGENT_API_TYPE[aide.agent] : undefined
    return [...models]
      .filter(m => !want || m.apiType === want)
      .sort((a, b) => a.model.localeCompare(b.model))
  })()

  // Enablement is derived from priority-list membership now; the chat header
  // and fallback "+ Add step" both use this to decide what an agent looks
  // like in dropdown menus.
  const enabledAgents = AGENT_NAMES.filter(a =>
    fallback.order.some(e => e.agent === a)
  )

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section title="Models" right={
        <button onClick={() => setCreating(true)} style={pillButton('primary')} disabled={creating}>+ Add</button>
      }/>
      {creating && (
        <ModelRow
          entry={{ apiType: 'anthropic', model: '' }}
          apis={apis}
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
        .map(m => <ModelRow key={m.model} entry={m} apis={apis} onSave={saveModel} onDelete={deleteModel}/>)}

      <Section title="Agent priority" right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.fg3, fontSize: 11 }}>{fallback.enabled ? 'Enabled' : 'Disabled'}</span>
          <Toggle on={fallback.enabled} onChange={enabled => updateFallback({ ...fallback, enabled })}/>
        </div>
      }/>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        Row 1 is the default agent + model. When fallback is enabled and a request fails, the gateway tries each subsequent row in order. Drag to reorder.
      </div>
      <FallbackList
        order={fallback.order}
        models={models}
        enabledAgents={enabledAgents}
        onChange={next => updateFallback({ ...fallback, order: next })}
      />
      {!fallback.enabled && (
        <div style={{ color: C.fg3, fontSize: 11, padding: '8px 0' }}>
          Fallback is off — only Row 1 (the default) will run. Failures surface as errors instead of trying the rest of the list.
        </div>
      )}

      <Section title="Advisor"/>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        The advisor is the routing/orchestration model: it runs the <code>/team</code> manager and picks workers for Auto-mode teams. Set a stronger model (e.g. Opus) here for better routing decisions. Leave both as <em>Use default</em> to fall back to the gateway default agent + model.
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
        padding: '8px 12px',
      }}>
        <span style={{
          color: C.fg3, fontSize: 11, fontWeight: 400,
          width: 56, letterSpacing: 0.3,
        }}>ROUTER</span>
        <select
          value={advisor.agent}
          onChange={e => {
            const nextAgent = e.target.value
            // Drop the pinned model if it's not compatible with the new agent.
            const want = nextAgent ? AGENT_API_TYPE[nextAgent] : undefined
            const m = models.find(mm => mm.model === advisor.model)
            const keepModel = !advisor.model || !want || (m && m.apiType === want)
            updateAdvisor({ agent: nextAgent, model: keepModel ? advisor.model : '' })
          }}
          style={{ ...selectStyle, width: 130 }}
        >
          <option value="">Select Agent</option>
          {AGENT_NAMES.map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={advisor.model}
          onChange={e => updateAdvisor({ agent: advisor.agent, model: e.target.value })}
          style={{ ...selectStyle, flex: 1, minWidth: 0 }}
        >
          <option value="">Select Model</option>
          {advisorModels.map(m => (
            <option key={m.model} value={m.model}>{m.model} [{m.apiType}]</option>
          ))}
        </select>
      </div>

      <Section title="Aide"/>
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        The Aide is a lightweight background model for housekeeping tasks like chat summarization and title generation — it never talks to you directly. Pin a small, fast model here (e.g. Haiku) to keep these tasks cheap. Leave both as <em>Use default</em> to fall back to the gateway default.
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
        padding: '8px 12px',
      }}>
        <span style={{
          color: C.fg3, fontSize: 11, fontWeight: 400,
          width: 56, letterSpacing: 0.3,
        }}>AIDE</span>
        <select
          value={aide.agent}
          onChange={e => {
            const nextAgent = e.target.value
            const want = nextAgent ? AGENT_API_TYPE[nextAgent] : undefined
            const m = models.find(mm => mm.model === aide.model)
            const keepModel = !aide.model || !want || (m && m.apiType === want)
            updateAide({ agent: nextAgent, model: keepModel ? aide.model : '' })
          }}
          style={{ ...selectStyle, width: 130 }}
        >
          <option value="">Select Agent</option>
          {AGENT_NAMES.map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={aide.model}
          onChange={e => updateAide({ agent: aide.agent, model: e.target.value })}
          style={{ ...selectStyle, flex: 1, minWidth: 0 }}
        >
          <option value="">Select Model</option>
          {aideModels.map(m => (
            <option key={m.model} value={m.model}>{m.model} [{m.apiType}]</option>
          ))}
        </select>
      </div>
    </div>
  )
}
