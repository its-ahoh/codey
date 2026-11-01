import React, { useState } from 'react'
import { OverlayWindow } from './OverlayWindow'
import { StatusTab } from './StatusTab'
import { SettingsTab } from './SettingsTab'
import { AgentsTab } from './AgentsTab'
import { hasAgentUpdate, useAgentUpdates } from './agentUpdates'
import { MemoryTab } from './MemoryTab'
import { WorkspacesTab } from './WorkspacesTab'
import BotsTab from './BotsTab'
import { TeamsTab } from './TeamsTab'
import { useGateway } from '../hooks/useGateway'
import { C } from '../theme'
import { AppearanceTab } from './AppearanceTab'
import { WhisperTab } from './WhisperTab'
import { ApiKeysTab } from './ApiKeysTab'
type Tab = 'general' | 'voice' | 'models' | 'agents' | 'memory' | 'workspaces' | 'botsTeams' | 'status'
const GROUPS: { name: string; tabs: { key: Tab; label: string }[] }[] = [
  { name: 'App', tabs: [{ key: 'general', label: 'General' }, { key: 'voice', label: 'Voice' }] },
  { name: 'AI', tabs: [{ key: 'models', label: 'Models & keys' }, { key: 'agents', label: 'Agents' }, { key: 'memory', label: 'Memory' }] },
  { name: 'Work', tabs: [{ key: 'workspaces', label: 'Workspaces' }, { key: 'botsTeams', label: 'Bots & teams' }] },
  { name: 'System', tabs: [{ key: 'status', label: 'Gateway' }] },
]
const TABS = GROUPS.flatMap(group => group.tabs)

function SubTabs<T extends string>({ value, options, onChange }: {
  value: T; options: { key: T; label: string }[]; onChange: (key: T) => void
}) {
  return <div role="tablist" style={styles.subTabs}>
    {options.map(option => (
      <button key={option.key} type="button" role="tab" aria-selected={value === option.key} onClick={() => onChange(option.key)}
        style={{ ...styles.subTab, background: value === option.key ? C.surface3 : 'transparent', color: value === option.key ? C.fg : C.fg2 }}>
        {option.label}
      </button>
    ))}
  </div>
}

interface Props { onClose: () => void; initialTab?: string }

export const SettingsOverlay: React.FC<Props> = ({ onClose, initialTab }) => {
  const [tab, setTab] = useState<Tab>(
    initialTab?.startsWith('bot:') ? 'botsTeams' : (initialTab && TABS.some(t => t.key === initialTab)) ? (initialTab as Tab) : 'general'
  )
  const [modelsView, setModelsView] = useState<'models' | 'keys'>('models')
  const [teamView, setTeamView] = useState<'bots' | 'teams'>('bots')
  const [apiKeyCreateIntent, setApiKeyCreateIntent] = useState<'voice' | undefined>()
  const { isRunning, status, logs } = useGateway()
  // Checked as soon as Settings opens, so the dot is already right on the row
  // the user has not clicked yet — which is the only reason it exists.
  const { updates } = useAgentUpdates(isRunning)
  const agentUpdate = hasAgentUpdate(updates)

  const activeTab = TABS.find(t => t.key === tab)!

  return (
    <OverlayWindow title="Settings" icon="settings" onClose={onClose}>
      <div style={styles.body}>
          <aside style={styles.sidebar}>
            {GROUPS.map(group => (
              <div key={group.name} style={styles.group}>
                <div style={styles.groupName}>{group.name}</div>
                {group.tabs.map(t => {
                  const active = tab === t.key
                  return (
                    <button
                      key={t.key}
                      onClick={() => setTab(t.key)}
                      style={{
                        ...styles.sideItem,
                        background: active ? C.surface3 : 'transparent',
                        color: active ? C.fg : C.fg2,
                      }}
                    >
                      <span style={styles.sideLabel}>{t.label}</span>
                      {/* One agent CLI has a newer version published. A dot, not a
                          count: the number is on the row inside, and out here the
                          only question is whether it is worth opening. */}
                      {t.key === 'agents' && agentUpdate && (
                        <span style={styles.sideDot} title="An agent CLI has an update" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </aside>
          <main style={styles.main}>
            <div style={styles.mainHeader}>
              <div>{activeTab.label}</div>
              {tab === 'models' && <SubTabs value={modelsView} onChange={setModelsView} options={[{ key: 'models', label: 'Models' }, { key: 'keys', label: 'API keys' }]} />}
              {tab === 'botsTeams' && <SubTabs value={teamView} onChange={setTeamView} options={[{ key: 'bots', label: 'Bots' }, { key: 'teams', label: 'Teams' }]} />}
            </div>
            <div style={styles.mainContent}>
              {tab === 'general'    && <AppearanceTab />}
              {tab === 'models' && modelsView === 'keys' && (
                <ApiKeysTab
                  isGatewayRunning={isRunning}
                  autoCreatePurpose={apiKeyCreateIntent}
                  onAutoCreateHandled={() => setApiKeyCreateIntent(undefined)}
                />
              )}
              {tab === 'models' && modelsView === 'models' && <SettingsTab isGatewayRunning={isRunning} />}
              {tab === 'status'     && <StatusTab status={status} logs={logs} isRunning={isRunning} />}
              {tab === 'workspaces' && <WorkspacesTab isGatewayRunning={isRunning} />}
              {tab === 'botsTeams' && teamView === 'bots' && <BotsTab initialName={initialTab?.startsWith('bot:') ? initialTab.slice(4) : undefined} />}
              {tab === 'botsTeams' && teamView === 'teams' && <TeamsTab />}
              {tab === 'agents'     && <AgentsTab isGatewayRunning={isRunning} />}
              {tab === 'memory'     && <MemoryTab isGatewayRunning={isRunning} />}
              {tab === 'voice'    && (
                <WhisperTab
                  isGatewayRunning={isRunning}
                  onAddVoiceKey={() => {
                    setApiKeyCreateIntent('voice')
                    setModelsView('keys')
                    setTab('models')
                  }}
                />
              )}
            </div>
          </main>
      </div>
    </OverlayWindow>
  )
}

const styles: Record<string, React.CSSProperties> = {
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 190, flexShrink: 0,
    padding: '4px 8px 12px',
    display: 'flex', flexDirection: 'column', gap: 14,
    overflowY: 'auto',
  },
  group: { display: 'flex', flexDirection: 'column', gap: 1 },
  groupName: { padding: '4px 8px', color: C.fg3, fontSize: 12 },
  sideItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    minHeight: 30, padding: '0 8px', border: 'none', flexShrink: 0,
    borderRadius: 8, cursor: 'pointer',
    fontSize: 13, textAlign: 'left',
  },
  sideLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // Pushed to the trailing edge, so it reads as a property of the row rather
  // than of the label it happens to sit after.
  sideDot: { width: 7, height: 7, borderRadius: 4, background: C.accent, marginLeft: 'auto', flexShrink: 0 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: C.surface },
  mainHeader: { padding: '4px 22px 12px', fontSize: 20, fontWeight: 600, color: C.fg, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  subTabs: { display: 'flex', gap: 2, fontWeight: 400 },
  subTab: { height: 28, padding: '0 10px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 },
  mainContent: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' },
}
