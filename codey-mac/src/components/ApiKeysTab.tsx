import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import {
  inputStyle, pillButton, Section, unwrap,
} from './settingsAtoms'

interface ApiKeyEntry { name: string; apiKey: string; anthropicBaseUrl?: string; openaiBaseUrl?: string }

interface Props { isGatewayRunning: boolean }

const ApiRow: React.FC<{
  entry: ApiKeyEntry
  isNew?: boolean
  onSave: (draft: ApiKeyEntry, previousName: string) => Promise<void>
  onDelete?: (name: string) => Promise<void>
  onCancel?: () => void
}> = ({ entry, isNew, onSave, onDelete, onCancel }) => {
  const [editing, setEditing] = useState(!!isNew)
  const [draft, setDraft] = useState<ApiKeyEntry>(entry)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (!editing) setDraft(entry) }, [entry.name, editing])

  const save = async () => {
    if (!draft.name.trim() || !draft.apiKey.trim()) return
    setBusy(true); setErr(null)
    try { await onSave(draft, entry.name); setEditing(false) }
    catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }

  if (!editing) {
    const hasAnthropicUrl = !!entry.anthropicBaseUrl
    const hasOpenaiUrl = !!entry.openaiBaseUrl
    const urlSummary = hasAnthropicUrl || hasOpenaiUrl
      ? [
          hasAnthropicUrl ? `anthropic: ${entry.anthropicBaseUrl}` : null,
          hasOpenaiUrl    ? `openai: ${entry.openaiBaseUrl}`       : null,
        ].filter(Boolean).join(' · ')
      : 'default endpoints'
    return (
      <div style={{
        padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`,
        background: C.surface2, marginBottom: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {entry.name}
          </div>
          <div style={{ color: C.fg3, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            🔑 · {urlSummary}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => setEditing(true)} style={pillButton('ghost')}>Edit</button>
          {onDelete && <button onClick={() => onDelete(entry.name)} style={pillButton('danger')}>Delete</button>}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: 12, borderRadius: 10, border: `1px solid ${C.border2}`,
      background: C.surface2, marginBottom: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'center' }}>
        <label style={{ color: C.fg3, fontSize: 12 }}>Name</label>
        <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
          placeholder="e.g. my-proxy" style={{ ...inputStyle, width: '100%' }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <input type="password" value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
          placeholder="API key" style={{ ...inputStyle, width: '100%' }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>Anthropic Base URL</label>
        <input value={draft.anthropicBaseUrl ?? ''} onChange={e => setDraft({ ...draft, anthropicBaseUrl: e.target.value || undefined })}
          placeholder="(optional) override anthropic endpoint" style={{ ...inputStyle, width: '100%' }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>OpenAI Base URL</label>
        <input value={draft.openaiBaseUrl ?? ''} onChange={e => setDraft({ ...draft, openaiBaseUrl: e.target.value || undefined })}
          placeholder="(optional) override openai endpoint" style={{ ...inputStyle, width: '100%' }} />
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        <button onClick={() => { setEditing(false); setDraft(entry); setErr(null); onCancel?.() }} style={pillButton('ghost')} disabled={busy}>Cancel</button>
        <button onClick={save} style={pillButton('primary')} disabled={busy || !draft.name.trim() || !draft.apiKey.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export const ApiKeysTab: React.FC<Props> = ({ isGatewayRunning }) => {
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try { setApiKeys(unwrap(await window.codey.apiKeys.list())) }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])

  if (!isGatewayRunning) {
    return (
      <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  const saveApiKey = async (entry: ApiKeyEntry, previousName: string) => {
    if (previousName && previousName !== entry.name) {
      await unwrap(await window.codey.apiKeys.rename(previousName, entry.name))
    }
    await unwrap(await window.codey.apiKeys.save(entry))
    await reload()
    setCreating(false)
  }
  const deleteApiKey = async (name: string) => {
    if (!confirm(`Delete API key "${name}"?`)) return
    try { await unwrap(await window.codey.apiKeys.delete(name)); await reload() }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section title="API Keys" right={
        <button onClick={() => setCreating(true)} style={pillButton('primary')} disabled={creating}>+ Add</button>
      } />
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        Saved API keys &amp; endpoints. A single key can be bound from many models in the AI Models tab. Each key can carry separate base URL overrides for anthropic-typed and openai-typed models.
      </div>
      {creating && (
        <ApiRow
          entry={{ name: '', apiKey: '', anthropicBaseUrl: '', openaiBaseUrl: '' }}
          isNew
          onSave={saveApiKey}
          onCancel={() => setCreating(false)}
        />
      )}
      {apiKeys.length === 0 && !creating && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '16px 0' }}>No API keys yet. Click + Add to create one.</div>
      )}
      {[...apiKeys]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => <ApiRow key={a.name} entry={a} onSave={saveApiKey} onDelete={deleteApiKey} />)}
    </div>
  )
}
