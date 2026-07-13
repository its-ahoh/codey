import React, { useState } from 'react'
import { OverlayWindow } from './OverlayWindow'
import { StatusTab } from './StatusTab'
import { SettingsTab } from './SettingsTab'
import { AgentsTab } from './AgentsTab'
import { WorkspacesTab } from './WorkspacesTab'
import WorkersTab from './WorkersTab'
import { TeamsTab } from './TeamsTab'
import { useGateway } from '../hooks/useGateway'
import { C } from '../theme'
import { AppearanceTab } from './AppearanceTab'
import { WhisperTab } from './WhisperTab'
import { ApiKeysTab } from './ApiKeysTab'
import { UIIcon, type IconName } from './UIIcons'
type Tab = 'general' | 'workers' | 'teams' | 'workspaces' | 'status' | 'settings' | 'agents' | 'whisper' | 'apiKeys'
const TABS: { key: Tab; label: string; icon: IconName; description: string }[] = [
  { key: 'general',    label: 'General',    icon: 'settings', description: 'Appearance & behavior' },
  { key: 'apiKeys',    label: 'API Keys',   icon: 'key', description: 'Shared credentials' },
  { key: 'settings',   label: 'AI Models',  icon: 'sparkle', description: 'Models & fallbacks' },
  { key: 'agents',     label: 'Agents',     icon: 'bot', description: 'CLI install & environment' },
  { key: 'whisper',    label: 'Voice',      icon: 'mic', description: 'Voice input & hotkeys' },
  { key: 'workspaces', label: 'Workspaces', icon: 'workspace', description: 'Project directories' },
  { key: 'workers',    label: 'Workers',    icon: 'users', description: 'Personalities' },
  { key: 'teams',      label: 'Teams',      icon: 'users', description: 'Team library' },
  { key: 'status',     label: 'Gateway',    icon: 'server', description: 'Service health & logs' },
]

interface Props { onClose: () => void; initialTab?: string }

export const SettingsOverlay: React.FC<Props> = ({ onClose, initialTab }) => {
  const [tab, setTab] = useState<Tab>(
    (initialTab && TABS.some(t => t.key === initialTab)) ? (initialTab as Tab) : 'settings'
  )
  const { isRunning, status, logs } = useGateway()

  const activeTab = TABS.find(t => t.key === tab)!

  return (
    <OverlayWindow title="Settings" icon="settings" onClose={onClose}>
      <div style={styles.body}>
          <aside style={styles.sidebar}>
            {TABS.map(t => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  style={{
                    ...styles.sideItem,
                    background: active ? C.accentDim : 'transparent',
                    color: active ? C.fg : C.fg2,
                  }}
                >
                  <span style={{ ...styles.sideIcon, color: active ? C.accent : C.fg3 }}><UIIcon name={t.icon} size={16} /></span>
                  <span style={styles.sideLabel}>
                    <span style={{ fontWeight: 500 }}>{t.label}</span>
                    <span style={styles.sideDesc}>{t.description}</span>
                  </span>
                </button>
              )
            })}
          </aside>
          <main style={styles.main}>
            <div style={styles.mainHeader}>
              <span style={styles.mainHeaderIcon}><UIIcon name={activeTab.icon} size={17} /></span>
              <div><div>{activeTab.label}</div><span style={styles.mainHeaderSub}>{activeTab.description}</span></div>
            </div>
            <div style={styles.mainContent}>
              {tab === 'general'    && <AppearanceTab />}
              {tab === 'apiKeys'    && <ApiKeysTab isGatewayRunning={isRunning} />}
              {tab === 'status'     && <StatusTab status={status} logs={logs} isRunning={isRunning} />}
              {tab === 'workspaces' && <WorkspacesTab isGatewayRunning={isRunning} />}
              {tab === 'workers'    && <WorkersTab />}
              {tab === 'teams'      && <TeamsTab />}
              {tab === 'settings'   && <SettingsTab isGatewayRunning={isRunning} />}
              {tab === 'agents'     && <AgentsTab isGatewayRunning={isRunning} />}
              {tab === 'whisper'    && <WhisperTab isGatewayRunning={isRunning} />}
            </div>
          </main>
      </div>
    </OverlayWindow>
  )
}

const styles: Record<string, React.CSSProperties> = {
  body: { flex: 1, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 222, flexShrink: 0,
    background: C.surface2,
    borderRight: `1px solid ${C.border}`,
    padding: '14px 10px',
    display: 'flex', flexDirection: 'column', gap: 2,
    overflowY: 'auto',
  },
  sideItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 10px', border: '1px solid transparent',
    borderRadius: 9, cursor: 'pointer',
    fontSize: 13, textAlign: 'left',
  },
  sideIcon: { width: 29, height: 29, borderRadius: 8, background: C.surface3, display: 'grid', placeItems: 'center', flexShrink: 0 },
  sideLabel: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  sideDesc: { fontSize: 11, color: C.fg3, fontWeight: 400 },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: C.bg },
  mainHeader: { padding: '14px 22px', fontSize: 15, fontWeight: 750, color: C.fg, borderBottom: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, background: C.surface },
  mainHeaderIcon: { width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 9, color: C.accent, background: C.accentDim },
  mainHeaderSub: { display: 'block', color: C.fg3, fontSize: 11, fontWeight: 400, marginTop: 2 },
  mainContent: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' },
}
