import React from 'react'
import { C } from '../theme'
import { UIIcon, type IconName } from './UIIcons'
import { UpdateButton } from './UpdateButton'

export interface SidebarCommonProps {
  onOpenSettings: (tab?: string) => void
  onOpenAutomations: () => void
  onOpenTools: () => void
  automationsUnseenCount: number
  /** The Bots / Workspaces switch; each panel places it above its own list. */
  modeTabs: React.ReactNode
}

export function SidebarAction({ icon, children, badge, hint, ...buttonProps }: {
  icon: IconName; children: React.ReactNode; badge?: number; hint?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'>) {
  return <button {...buttonProps} type="button" className="sidebar-row" style={styles.action}>
    <UIIcon name={icon} size={16} />
    <span style={styles.actionLabel}>{children}</span>
    {!!badge && badge > 0 && <span style={styles.trailing}>{badge > 9 ? '9+' : badge}</span>}
    {hint && <span style={styles.trailing}>{hint}</span>}
  </button>
}

export function SidebarSearch(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style' | 'type'>) {
  return <label className="sidebar-row" style={styles.search}>
    <UIIcon name="search" size={16} />
    <input {...props} type="search" style={styles.searchInput} />
  </label>
}

export function SidebarFooter({ onOpenSettings, onOpenAutomations, onOpenTools, automationsUnseenCount }: Omit<SidebarCommonProps, 'modeTabs'>) {
  return <div style={styles.section}>
    <UpdateButton />
    <SidebarAction icon="activity" onClick={onOpenAutomations} badge={automationsUnseenCount}>Automations</SidebarAction>
    <SidebarAction icon="tools" onClick={onOpenTools} title="Skills & playbooks">Tools</SidebarAction>
    <SidebarAction icon="settings" onClick={() => onOpenSettings()}>Settings</SidebarAction>
  </div>
}

const styles: Record<string, React.CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 },
  action: {
    width: '100%', minHeight: 30, padding: '0 8px', border: 'none', background: 'transparent', color: C.fg2,
    cursor: 'pointer', textAlign: 'left', borderRadius: 8, fontSize: 13, flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 8,
  },
  actionLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  trailing: { color: C.fg3, fontSize: 12, flexShrink: 0 },
  search: {
    width: '100%', minHeight: 30, padding: '0 8px', color: C.fg2, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'text',
  },
  searchInput: { flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: C.fg, fontFamily: 'inherit', fontSize: 13, padding: 0 },
}
