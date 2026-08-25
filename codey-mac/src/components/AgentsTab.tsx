import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { fieldStyle, pageStyle, pillButton, Section, selectStyle, Toggle, unwrap } from './settingsAtoms'
import {
  AGENT_INSTALL_URL,
  AGENT_NAMES,
  AgentInstallChip,
  EnvEditor,
} from './SettingsTab'
import { publishInstalledAgents, refreshInstalledAgents, useInstalledAgents } from './installedAgents'
import { AgentUpdateFailureModal } from './AgentUpdateFailureModal'
import { publishAgentUpdates, refreshAgentUpdates, useAgentUpdates, type Availability } from './agentUpdates'
import { UIIcon } from './UIIcons'
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

type Failure = { agent: string; command: string; output: string }

export const AgentsTab: React.FC<Props> = ({ isGatewayRunning }) => {
  const [agents, setAgents] = useState<Record<string, AgentSlot>>({})
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const { status: installStatus, checking: checkingInstalls } = useInstalledAgents(isGatewayRunning)
  // Shared with the Settings sidebar, which shows the dot; whichever mounts
  // first pays for the lookup and both read the same answer.
  const { updates } = useAgentUpdates(isGatewayRunning)

  // The updater runs in the user's login shell and can take minutes. Success
  // needs no words — the version on the row changes and the button goes away.
  // Failure gets a dialog, because the only useful thing then is the updater's
  // own output, which does not fit under a settings row.
  const updateAgent = useCallback(async (name: string) => {
    setUpdating(name)
    try {
      const r = unwrap(await window.codey.agents.update(name))
      publishInstalledAgents(r.status)
      publishAgentUpdates(r.updates)
      if (!r.ok) setFailure({ agent: name, command: r.command, output: r.output })
    } catch (e: any) {
      setFailure({ agent: name, command: 'the update', output: e?.message ?? String(e) })
    } finally {
      setUpdating(null)
    }
  }, [])

  const availabilityOf = (name: string): Availability =>
    updates?.[name] ?? { updateAvailable: false, unknown: true }

  // Shown when there is an update, and also when we could not find out: an
  // offline check must not take the button away from someone who needs it.
  // Hidden only when we know the CLI is current, which is the common case and
  // the one where a button would just be noise.
  const offersUpdate = (name: string) => {
    const a = availabilityOf(name)
    return a.updateAvailable || a.unknown
  }

  const updateTitle = (name: string) => {
    const a = availabilityOf(name)
    if (updating === name) return 'Updating…'
    if (a.updateAvailable) return `Update to ${a.latest}`
    return 'Could not check for a newer version — run the updater anyway'
  }

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
      <style>{'@keyframes codey-agent-update-spin { to { transform: rotate(360deg) } }'}</style>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}
      {failure && (
        <AgentUpdateFailureModal
          agent={failure.agent}
          command={failure.command}
          output={failure.output}
          onClose={() => setFailure(null)}
        />
      )}

      <Section first title="Installed agents" description="CLI availability and environment variables for each coding agent." right={
        <button
          onClick={() => { void refreshInstalledAgents(true); void refreshAgentUpdates(true) }}
          style={pillButton('ghost')}
          disabled={checkingInstalls}
          title="Re-check what is installed, and whether a newer version has been published"
        >
          {checkingInstalls ? 'Checking…' : '↻ Recheck'}
        </button>
      } />
      {AGENT_NAMES.map(a => {
        const status = installStatus?.[a]
        const env = agents[a]?.env ?? {}
        return (
          <div key={a} style={{ ...fieldStyle, display: 'block' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ color: C.fg, fontSize: 13 }}>{a}</span>
                {/* The version the CLI reported for itself — the only honest
                    answer about what will actually run — and, when there is
                    one, where an update would take it. */}
                {status?.installed && (
                  <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>
                    {status.version ?? 'version unknown'}
                    {availabilityOf(a).updateAvailable && (
                      <span style={{ color: C.accent }}> &rarr; {availabilityOf(a).latest}</span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {status?.installed && offersUpdate(a) && (
                  <button
                    onClick={() => { void updateAgent(a) }}
                    disabled={updating !== null}
                    aria-label={`Update ${a}`}
                    style={{
                      display: 'grid', placeItems: 'center', width: 28, height: 28, padding: 0,
                      borderRadius: 8, cursor: updating !== null ? 'default' : 'pointer',
                      background: 'transparent',
                      border: `1px solid ${availabilityOf(a).updateAvailable ? C.accent : C.border2}`,
                      color: availabilityOf(a).updateAvailable ? C.accent : C.fg2,
                      opacity: updating !== null && updating !== a ? 0.4 : 1,
                    }}
                    title={updateTitle(a)}
                  >
                    <span style={updating === a
                      ? { display: 'grid', animation: 'codey-agent-update-spin 1s linear infinite' }
                      : { display: 'grid' }}>
                      <UIIcon name={updating === a ? 'refresh' : 'download'} size={14} />
                    </span>
                  </button>
                )}
                <AgentInstallChip
                  status={status}
                  checking={checkingInstalls && !status}
                  onInstall={() => window.codey.openExternal(AGENT_INSTALL_URL[a])}
                />
              </div>
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
