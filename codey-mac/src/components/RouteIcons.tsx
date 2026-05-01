import React from 'react'
import type { ChatRoute } from '../types'

const ICON: Record<ChatRoute['channel'], string> = {
  telegram: '✈️',
  discord: '💬',
  imessage: '💙',
}

export function RouteIcons({ routes }: { routes?: ChatRoute[] }) {
  if (!routes || routes.length === 0) return null
  return (
    <span style={styles.row} aria-label="linked channels">
      {routes.map((r, i) => (
        <span key={`${r.channel}-${i}`} title={`${r.channel}: ${r.channelUserId}`} style={styles.icon}>
          {ICON[r.channel]}
        </span>
      ))}
    </span>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'inline-flex', gap: 2, marginLeft: 6, fontSize: 11 },
  icon: { lineHeight: 1 },
}
