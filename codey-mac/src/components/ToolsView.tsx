import React, { useEffect, useState } from 'react'
import { C } from '../theme'
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.window} onClick={e => e.stopPropagation()}>
        <div style={styles.titleBar}>
          <button onClick={onClose} style={styles.closeBtn} title="Close (Esc)" aria-label="Close">
            <span style={styles.closeDot} />
          </button>
          <div style={styles.titleText}>Tools</div>
          <div style={{ width: 60 }} />
        </div>
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
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(3px)',
    WebkitBackdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  window: {
    width: 'min(900px, 92%)',
    height: 'min(620px, 88%)',
    background: C.bg,
    border: `1px solid ${C.border2}`,
    borderRadius: 10,
    boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  titleBar: {
    height: 40, flexShrink: 0, display: 'flex', alignItems: 'center',
    borderBottom: `1px solid ${C.border}`, padding: '0 12px',
  },
  closeBtn: {
    width: 24, height: 24, borderRadius: '50%', border: 'none',
    background: 'transparent', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeDot: { width: 12, height: 12, borderRadius: '50%', background: C.red },
  titleText: { flex: 1, textAlign: 'center', color: C.fg, fontSize: 13, fontWeight: 600 },
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
