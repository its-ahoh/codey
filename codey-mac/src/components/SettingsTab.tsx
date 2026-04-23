import React, { useState, useEffect } from 'react'
import { GatewayConfig } from '../types'
import { apiService } from '../services/api'
import { C } from '../theme'

interface SettingsTabProps {
  isGatewayRunning: boolean
}

const Section: React.FC<{ title: string }> = ({ title }) => (
  <div style={sectionStyle}>{title}</div>
)

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={fieldStyle}>
    <span style={{ color: C.fg2, fontSize: 13 }}>{label}</span>
    {children}
  </div>
)

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <div
    onClick={() => onChange(!on)}
    style={{
      width: 36,
      height: 20,
      borderRadius: 10,
      background: on ? C.accent : C.surface3,
      border: `1px solid ${on ? C.accent : C.border2}`,
      cursor: 'pointer',
      position: 'relative',
      transition: 'all 0.2s',
      flexShrink: 0,
    }}
  >
    <div
      style={{
        position: 'absolute',
        top: 1,
        left: on ? 17 : 1,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }}
    />
  </div>
)

export const SettingsTab: React.FC<SettingsTabProps> = ({ isGatewayRunning }) => {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [editedConfig, setEditedConfig] = useState<GatewayConfig | null>(null)
  const [port, setPort] = useState('3000')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (isGatewayRunning) loadConfig()
  }, [isGatewayRunning])

  const loadConfig = async () => {
    try {
      const cfg = await apiService.getConfig()
      setConfig(cfg)
      setEditedConfig(cfg)
      setPort(cfg.gateway.port.toString())
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

  const saveConfig = async () => {
    if (!editedConfig) return
    setSaving(true)
    try {
      await apiService.setConfig(editedConfig)
      setConfig(editedConfig)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      console.error('Failed to save config:', error)
    } finally {
      setSaving(false)
    }
  }

  const updateField = (path: string, value: any) => {
    if (!editedConfig) return
    const updated = JSON.parse(JSON.stringify(editedConfig))
    const parts = path.split('.')
    let obj = updated
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]]
    obj[parts[parts.length - 1]] = value
    setEditedConfig(updated)
  }

  const inputStyle: React.CSSProperties = {
    background: C.surface3,
    border: `1px solid ${C.border2}`,
    borderRadius: 7,
    color: C.fg,
    fontSize: 13,
    padding: '6px 10px',
    outline: 'none',
    width: 180,
    textAlign: 'right',
  }
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

  if (!isGatewayRunning) {
    return (
      <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>
          Gateway not available
        </div>
      </div>
    )
  }

  const AVAILABLE_AGENTS = [
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode',    label: 'OpenCode' },
    { value: 'codex',       label: 'Codex' },
  ]
  const currentAgent = editedConfig?.gateway?.defaultAgent || 'claude-code'
  const agentModels: string[] = editedConfig?.agents?.[currentAgent]?.models?.map((m: any) => m.model) || []
  const currentModel = editedConfig?.agents?.[currentAgent]?.defaultModel || ''

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      <Section title="Gateway" />
      <Field label="Port">
        <input type="number" value={port} onChange={e => setPort(e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Default Agent">
        <select
          value={currentAgent}
          onChange={e => updateField('gateway.defaultAgent', e.target.value)}
          style={selectStyle}
        >
          {AVAILABLE_AGENTS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </Field>
      <Field label="Default Model">
        {agentModels.length > 0 ? (
          <select
            value={currentModel}
            onChange={e => updateField(`agents.${currentAgent}.defaultModel`, e.target.value)}
            style={selectStyle}
          >
            {agentModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            value={currentModel}
            onChange={e => updateField(`agents.${currentAgent}.defaultModel`, e.target.value)}
            placeholder="e.g. claude-sonnet-4-5"
            style={inputStyle}
          />
        )}
      </Field>

      <Section title="Channels" />
      <Field label="Telegram">
        <Toggle
          on={!!editedConfig?.channels?.telegram?.enabled}
          onChange={v => updateField('channels.telegram.enabled', v)}
        />
      </Field>
      <Field label="Discord">
        <Toggle
          on={!!editedConfig?.channels?.discord?.enabled}
          onChange={v => updateField('channels.discord.enabled', v)}
        />
      </Field>
      <Field label="iMessage">
        <Toggle
          on={!!editedConfig?.channels?.imessage?.enabled}
          onChange={v => updateField('channels.imessage.enabled', v)}
        />
      </Field>

      <Section title="API Keys" />
      <Field label="Anthropic">
        <input
          type="password"
          placeholder="sk-ant-…"
          value={editedConfig?.apiKeys?.anthropic || ''}
          onChange={e => updateField('apiKeys.anthropic', e.target.value)}
          style={inputStyle}
        />
      </Field>
      <Field label="OpenAI">
        <input
          type="password"
          placeholder="sk-…"
          value={editedConfig?.apiKeys?.openai || ''}
          onChange={e => updateField('apiKeys.openai', e.target.value)}
          style={inputStyle}
        />
      </Field>
      <Field label="Google">
        <input
          type="password"
          placeholder="AIza…"
          value={editedConfig?.apiKeys?.google || ''}
          onChange={e => updateField('apiKeys.google', e.target.value)}
          style={inputStyle}
        />
      </Field>

      <button
        onClick={saveConfig}
        disabled={saving}
        style={{
          marginTop: 24,
          width: '100%',
          padding: 12,
          borderRadius: 9,
          border: 'none',
          background: saved ? '#32D74B22' : C.accent,
          color: saved ? C.green : '#fff',
          fontWeight: 600,
          fontSize: 14,
          cursor: saving ? 'wait' : 'pointer',
          transition: 'all 0.2s',
        }}
      >
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Settings'}
      </button>
    </div>
  )
}

const sectionStyle: React.CSSProperties = {
  color: C.fg3,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  marginTop: 22,
  marginBottom: 8,
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 0',
  borderBottom: `1px solid ${C.border}`,
}
