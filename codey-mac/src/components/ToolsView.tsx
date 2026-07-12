import React, { useState } from 'react'
import { C } from '../theme'
import { OverlayWindow } from './OverlayWindow'
import { SkillsTab } from './SkillsTab'
import { PlaybooksTab } from './PlaybooksTab'

interface Props { onClose: () => void }

type Tab = 'skills' | 'playbooks'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'skills',  label: 'Skills',  icon: '✶' },
  { key: 'playbooks', label: 'Playbooks', icon: '🧩' },
]

export const ToolsView: React.FC<Props> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('skills')

  return (
    <OverlayWindow title="Tools" onClose={onClose}>
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
            >{t.icon} {t.label}</button>
          )
        })}
      </div>
      <div style={styles.body}>
        {tab === 'skills'  && <SkillsTab />}
        {tab === 'playbooks' && <PlaybooksTab />}
      </div>
    </OverlayWindow>
  )
}

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex', gap: 6, padding: '8px 12px',
    borderBottom: `1px solid ${C.border}`, flexShrink: 0,
  },
  tabBtn: {
    padding: '6px 12px', border: `1px solid transparent`, borderRadius: 6,
    background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 12,
  },
  tabBtnActive: {
    background: C.accentDim, color: C.fg, border: `1px solid ${C.border2}`,
  },
  body: { flex: 1, overflowY: 'auto', padding: 16 },
}
