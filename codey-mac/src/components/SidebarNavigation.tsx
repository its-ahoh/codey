import React from 'react'
import { C } from '../theme'
import { UIIcon, type IconName } from './UIIcons'
import { UpdateButton } from './UpdateButton'

export interface SidebarNavigationProps {
  onOpenAutomations: () => void
  onOpenBrowser: () => void
  onOpenTools: () => void
  automationsUnseenCount: number
}
export interface SidebarCommonProps extends SidebarNavigationProps {
  onOpenSettings: (tab?: string) => void
}

export function SidebarAction({ icon, children, badge, ...buttonProps }: {
  icon: IconName; children: React.ReactNode; badge?: number
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'>) {
  return <button {...buttonProps} type="button" style={styles.action}>
    <UIIcon name={icon} size={15} />
    <span>{children}</span>
    {!!badge && badge > 0 && <span style={styles.badge}>{badge > 9 ? '9+' : badge}</span>}
  </button>
}

function SidebarSection({ children }: { children: React.ReactNode }) {
  return <div style={styles.section}>{children}</div>
}

export function SidebarNavigation({ onOpenAutomations, onOpenBrowser, onOpenTools, automationsUnseenCount }: SidebarNavigationProps) {
  return <SidebarSection>
    <SidebarAction icon="activity" onClick={onOpenAutomations} badge={automationsUnseenCount}>Automations</SidebarAction>
    <SidebarAction icon="globe" onClick={onOpenBrowser} title="Browse the web in Codey">Browser</SidebarAction>
    <SidebarAction icon="tools" onClick={onOpenTools} title="Skills & playbooks">Tools</SidebarAction>
  </SidebarSection>
}

export function SidebarFooter({ onOpenSettings, children }: {
  onOpenSettings: () => void; children?: React.ReactNode
}) {
  return <SidebarSection>
    <UpdateButton />
    {children}
    <SidebarAction icon="settings" onClick={() => onOpenSettings()}>Settings</SidebarAction>
  </SidebarSection>
}

const styles: Record<string, React.CSSProperties> = {
  section: { padding: 8, borderRadius: 12, background: C.surface2, border: `1px solid ${C.sidebarBorder}`, display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 },
  action: {
    width: '100%', minHeight: 30, padding: '4px 8px', border: 'none', background: 'transparent', color: C.fg2,
    cursor: 'pointer', textAlign: 'left', borderRadius: 7, fontSize: 12,
    display: 'flex', alignItems: 'center', gap: 8,
  },
  badge: {
    marginLeft: 'auto', minWidth: 16, height: 16, padding: '0 4px',
    borderRadius: 8, background: '#E5484D', color: '#fff',
    fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
  },
}
