import React from 'react'

export type IconName =
  | 'activity' | 'add' | 'archive' | 'bell' | 'bot' | 'chat' | 'check' | 'chevron' | 'close' | 'disclosure'
  | 'code' | 'copy' | 'folder' | 'folder-open' | 'key' | 'link' | 'mic' | 'more' | 'panel' | 'panel-bottom' | 'panel-right' | 'play' | 'plus'
  | 'globe' | 'overview' | 'refresh' | 'server' | 'settings' | 'sparkle' | 'split' | 'terminal' | 'tools' | 'trash' | 'users' | 'workspace'
  | 'telegram' | 'discord' | 'imessage'

interface Props {
  name: IconName
  size?: number
  strokeWidth?: number
  filled?: boolean
  color?: string
}

/** Small, neutral SVG icons used by the app shell. Keeping them in one place
 * avoids the inconsistent emoji rendering that made navigation harder to scan. */
export const UIIcon: React.FC<Props> = ({ name, size = 16, strokeWidth = 1.8, filled = false, color }) => {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths: Record<IconName, React.ReactNode> = {
    activity: <><path {...common} d="M3 12h4l3-7 4 14 3-7h4" /></>,
    add: <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M12 8v8M8 12h8" /></>,
    archive: <><path {...common} d="M4 7h16v13H4zM3 4h18v3H3zM9 12h6" /></>,
    bell: <><path {...common} d="M18 9a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path {...common} d="M10 21h4" /></>,
    bot: <><rect {...common} x="4" y="7" width="16" height="13" rx="3" /><path {...common} d="M12 3v4M9 13h.01M15 13h.01M8 17h8" /><circle fill="currentColor" cx="9" cy="13" r="1" /><circle fill="currentColor" cx="15" cy="13" r="1" /></>,
    chat: <><path {...common} d="M20 11.5a7.5 7.5 0 01-8 7.5 8.7 8.7 0 01-3.3-.65L4 20l1.55-3.9A7.3 7.3 0 014 11.5 7.5 7.5 0 0112 4a7.5 7.5 0 018 7.5z" /></>,
    check: <path {...common} d="M5 12.5l4.2 4.2L19 7" />,
    chevron: <path {...common} d="M9 18l6-6-6-6" />,
    close: <path {...common} d="M6 6l12 12M18 6L6 18" />,
    disclosure: <path fill="currentColor" stroke="none" d="M9 6.5L16 12l-7 5.5z" />,
    code: <><path {...common} d="M8 9l-3 3 3 3M16 9l3 3-3 3M14 6l-4 12" /></>,
    copy: <><rect {...common} x="9" y="9" width="11" height="11" rx="2" /><path {...common} d="M5 15V5a2 2 0 012-2h10" /></>,
    folder: <path {...common} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />,
    'folder-open': <><path {...common} d="M3 18V7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v1" /><path {...common} d="M3.2 19h15.2a2 2 0 001.94-1.51l1.25-5A2 2 0 0019.65 10H8l-2 3H3" /></>,
    globe: <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></>,
    key: <><circle {...common} cx="7.5" cy="15.5" r="3.5" /><path {...common} d="M10 13l8-8M15 6l3 3M13 8l3 3" /></>,
    link: <><path {...common} d="M10 13a5 5 0 007.07.07l2-2a5 5 0 00-7.07-7.07l-1.15 1.15" /><path {...common} d="M14 11a5 5 0 00-7.07-.07l-2 2A5 5 0 0012 20l1.15-1.15" /></>,
    mic: <><rect {...common} x="8" y="3" width="8" height="12" rx="4" /><path {...common} d="M5 11a7 7 0 0014 0M12 18v3M8 21h8" /></>,
    more: <><circle fill="currentColor" cx="5" cy="12" r="1.5" /><circle fill="currentColor" cx="12" cy="12" r="1.5" /><circle fill="currentColor" cx="19" cy="12" r="1.5" /></>,
    overview: <><rect {...common} x="3" y="4" width="18" height="16" rx="2" /><path {...common} d="M3 10h18M10 10v10" /><path {...common} d="M7 7h.01M13 14h5M13 17h3" /></>,
    panel: <><rect {...common} x="3" y="3" width="18" height="18" rx="2" /><path {...common} d="M15 3v18" />{filled && <path fill="currentColor" stroke="none" d="M15 3h6v18h-6z" />}</>,
    'panel-bottom': <><rect {...common} x="3" y="3" width="18" height="18" rx="2" /><path {...common} d="M3 15h18" /><path {...common} d="M9 9l3 3 3-3" /></>,
    'panel-right': <><rect {...common} x="3" y="3" width="18" height="18" rx="2" /><path {...common} d="M15 3v18" /><path {...common} d="M9 8l3 4-3 4" /></>,
    play: <path {...common} d="M8 5l11 7-11 7z" />,
    plus: <path {...common} d="M12 5v14M5 12h14" />,
    refresh: <><path {...common} d="M20 11a8 8 0 00-14.7-4.4L3 9" /><path {...common} d="M3 4v5h5M4 13a8 8 0 0014.7 4.4L21 15" /><path {...common} d="M21 20v-5h-5" /></>,
    server: <><rect {...common} x="3" y="4" width="18" height="6" rx="2" /><rect {...common} x="3" y="14" width="18" height="6" rx="2" /><path {...common} d="M7 7h.01M7 17h.01" /></>,
    settings: <><path {...common} d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.09a2 2 0 011 1.74v.5a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.38a2 2 0 00-.73-2.73l-.15-.09a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" /><circle {...common} cx="12" cy="12" r="3" /></>,
    sparkle: <path {...common} d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16z" />,
    split: <><rect {...common} x="3" y="4" width="18" height="16" rx="2" /><path {...common} d="M12 4v16" /></>,
    terminal: <><rect {...common} x="3" y="4" width="18" height="16" rx="2" /><path {...common} d="M7 9l3 3-3 3M12.5 15H17" /></>,
    tools: <path {...common} d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94z" />,
    trash: <><path {...common} d="M4 7h16M10 11v5M14 11v5M9 7l1-3h4l1 3M6 7l1 13h10l1-13" /></>,
    users: <><path {...common} d="M16 20v-1.5a4.5 4.5 0 00-4.5-4.5h-4A4.5 4.5 0 003 18.5V20M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM17 11a3 3 0 000-6M21 20v-1.5A4.5 4.5 0 0017.5 14" /></>,
    workspace: <><rect {...common} x="3" y="4" width="18" height="16" rx="2" /><path {...common} d="M3 9h18M8 14h3" /></>,
    telegram: <><path {...common} d="M22 3L11 14M22 3l-7 18-4-8-8-4 19-6z" /></>,
    discord: <><rect {...common} x="2.5" y="7.5" width="19" height="9" rx="4.5" /><circle fill="currentColor" cx="8.5" cy="12" r="1.15" /><circle fill="currentColor" cx="15.5" cy="12" r="1.15" /></>,
    imessage: <><path {...common} d="M12 4.5c-4.7 0-8.5 3-8.5 6.7 0 2 1.1 3.8 2.9 5-.2 1.2-.8 2.3-1.7 3.3 1.7-.2 3.2-.9 4.4-1.8.9.2 1.9.3 2.9.3 4.7 0 8.5-3 8.5-6.8s-3.8-6.7-8.5-6.7z" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={color ? { color } : undefined}>{paths[name]}</svg>
}

export const CodeyMark: React.FC<{ size?: number }> = ({ size = 28 }) => (
  <div style={{ width: size, height: size, borderRadius: Math.round(size * .3), background: 'var(--accent)', color: 'var(--onAccent)', display: 'grid', placeItems: 'center', boxShadow: '0 5px 14px var(--accentDim)', flexShrink: 0 }}>
    <UIIcon name="code" size={Math.round(size * .65)} strokeWidth={2.15} />
  </div>
)
