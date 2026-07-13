import React from 'react'
import GlobalTeamsSection from './GlobalTeamsSection'
import { UIIcon } from './UIIcons'
import { C } from '../theme'

export const TeamsTab: React.FC = () => {
  return (
    <div style={styles.root}>
      <div style={styles.hero}>
        <span style={styles.heroIcon}><UIIcon name="users" size={20} /></span>
        <div><div style={styles.title}>Team library</div><div style={styles.subtitle}>Compose specialist workers into reusable delivery teams.</div></div>
      </div>
      <GlobalTeamsSection />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { padding: '24px', height: '100%', overflowY: 'auto', background: C.bg },
  hero: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 },
  heroIcon: { width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent, border: `1px solid ${C.accent}` },
  title: { color: C.fg, fontSize: 18, fontWeight: 750, letterSpacing: '-0.02em' },
  subtitle: { color: C.fg3, fontSize: 12, marginTop: 3 },
}
