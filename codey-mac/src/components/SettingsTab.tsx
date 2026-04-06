import React, { useState, useEffect } from 'react'
import { GatewayConfig } from '../types'
import { apiService } from '../services/api'

interface SettingsTabProps {
  isGatewayRunning: boolean
}

export const SettingsTab: React.FC<SettingsTabProps> = ({ isGatewayRunning }) => {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [editedConfig, setEditedConfig] = useState<GatewayConfig | null>(null)
  const [port, setPort] = useState('3000')
  const [saving, setSaving] = useState(false)
  const [gatewayPath, setGatewayPath] = useState('')

  useEffect(() => {
    // Load gateway path from Electron settings
    const api = window.electronAPI
    if (api?.getGatewayPath) {
      api.getGatewayPath().then(setGatewayPath)
    }
  }, [])

  useEffect(() => {
    if (isGatewayRunning) {
      loadConfig()
    }
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
    } catch (error) {
      console.error('Failed to save config:', error)
    } finally {
      setSaving(false)
    }
  }

  const updateField = (path: string, value: any) => {
    if (!editedConfig) return
    // Deep clone to ensure React detects nested changes
    const updated = JSON.parse(JSON.stringify(editedConfig))
    const parts = path.split('.')
    let obj = updated
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]]
    }
    obj[parts[parts.length - 1]] = value
    setEditedConfig(updated)
  }

  const saveGatewayPath = async () => {
    const api = window.electronAPI
    if (api?.setGatewayPath && gatewayPath) {
      await api.setGatewayPath(gatewayPath)
    }
  }

  if (!isGatewayRunning) {
    return (
      <div style={styles.container}>
        <div style={styles.section}>Gateway Path</div>
        <div style={styles.field}>
          <span style={styles.label}>Install Path</span>
          <input
            style={styles.input}
            type="text"
            value={gatewayPath}
            onChange={e => setGatewayPath(e.target.value)}
            onBlur={saveGatewayPath}
            placeholder="e.g. ~/.codey"
          />
        </div>
        <div style={styles.offline}>Start the gateway to edit other settings</div>
      </div>
    )
  }

  const AVAILABLE_AGENTS = [
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode', label: 'OpenCode' },
    { value: 'codex', label: 'Codex' },
  ]

  const currentAgent = editedConfig?.gateway?.defaultAgent || 'claude-code'
  const agentModels: string[] = editedConfig?.agents?.[currentAgent]?.models?.map((m: any) => m.model) || []
  const currentModel = editedConfig?.agents?.[currentAgent]?.defaultModel || ''

  return (
    <div style={styles.container}>
      <div style={styles.section}>Gateway</div>
      <div style={styles.field}>
        <span style={styles.label}>Port</span>
        <input
          style={styles.input}
          type="number"
          value={port}
          onChange={e => setPort(e.target.value)}
        />
      </div>
      <div style={styles.field}>
        <span style={styles.label}>Default Agent</span>
        <select
          style={styles.select}
          value={editedConfig?.gateway.defaultAgent || ''}
          onChange={e => updateField('gateway.defaultAgent', e.target.value)}
        >
          {AVAILABLE_AGENTS.map(agent => (
            <option key={agent.value} value={agent.value}>{agent.label}</option>
          ))}
        </select>
      </div>
      <div style={styles.field}>
        <span style={styles.label}>Default Model</span>
        {agentModels.length > 0 ? (
          <select
            style={styles.select}
            value={currentModel}
            onChange={e => updateField(`agents.${currentAgent}.defaultModel`, e.target.value)}
          >
            {agentModels.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        ) : (
          <input
            style={styles.input}
            type="text"
            value={currentModel}
            onChange={e => updateField(`agents.${currentAgent}.defaultModel`, e.target.value)}
            placeholder="e.g. claude-sonnet-4-5"
          />
        )}
      </div>

      <div style={styles.section}>Channels</div>
      <div style={styles.field}>
        <span style={styles.label}>Telegram</span>
        <input
          type="checkbox"
          checked={editedConfig?.channels.telegram?.enabled || false}
          onChange={e => updateField('channels.telegram.enabled', e.target.checked)}
        />
      </div>
      <div style={styles.field}>
        <span style={styles.label}>Discord</span>
        <input
          type="checkbox"
          checked={editedConfig?.channels.discord?.enabled || false}
          onChange={e => updateField('channels.discord.enabled', e.target.checked)}
        />
      </div>

      <div style={styles.section}>API Keys</div>
      <div style={styles.field}>
        <span style={styles.label}>Anthropic</span>
        <input
          style={styles.input}
          type="password"
          value={editedConfig?.apiKeys.anthropic || ''}
          onChange={e => updateField('apiKeys.anthropic', e.target.value)}
        />
      </div>
      <div style={styles.field}>
        <span style={styles.label}>OpenAI</span>
        <input
          style={styles.input}
          type="password"
          value={editedConfig?.apiKeys.openai || ''}
          onChange={e => updateField('apiKeys.openai', e.target.value)}
        />
      </div>

      <button
        style={styles.saveButton}
        onClick={saveConfig}
        disabled={saving}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    padding: '16px',
    overflowY: 'auto',
  },
  offline: {
    color: '#888',
    textAlign: 'center',
    marginTop: '40px',
  },
  section: {
    color: '#fff',
    fontSize: '16px',
    fontWeight: '600',
    marginTop: '20px',
    marginBottom: '12px',
  },
  field: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  },
  label: {
    color: '#ccc',
  },
  input: {
    backgroundColor: '#2a2a2a',
    color: '#fff',
    padding: '8px',
    borderRadius: '4px',
    width: '200px',
    border: '1px solid #444',
  },
  select: {
    backgroundColor: '#2a2a2a',
    color: '#fff',
    padding: '8px',
    borderRadius: '4px',
    width: '200px',
    border: '1px solid #444',
  },
  saveButton: {
    backgroundColor: '#007AFF',
    padding: '14px',
    borderRadius: '8px',
    alignItems: 'center',
    marginTop: '20px',
    border: 'none',
    color: '#fff',
    fontWeight: '600',
    cursor: 'pointer',
    width: '100%',
  },
}
