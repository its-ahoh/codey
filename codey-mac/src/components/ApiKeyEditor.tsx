import React, { useState } from 'react'
import { C } from '../theme'
import { inputStyle, pillButton } from './settingsAtoms'
import type { CatalogProvider } from '../codey-api'
import { ProviderButton, ProviderPickerModal } from './ProviderPicker'

export interface ApiKeyEntry {
  name: string
  apiKey: string
  anthropicBaseUrl?: string
  openaiBaseUrl?: string
  purpose?: 'general' | 'voice'
  /** Provider preset / models.dev id the key was created from. */
  provider?: string
}

// The API key edit form, shared by Settings ▸ API keys and the inline
// "+ Add key" on a Model card so both validate and look the same.
export const ApiKeyEditor: React.FC<{
  entry: ApiKeyEntry
  /** Companies for the Provider picker; omitted or empty hides the row. */
  providers?: CatalogProvider[]
  onSave: (draft: ApiKeyEntry) => Promise<void>
  onCancel: () => void
  saveLabel?: string
  cancelAriaLabel?: string
}> = ({ entry, providers = [], onSave, onCancel, saveLabel = 'Save', cancelAriaLabel }) => {
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

  const [picking, setPicking] = useState(false)
  const preset = providers.find(p => p.id === draft.provider)
  // Picking a company fills its endpoints; a name or key already typed stays.
  const pickProvider = (id: string | undefined) => {
    const p = providers.find(pp => pp.id === id)
    if (!p) { setDraft({ ...draft, provider: undefined }); return }
    setDraft({
      ...draft,
      provider: p.id,
      name: draft.name.trim() ? draft.name : p.id,
      apiKey: draft.apiKey.trim() ? draft.apiKey : (p.defaultApiKey ?? ''),
      anthropicBaseUrl: p.anthropicBaseUrl,
      openaiBaseUrl: p.openaiBaseUrl,
    })
    if (missing.name || missing.apiKey) { setMissing({ name: false, apiKey: false }); setErr(null) }
  }

  const isVoice = draft.purpose === 'voice'
  return (
    <div style={{
      padding: 12, borderRadius: 10, border: `1px solid ${C.border2}`,
      background: C.surface2, marginBottom: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'center' }}>
        {!isVoice && providers.length > 0 && <>
          <label style={{ color: C.fg3, fontSize: 12 }}>Provider</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <ProviderButton providers={providers} value={draft.provider} placeholder="Custom endpoint"
              onOpen={() => setPicking(true)} ariaLabel="Provider" />
            {preset?.keyUrl && (
              <button onClick={() => void window.codey.openExternal(preset.keyUrl!)} style={pillButton('ghost')}>
                {preset.id === 'magpie' ? 'Get magpie' : preset.curated ? 'Get a key' : 'Docs'}
              </button>
            )}
          </div>
        </>}
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
      {picking && (
        <ProviderPickerModal providers={providers} mode="provider"
          onPickProvider={pickProvider} onClose={() => setPicking(false)} />
      )}
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
