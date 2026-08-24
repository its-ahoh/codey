import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { fieldStyle, pageStyle, pillButton, Section, selectStyle, Toggle, unwrap } from './settingsAtoms'
import {
  AGENT_INSTALL_URL,
  AGENT_NAMES,
  AgentInstallChip,
  EnvEditor,
} from './SettingsTab'
import { refreshInstalledAgents, useInstalledAgents } from './installedAgents'
import {
  AGENT_TEAMS_AGENT,
  envWithoutAgentTeams,
  isAgentTeamsOn,
  mergeEnvKeepingAgentTeams,
  setAgentTeams,
} from './agentTeams'

interface Props {
  isGatewayRunning: boolean
}

type AgentSlot = { enabled?: boolean; defaultModel?: string; defaultEffort?: string; env?: Record<string, string> }

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const AgentsTab: React.FC<Props> = ({ isGatewayRunning }) => {
  const [agents, setAgents] = useState<Record<string, AgentSlot>>({})
  const [error, setError] = useState<string | null>(null)
  const { status: installStatus, checking: checkingInstalls } = useInstalledAgents(isGatewayRunning)

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
  }, [isGatewayRunning, reload])

  // agents:set merges shallowly, so sending just the touched agent's slot is
  // enough — no need to re-send the others.
  const saveSlot = useCallback(async (name: string, patch: Partial<AgentSlot>) => {
    const slot = { ...(agents[name] ?? {}), ...patch }
    setAgents(prev => ({ ...prev, [name]: slot }))
    try {
      unwrap(await window.codey.agents.set({ [name]: slot }))
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [agents])

  if (!isGatewayRunning) {
    return (
      <div style={pageStyle}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section first title="Installed agents" description="CLI availability and environment variables for each coding agent." right={
        <button onClick={() => void refreshInstalledAgents(true)} style={pillButton('ghost')} disabled={checkingInstalls} title="Re-check whether each agent's CLI is installed">
          {checkingInstalls ? 'Checking…' : '↻ Recheck'}
        </button>
      } />
      {AGENT_NAMES.map(a => {
        const status = installStatus?.[a]
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10 }}>
              <span style={{ color: C.fg3, fontSize: 12 }}>Effort</span>
              <select
                value={agents[a]?.defaultEffort ?? 'medium'}
                onChange={e => { void saveSlot(a, { defaultEffort: e.target.value }) }}
                style={{ ...selectStyle, width: 180 }}
                title="Thinking effort used when neither the chat nor a worker overrides it"
              >
                {EFFORT_OPTIONS.map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
            {a === AGENT_TEAMS_AGENT && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10 }}>
                <div>
                  <div style={{ color: C.fg3, fontSize: 12 }}>Agent Teams</div>
                  <div style={{ color: C.fg3, fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                    Experimental — lets Claude Code run a team of teammate agents.
                  </div>
                </div>
                <Toggle
                  on={isAgentTeamsOn(env)}
                  label="Agent Teams"
                  onChange={v => { void saveSlot(a, { env: setAgentTeams(env, v) }) }}
                />
              </div>
            )}
            <EnvEditor
              env={a === AGENT_TEAMS_AGENT ? envWithoutAgentTeams(env) : env}
              onChange={next => {
                void saveSlot(a, {
                  env: a === AGENT_TEAMS_AGENT ? mergeEnvKeepingAgentTeams(env, next) : next,
                })
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
