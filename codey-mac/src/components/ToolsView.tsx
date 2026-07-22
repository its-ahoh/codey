import React, { useState } from 'react'
import { C } from '../theme'
import { OverlayWindow } from './OverlayWindow'
import { SkillsTab } from './SkillsTab'
import { PlaybooksTab } from './PlaybooksTab'
import { PluginsTab } from './PluginsTab'
import { McpTab } from './McpTab'
import { UIIcon, type IconName } from './UIIcons'

interface Props { onClose: () => void }

type Tab = 'skills' | 'playbooks' | 'plugins' | 'mcp'

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'skills',  label: 'Skills',  icon: 'sparkle' },
  { key: 'playbooks', label: 'Playbooks', icon: 'archive' },
  { key: 'plugins', label: 'Plugins', icon: 'tools' },
  { key: 'mcp', label: 'MCPs', icon: 'server' },
]

export const ToolsView: React.FC<Props> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('skills')
  const [addSkillRequest, setAddSkillRequest] = useState(0)

  return (
    <OverlayWindow title="Tools" icon="tools" onClose={onClose}>
      <div style={styles.tabBar}>
        {TABS.map(t => {
          const active = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                ...styles.tabBtn,
                ...(active ? styles.tabBtnActive : null),
              }}
            ><UIIcon name={t.icon} size={15} /> <span>{t.label}</span></button>
          )
        })}
        <span style={styles.tabSpacer} />
        {tab === 'skills' && (
          <button style={styles.addSkillBtn} onClick={() => setAddSkillRequest(v => v + 1)}>
            <UIIcon name="add" size={15} />Add skill
          </button>
        )}
      </div>
      <div style={styles.body}>
        {tab === 'skills'  && <SkillsTab addRequest={addSkillRequest} />}
        {tab === 'playbooks' && <PlaybooksTab />}
        {tab === 'plugins' && <PluginsTab />}
        {tab === 'mcp' && <McpTab />}
      </div>
    </OverlayWindow>
  )
}

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex', gap: 8, padding: '12px 16px',
    borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.surface2,
  },
  tabBtn: {
    padding: '9px 12px', border: `1px solid transparent`, borderRadius: 9,
    background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 12, fontWeight: 650,
    display: 'flex', alignItems: 'center', gap: 7,
  },
  tabBtnActive: {
    background: C.accentDim, color: C.fg, border: `1px solid ${C.accent}`,
  },
  tabSpacer: { flex: 1 },
  addSkillBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 9, padding: '9px 12px', color: C.onAccent, background: C.accent, cursor: 'pointer', fontSize: 12, fontWeight: 700, boxShadow: `0 5px 13px ${C.accentDim}` },
  body: { flex: 1, overflowY: 'auto', padding: 20, background: C.bg },
}
