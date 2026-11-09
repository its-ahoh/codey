import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import {
  pageStyle, pillButton, Section, unwrap,
} from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { ApiKeyEditor, type ApiKeyEntry } from './ApiKeyEditor'

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

  if (!editing) {
    const isVoice = entry.purpose === 'voice'
    const hasAnthropicUrl = !isVoice && !!entry.anthropicBaseUrl
    const hasOpenaiUrl = !!entry.openaiBaseUrl
    const hasAnyUrl = hasAnthropicUrl || hasOpenaiUrl
    const keyTail = entry.apiKey.trim().slice(-4)
    const urlLineStyle: React.CSSProperties = {
      color: C.fg3, fontSize: 12,
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
            {isVoice && <span style={{ color: C.accent, fontSize: 11, marginLeft: 7 }}>VOICE</span>}
          </div>
          <div
            style={{
              color: C.fg3, fontSize: 12, marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 7px', borderRadius: 8, background: C.surface3, border: `1px solid ${C.border2}`,
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
    <ApiKeyEditor
      entry={entry}
      onSave={async draft => { await onSave(draft, entry.name); setEditing(false) }}
      onCancel={() => { setEditing(false); onCancel?.() }}
    />
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


      <Section first title="Voice" right={
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

      <Section title="Model & Agent" right={
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
