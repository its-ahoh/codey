import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { pageStyle, Section, selectStyle, Toggle, unwrap } from './settingsAtoms'
import { AGENT_INSTALL_URL, AGENT_NAMES } from './SettingsTab'
import {
  AgentEnvEditor,
  AgentInstallChip,
  cardBodyStyle,
  cardHeadStyle,
  cardStyle,
  iconButtonStyle,
  rowHintStyle,
  rowLabelStyle,
  rowStyle,
} from './agentSettingsUi'
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
  const [updatingAll, setUpdatingAll] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const { status: installStatus, checking: checkingInstalls } = useInstalledAgents(isGatewayRunning)
  // Shared with the Settings sidebar, which shows the dot; whichever mounts
  // first pays for the lookup and both read the same answer.
  const { updates } = useAgentUpdates(isGatewayRunning)

  // The updater runs in the user's login shell and can take minutes. Success
  // needs no words — the version on the row changes and the button goes away.
  // Failure gets a dialog, because the only useful thing then is the updater's
  // own output, which does not fit under a settings row.
  const runUpdate = useCallback(async (name: string): Promise<Failure | null> => {
    setUpdating(name)
    try {
      const r = unwrap(await window.codey.agents.update(name))
      publishInstalledAgents(r.status)
      publishAgentUpdates(r.updates)
      return r.ok ? null : { agent: name, command: r.command, output: r.output }
    } catch (e: any) {
      return { agent: name, command: 'the update', output: e?.message ?? String(e) }
    } finally {
      setUpdating(null)
    }
  }, [])

  const updateAgent = useCallback(async (name: string) => {
    const f = await runUpdate(name)
    if (f) setFailure(f)
  }, [runUpdate])

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

  // The agents a per-row button would offer to update. Update All runs exactly
  // those, one after another: two updaters writing to the same shell at once is
  // not worth the seconds it would save.
  const updatableAgents = AGENT_NAMES.filter(a => installStatus?.[a]?.installed && offersUpdate(a))

  // One failure does not stop the rest — the remaining agents still get their
  // turn, and the first updater's output is what the dialog shows afterwards.
  const updateAll = async () => {
    setUpdatingAll(true)
    try {
      let first: Failure | null = null
      for (const a of updatableAgents) {
        const f = await runUpdate(a)
        if (f && !first) first = f
      }
      if (first) setFailure(first)
    } finally {
      setUpdatingAll(false)
    }
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
      {/* Two motions, deliberately different: the re-check spins, the updater
          drops its arrows into the tray one after the other, so a glance at
          the header says which of the two buttons is busy. */}
      <style>{`
        @keyframes codey-agent-update-spin { to { transform: rotate(360deg) } }
        @keyframes codey-agent-update-fall {
          0%   { transform: translateY(-3px); opacity: 0 }
          25%  { opacity: 1 }
          70%  { transform: translateY(5px); opacity: 1 }
          100% { transform: translateY(5px); opacity: 0 }
        }
        .codey-updating .codey-fall-a,
        .codey-updating .codey-fall-b {
          animation: codey-agent-update-fall 1.1s ease-in infinite;
        }
        .codey-updating .codey-fall-b { animation-delay: 0.28s }
      `}</style>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}
      {failure && (
        <AgentUpdateFailureModal
          agent={failure.agent}
          command={failure.command}
          output={failure.output}
          onClose={() => setFailure(null)}
        />
      )}

      <Section first title="Installed agents" description="CLI availability, thinking effort, and environment for each coding agent." right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => { void refreshInstalledAgents(true); void refreshAgentUpdates(true) }}
            style={iconButtonStyle({ disabled: checkingInstalls })}
            disabled={checkingInstalls}
            aria-label="Recheck agents"
            title="Re-check what is installed, and whether a newer version has been published"
          >
            <span style={{
              display: 'grid',
              animation: checkingInstalls ? 'codey-agent-update-spin 1s linear infinite' : undefined,
            }}>
              <UIIcon name="refresh" size={14} />
            </span>
          </button>
          {/* Same download icon as the per-agent button, because it does the
              same thing — just to every agent that is offering an update. */}
          <button
            onClick={() => { void updateAll() }}
            style={iconButtonStyle({
              // Busy is not the same as unavailable: while the run is on, the
              // button stays lit so the falling arrows are actually visible.
              accent: updatingAll || updatableAgents.some(a => availabilityOf(a).updateAvailable),
              disabled: !updatingAll && (updating !== null || updatableAgents.length === 0),
            })}
            disabled={updatingAll || updating !== null || updatableAgents.length === 0}
            aria-label="Update all agents"
            title={
              updatingAll ? `Updating ${updating ?? 'agents'}…`
                : updatableAgents.length === 0 ? 'Every installed agent is up to date'
                  : `Update all: ${updatableAgents.join(', ')}`
            }
          >
            <span style={{ display: 'grid' }} className={updatingAll ? 'codey-updating' : undefined}>
              <UIIcon name="download-all" size={14} />
            </span>
          </button>
        </div>
      } />
      {AGENT_NAMES.map(a => {
        const status = installStatus?.[a]
        const env = agents[a]?.env ?? {}
        const update = availabilityOf(a)
        const busy = updating === a
        return (
          <div key={a} style={cardStyle}>
            <div style={cardHeadStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: C.fg, fontSize: 13, fontWeight: 600 }}>{a}</div>
                {/* The version the CLI reported for itself — the only honest
                    answer about what will actually run — and, when there is
                    one, where an update would take it. */}
                {status?.installed && (
                  <div style={rowHintStyle}>
                    {status.version ?? 'version unknown'}
                    {update.updateAvailable && (
                      <span style={{ color: C.accent }}> &rarr; {update.latest}</span>
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
                    title={updateTitle(a)}
                    style={iconButtonStyle({
                      accent: update.updateAvailable,
                      disabled: updating !== null && !busy,
                    })}
                  >
                    <span style={{
                      display: 'grid',
                      animation: busy ? 'codey-agent-update-spin 1s linear infinite' : undefined,
                    }}>
                      <UIIcon name={busy ? 'refresh' : 'download'} size={14} />
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

            <div style={cardBodyStyle}>
              <div style={rowStyle}>
                <div>
                  <div style={rowLabelStyle}>Effort</div>
                  <div style={rowHintStyle}>Used when neither the chat nor a worker overrides it.</div>
                </div>
                <select
                  value={agents[a]?.defaultEffort ?? 'medium'}
                  onChange={e => { void saveSlot(a, { defaultEffort: e.target.value }) }}
                  style={{ ...selectStyle, width: 180, height: 28, padding: '0 10px' }}
                >
                  {EFFORT_OPTIONS.map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>

              {a === AGENT_TEAMS_AGENT && (
                <div style={rowStyle}>
                  <div>
                    <div style={rowLabelStyle}>Agent Teams</div>
                    <div style={rowHintStyle}>Experimental — lets Claude Code run a team of teammate agents.</div>
                  </div>
                  <Toggle
                    on={isAgentTeamsOn(env)}
                    label="Agent Teams"
                    onChange={v => { void saveSlot(a, { env: setAgentTeams(env, v) }) }}
                  />
                </div>
              )}

              <AgentEnvEditor
                env={a === AGENT_TEAMS_AGENT ? envWithoutAgentTeams(env) : env}
                onChange={next => {
                  void saveSlot(a, {
                    env: a === AGENT_TEAMS_AGENT ? mergeEnvKeepingAgentTeams(env, next) : next,
                  })
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
