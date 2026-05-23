import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { fieldStyle, pillButton, unwrap } from './settingsAtoms'
import {
  AGENT_INSTALL_URL,
  AGENT_NAMES,
  AgentInstallChip,
  EnvEditor,
  InstallStatus,
} from './SettingsTab'

interface Props {
  isGatewayRunning: boolean
}

type AgentSlot = { enabled?: boolean; defaultModel?: string; env?: Record<string, string> }

export const AgentsTab: React.FC<Props> = ({ isGatewayRunning }) => {
  const [agents, setAgents] = useState<Record<string, AgentSlot>>({})
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({})
  const [checkingInstalls, setCheckingInstalls] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshInstallStatus = useCallback(async () => {
    setCheckingInstalls(true)
    try {
      const r = await window.codey.agents.checkInstalled()
      if (r.ok) setInstallStatus(r.data)
    } catch { /* leave previous status as-is */ }
    finally { setCheckingInstalls(false) }
  }, [])

  const reload = useCallback(async () => {
    setError(null)
    try {
      const ag = unwrap(await window.codey.agents.get())
      setAgents((ag ?? {}) as Record<string, AgentSlot>)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => {
    if (!isGatewayRunning) return
    void reload()
    void refreshInstallStatus()
  }, [isGatewayRunning, reload, refreshInstallStatus])

  if (!isGatewayRunning) {
    return (
      <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <div style={{ color: C.fg3, fontSize: 11 }}>
          Each agent shows whether its CLI is installed locally. Add custom environment variables that are passed through to the spawned CLI.
        </div>
        <button onClick={refreshInstallStatus} style={pillButton('ghost')} disabled={checkingInstalls} title="Re-check whether each agent's CLI is installed">
          {checkingInstalls ? 'Checking…' : '↻ Recheck'}
        </button>
      </div>
      {AGENT_NAMES.map(a => {
        const status = installStatus[a]
        const env = agents[a]?.env ?? {}
        return (
          <div key={a} style={{ ...fieldStyle, display: 'block' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: C.fg, fontSize: 13 }}>{a}</span>
              <AgentInstallChip
                status={status}
                checking={checkingInstalls && !status}
                onInstall={() => window.codey.openExternal(AGENT_INSTALL_URL[a])}
              />
            </div>
            <EnvEditor
              env={env}
              onChange={async (next) => {
                const updated: Record<string, AgentSlot> = {
                  ...agents,
                  [a]: { ...(agents[a] ?? {}), env: next },
                }
                setAgents(updated)
                // agents:set merges shallowly, so sending just this agent's
                // slot is enough — no need to re-send the others.
                await unwrap(await window.codey.agents.set({ [a]: updated[a] }))
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
