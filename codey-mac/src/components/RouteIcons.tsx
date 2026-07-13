import React from 'react'
import type { ChatRoute } from '../types'

const ChannelIcon: React.FC<{ channel: ChatRoute['channel'] }> = ({ channel }) => {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (channel === 'telegram') return <svg viewBox="0 0 24 24" width="13" height="13"><path {...common} d="M21 4L3.6 10.6l6.7 2.3L13 19l2.1-7.4L21 4zM10.3 12.9L15.1 8" /></svg>
  if (channel === 'discord') return <svg viewBox="0 0 24 24" width="13" height="13"><path {...common} d="M6 18c-1.2-1.5-2-4-2-6.5C4 7.9 6.7 6 12 6s8 1.9 8 5.5c0 2.5-.8 5-2 6.5l-2.3-1.1a8.7 8.7 0 01-7.4 0L6 18zM9 12h.01M15 12h.01" /><path {...common} d="M8.2 7.2L7.4 5M15.8 7.2l.8-2.2" /></svg>
  return <svg viewBox="0 0 24 24" width="13" height="13"><path {...common} d="M20 11.5a7.5 7.5 0 01-8 7.5 8.7 8.7 0 01-3.3-.65L4 20l1.55-3.9A7.3 7.3 0 014 11.5 7.5 7.5 0 0112 4a7.5 7.5 0 018 7.5z" /><path {...common} d="M8 12h.01M12 12h.01M16 12h.01" /></svg>
}

const COLOR: Record<ChatRoute['channel'], string> = { telegram: '#2AABEE', discord: '#7289DA', imessage: '#34C759' }

export function RouteIcons({ routes }: { routes?: ChatRoute[] }) {
  if (!routes || routes.length === 0) return null
  return (
    <span style={styles.row} aria-label="linked channels">
      {routes.map((r, i) => (
        <span key={`${r.channel}-${i}`} title={`${r.channel}: ${r.channelUserId}`} style={{ ...styles.icon, color: COLOR[r.channel] }}>
          <ChannelIcon channel={r.channel} />
        </span>
      ))}
    </span>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'inline-flex', gap: 3, marginLeft: 6 },
  icon: { lineHeight: 1, width: 18, height: 18, display: 'grid', placeItems: 'center', borderRadius: 5, background: 'var(--surface3)', color: 'var(--fg2)' },
}
