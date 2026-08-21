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
  const [searchQuery, setSearchQuery] = useState('')

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
        <div style={styles.searchBox}>
          <span style={styles.searchIcon}><UIIcon name="search" size={14} /></span>
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setSearchQuery('') }}
            placeholder="Search tools…"
            aria-label="Search tools by name or description"
            style={styles.searchInput}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              title="Clear search"
              style={styles.clearSearch}
            ><UIIcon name="close" size={12} /></button>
          )}
        </div>
        {tab === 'skills' && (
          <button
            style={styles.addSkillBtn}
            onClick={() => setAddSkillRequest(v => v + 1)}
          >
            <UIIcon name="add" size={15} />Add skill
          </button>
        )}
      </div>
      <div style={{ ...styles.body, ...(tab === 'skills' ? styles.skillsBody : null) }}>
        {tab === 'skills' && <SkillsTab addRequest={addSkillRequest} searchQuery={searchQuery} />}
        {tab === 'playbooks' && <PlaybooksTab searchQuery={searchQuery} />}
        {tab === 'plugins' && <PluginsTab searchQuery={searchQuery} />}
        {tab === 'mcp' && <McpTab searchQuery={searchQuery} />}
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
  searchBox: {
    width: 220, minWidth: 140, height: 34, boxSizing: 'border-box',
    display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
    border: `1px solid ${C.border2}`, borderRadius: 9, background: C.bg,
  },
  searchIcon: { display: 'inline-flex', color: C.fg3, flexShrink: 0 },
  searchInput: {
    flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
    color: C.fg, fontSize: 12, fontFamily: 'inherit', padding: 0,
  },
  clearSearch: {
    width: 22, height: 22, padding: 0, display: 'grid', placeItems: 'center', flexShrink: 0,
    border: 'none', borderRadius: 6, background: 'transparent', color: C.fg3, cursor: 'pointer',
  },
  addSkillBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 9, padding: '9px 12px', color: C.onAccent, background: C.accent, cursor: 'pointer', fontSize: 12, fontWeight: 700, boxShadow: `0 5px 13px ${C.accentDim}` },
  body: { flex: 1, overflowY: 'auto', padding: 20, background: C.bg },
  skillsBody: { padding: 0 },
}
