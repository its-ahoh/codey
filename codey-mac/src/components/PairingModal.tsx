import React, { useEffect, useState } from 'react'
import { apiService } from '../services/api'
import { C } from '../theme'

export interface PairingModalProps {
  channel: 'telegram' | 'discord' | 'imessage'
  onClose: () => void
}

export function PairingModal({ channel, onClose }: PairingModalProps) {
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiService.startPairing(channel)
      .then(c => { if (!cancelled) setCode(c) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [channel])

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <h3 style={styles.title}>Pair with {channel}</h3>
        {error && <p style={styles.error}>{error}</p>}
        {!error && !code && <p style={styles.hint}>Generating code…</p>}
        {code && (
          <>
            {channel === 'imessage' ? (
              <p>From another Apple device, send an iMessage to this Mac's Apple&nbsp;ID with the command:</p>
            ) : (
              <p>On your {channel} app, send this command to the bot:</p>
            )}
            <pre style={styles.code}>/pair {code}</pre>
            {channel === 'imessage' && (
              <p style={styles.hint}>
                Make sure your phone number or Apple&nbsp;ID is listed in Allowed Senders (Settings → Channels → iMessage → Configure).
              </p>
            )}
            <p style={styles.hint}>Code expires in 5 minutes.</p>
          </>
        )}
        <button style={styles.close} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: C.bg,
    color: C.fg,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: 24,
    minWidth: 320,
    maxWidth: 480,
  },
  title: { margin: '0 0 12px 0' },
  hint: { color: C.fg2, fontSize: 12 },
  error: { color: C.red },
  code: {
    background: C.surface2,
    padding: '8px 12px',
    borderRadius: 4,
    fontSize: 16,
    letterSpacing: 1,
    margin: '8px 0',
  },
  close: {
    marginTop: 12,
    padding: '6px 12px',
    background: C.accent,
    color: C.fg,
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
  },
}
