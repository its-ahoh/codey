import React, { useState } from 'react'
import { C } from '../theme'
import { inputStyle, pillButton } from './settingsAtoms'

export interface ApiKeyEntry {
  name: string
  apiKey: string
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
  purpose?: 'general' | 'voice'
}

// The API key edit form, shared by Settings ▸ API keys and the inline
// "+ Add key" on a Model card so both validate and look the same.
export const ApiKeyEditor: React.FC<{
  entry: ApiKeyEntry
  onSave: (draft: ApiKeyEntry) => Promise<void>
  onCancel: () => void
  saveLabel?: string
  cancelAriaLabel?: string
}> = ({ entry, onSave, onCancel, saveLabel = 'Save', cancelAriaLabel }) => {
  const [draft, setDraft] = useState<ApiKeyEntry>(entry)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Which required fields the user left blank. Greying the Save button out
  // hid *which* field was missing, so name them instead and mark them red.
  const [missing, setMissing] = useState<{ name: boolean; apiKey: boolean }>({ name: false, apiKey: false })

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
    try { await onSave(draft) }
    catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const isVoice = draft.purpose === 'voice'
  return (
    <div style={{
      padding: 12, borderRadius: 10, border: `1px solid ${C.border2}`,
      background: C.surface2, marginBottom: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'center' }}>
        <label style={{ color: C.fg3, fontSize: 12 }}>Name</label>
        <input aria-label="Key name" value={draft.name}
          onChange={e => { setDraft({ ...draft, name: e.target.value }); if (missing.name) { setMissing(m => ({ ...m, name: false })); setErr(null) } }}
          placeholder="e.g. my-proxy"
          style={{ ...inputStyle, width: '100%', ...(missing.name ? { border: `1px solid ${C.red}` } : null) }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <input aria-label="API key value" type="password" value={draft.apiKey}
          onChange={e => { setDraft({ ...draft, apiKey: e.target.value }); if (missing.apiKey) { setMissing(m => ({ ...m, apiKey: false })); setErr(null) } }}
          placeholder="API key"
          style={{ ...inputStyle, width: '100%', ...(missing.apiKey ? { border: `1px solid ${C.red}` } : null) }} />
        {!isVoice && <>
          <label style={{ color: C.fg3, fontSize: 12 }}>Anthropic Base URL</label>
          <input aria-label="Anthropic base URL" value={draft.anthropicBaseUrl ?? ''} onChange={e => setDraft({ ...draft, anthropicBaseUrl: e.target.value || undefined })}
            placeholder="(optional) override anthropic endpoint" style={{ ...inputStyle, width: '100%' }} />
        </>}
        <label style={{ color: C.fg3, fontSize: 12 }}>{isVoice ? 'Voice API Base URL' : 'OpenAI Base URL'}</label>
        <input aria-label={isVoice ? 'Voice API base URL' : 'OpenAI base URL'} value={draft.openaiBaseUrl ?? ''} onChange={e => setDraft({ ...draft, openaiBaseUrl: e.target.value || undefined })}
          placeholder={isVoice ? 'https://api.openai.com/v1' : '(optional) override openai endpoint'} style={{ ...inputStyle, width: '100%' }} />
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        <button aria-label={cancelAriaLabel} onClick={onCancel} style={pillButton('ghost')} disabled={busy}>Cancel</button>
        <button onClick={save} style={pillButton('primary')} disabled={busy}>
          {busy ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  )
}
