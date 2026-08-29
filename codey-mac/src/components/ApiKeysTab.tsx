import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import {
  inputStyle, pageIntroStyle, pageStyle, pillButton, Section, unwrap,
} from './settingsAtoms'
import { UIIcon } from './UIIcons'

interface ApiKeyEntry {
  name: string
  apiKey: string
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
  purpose?: 'general' | 'voice'
}

interface Props {
  isGatewayRunning: boolean
  autoCreatePurpose?: 'voice' | 'general'
  onAutoCreateHandled?: () => void
}

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
  // Which required fields the user left blank. Greying the Save button out
  // hid *which* field was missing, so name them instead and mark them red.
  const [missing, setMissing] = useState<{ name: boolean; apiKey: boolean }>({ name: false, apiKey: false })

  useEffect(() => { if (!editing) setDraft(entry) }, [entry.name, editing])

  const save = async () => {
    const blank = { name: !draft.name.trim(), apiKey: !draft.apiKey.trim() }
    if (blank.name || blank.apiKey) {
      setMissing(blank)
      const labels = [blank.name && 'Name', blank.apiKey && 'API Key'].filter(Boolean)
      setErr(`${labels.join(' and ')} ${labels.length > 1 ? 'are' : 'is'} required.`)
      return
    }
    setMissing({ name: false, apiKey: false })
    setBusy(true); setErr(null)
    try { await onSave(draft, entry.name); setEditing(false) }
    catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }

  if (!editing) {
    const isVoice = entry.purpose === 'voice'
    const hasAnthropicUrl = !isVoice && !!entry.anthropicBaseUrl
    const hasOpenaiUrl = !!entry.openaiBaseUrl
    const hasAnyUrl = hasAnthropicUrl || hasOpenaiUrl
    const keyTail = entry.apiKey.trim().slice(-4)
    const urlLineStyle: React.CSSProperties = {
      color: C.fg3, fontSize: 11,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }
    const labelStyle: React.CSSProperties = { color: C.fg3, opacity: 0.7, marginRight: 4 }
    return (
      <div style={{
        padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`,
        background: C.surface2, marginBottom: 8,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {entry.name}
            {isVoice && <span style={{ color: C.accent, fontSize: 10, marginLeft: 7 }}>VOICE</span>}
          </div>
          <div
            style={{
              color: C.fg3, fontSize: 11, marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 7px', borderRadius: 7, background: C.surface3, border: `1px solid ${C.border2}`,
            }}
            title={keyTail ? `API key ending in ${keyTail}` : 'API key saved'}
          >
            <UIIcon name="key" size={13} />
            <span>{keyTail ? `Key · •••• ${keyTail}` : 'Key saved'}</span>
          </div>
          {hasAnyUrl ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>
              {hasAnthropicUrl && (
                <div style={urlLineStyle} title={entry.anthropicBaseUrl}>
                  <span style={labelStyle}>anthropic:</span>{entry.anthropicBaseUrl}
                </div>
              )}
              {hasOpenaiUrl && (
                <div style={urlLineStyle} title={entry.openaiBaseUrl}>
                  <span style={labelStyle}>openai:</span>{entry.openaiBaseUrl}
                </div>
              )}
            </div>
          ) : (
            <div style={{ ...urlLineStyle, marginTop: 2 }}>default endpoints</div>
          )}
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
        <input value={draft.name}
          onChange={e => { setDraft({ ...draft, name: e.target.value }); if (missing.name) { setMissing(m => ({ ...m, name: false })); setErr(null) } }}
          placeholder="e.g. my-proxy"
          style={{ ...inputStyle, width: '100%', ...(missing.name ? { border: `1px solid ${C.red}` } : null) }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <input type="password" value={draft.apiKey}
          onChange={e => { setDraft({ ...draft, apiKey: e.target.value }); if (missing.apiKey) { setMissing(m => ({ ...m, apiKey: false })); setErr(null) } }}
          placeholder="API key"
          style={{ ...inputStyle, width: '100%', ...(missing.apiKey ? { border: `1px solid ${C.red}` } : null) }} />
        {draft.purpose !== 'voice' && <>
          <label style={{ color: C.fg3, fontSize: 12 }}>Anthropic Base URL</label>
          <input value={draft.anthropicBaseUrl ?? ''} onChange={e => setDraft({ ...draft, anthropicBaseUrl: e.target.value || undefined })}
            placeholder="(optional) override anthropic endpoint" style={{ ...inputStyle, width: '100%' }} />
        </>}
        <label style={{ color: C.fg3, fontSize: 12 }}>{draft.purpose === 'voice' ? 'Voice API Base URL' : 'OpenAI Base URL'}</label>
        <input value={draft.openaiBaseUrl ?? ''} onChange={e => setDraft({ ...draft, openaiBaseUrl: e.target.value || undefined })}
          placeholder={draft.purpose === 'voice' ? 'https://api.openai.com/v1' : '(optional) override openai endpoint'} style={{ ...inputStyle, width: '100%' }} />
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        <button onClick={() => { setEditing(false); setDraft(entry); setErr(null); setMissing({ name: false, apiKey: false }); onCancel?.() }} style={pillButton('ghost')} disabled={busy}>Cancel</button>
        <button onClick={save} style={pillButton('primary')} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export const ApiKeysTab: React.FC<Props> = ({ isGatewayRunning, autoCreatePurpose, onAutoCreateHandled }) => {
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([])
  const [creating, setCreating] = useState<'general' | 'voice' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try { setApiKeys(unwrap(await window.codey.apiKeys.list())) }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])
  useEffect(() => {
    if (!autoCreatePurpose) return
    setCreating(autoCreatePurpose)
    onAutoCreateHandled?.()
  }, [autoCreatePurpose, onAutoCreateHandled])

  if (!isGatewayRunning) {
    return (
      <div style={pageStyle}>
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
    setCreating(null)
  }
  const deleteApiKey = async (name: string) => {
    if (!confirm(`Delete API key "${name}"?`)) return
    try { await unwrap(await window.codey.apiKeys.delete(name)); await reload() }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }

  return (
    <div style={pageStyle}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <div style={pageIntroStyle}>Store credentials once, then select them from Models or Voice settings. Secrets are not duplicated into those feature configs.</div>

      <Section first title="Voice" description="Credentials for transcription and spoken replies." right={
        <button onClick={() => setCreating('voice')} style={pillButton('primary')} disabled={creating !== null}>+ Add</button>
      } />
      {creating === 'voice' && (
        <ApiRow
          entry={{ name: '', apiKey: '', openaiBaseUrl: 'https://api.openai.com/v1', purpose: 'voice' }}
          isNew
          onSave={saveApiKey}
          onCancel={() => setCreating(null)}
        />
      )}
      {apiKeys.filter(a => a.purpose === 'voice').length === 0 && creating !== 'voice' && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '8px 0 16px' }}>No Voice keys saved.</div>
      )}
      {[...apiKeys]
        .filter(a => a.purpose === 'voice')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => <ApiRow key={a.name} entry={a} onSave={saveApiKey} onDelete={deleteApiKey} />)}

      <Section title="Model & Agent" description="Reusable credentials for AI models and agents." right={
        <button onClick={() => setCreating('general')} style={pillButton('primary')} disabled={creating !== null}>+ Add</button>
      } />
      {creating === 'general' && (
        <ApiRow
          entry={{ name: '', apiKey: '', anthropicBaseUrl: '', openaiBaseUrl: '', purpose: 'general' }}
          isNew
          onSave={saveApiKey}
          onCancel={() => setCreating(null)}
        />
      )}
      {apiKeys.filter(a => a.purpose !== 'voice').length === 0 && creating !== 'general' && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '8px 0 16px' }}>No model keys saved.</div>
      )}
      {[...apiKeys]
        .filter(a => a.purpose !== 'voice')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => <ApiRow key={a.name} entry={a} onSave={saveApiKey} onDelete={deleteApiKey} />)}
    </div>
  )
}
