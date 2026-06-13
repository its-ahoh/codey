import React from 'react'
import { C } from '../theme'
import { coreBannerText } from './coreOfflineView'
import type { CoreState } from '../../electron/core-state'

export const CoreOfflineBanner: React.FC<{
  state: CoreState
  onRelaunch: () => void
}> = ({ state, onRelaunch }) => {
  const text = coreBannerText(state)
  if (!text) return null
  return (
    <div style={styles.banner}>
      <span style={styles.text} title={text}>⚠️ {text}</span>
      <button type="button" onClick={onRelaunch} style={styles.button}>
        Relaunch App
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 14px', flexShrink: 0,
    background: C.dangerBg, borderBottom: `1px solid ${C.dangerBorder}`,
    color: C.dangerFg, fontSize: 12,
  },
  text: {
    flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  button: {
    background: 'transparent', border: `1px solid ${C.dangerBorder}`,
    color: C.dangerFg, borderRadius: 5, padding: '3px 10px',
    fontSize: 12, cursor: 'pointer', flexShrink: 0,
  },
}
