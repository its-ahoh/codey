import React, { useEffect, useState } from 'react'

/**
 * The floating capsule shown while a spoken conversation is in progress.
 *
 * Lives in its own always-on-top window rather than inside the main window,
 * because the whole point of the converse hotkey is that it works while
 * Codey is in the background — a pill drawn inside the app would be
 * invisible exactly when it matters.
 *
 * The animated gradient is what separates this from plain dictation: a
 * conversation is ongoing and two-way, and it should feel alive rather than
 * like a recording indicator that happens to be red.
 */

type HudState = 'recording' | 'transcribing' | 'speaking' | 'hidden'

const LABEL: Record<Exclude<HudState, 'hidden'>, string> = {
  recording: 'Listening…',
  transcribing: 'Thinking…',
  speaking: 'Speaking…',
}

export const VoiceHud: React.FC = () => {
  const [state, setState] = useState<HudState>('recording')

  useEffect(() => window.codey.voice.onHudState(next => setState(next as HudState)), [])

  if (state === 'hidden') return null

  return (
    <div style={styles.root}>
      <div style={styles.capsule}>
        <div style={styles.aura} />
        <div style={styles.content}>
          <Bars state={state} />
          <span style={styles.label}>{LABEL[state]}</span>
        </div>
      </div>
      <style>{CSS}</style>
    </div>
  )
}

/**
 * Five bars whose heights animate out of phase. While speaking they run
 * faster and taller, so the capsule reads differently at a glance depending
 * on who currently holds the turn.
 */
const Bars: React.FC<{ state: Exclude<HudState, 'hidden'> }> = ({ state }) => {
  const speed = state === 'speaking' ? 0.7 : state === 'recording' ? 1.1 : 1.8
  return (
    <div style={styles.bars}>
      {[0, 1, 2, 3, 4].map(i => (
        <span
          key={i}
          className="codey-voice-bar"
          style={{
            animationDuration: `${speed}s`,
            animationDelay: `${i * 0.12}s`,
            // Transcribing is a waiting state — keep it calm and low.
            height: state === 'transcribing' ? 5 : undefined,
          }}
        />
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100vh', width: '100vw', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    // The window itself is transparent; only the capsule paints.
    background: 'transparent', overflow: 'hidden',
    // The capsule is a status readout, not a control — never eat clicks
    // meant for whatever the user is actually working in.
    WebkitUserSelect: 'none', cursor: 'default',
  },
  capsule: {
    position: 'relative', display: 'flex', alignItems: 'center',
    padding: '10px 18px', borderRadius: 999, overflow: 'hidden',
    background: 'rgba(20,20,22,0.82)',
    backdropFilter: 'blur(20px)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
  },
  aura: {
    position: 'absolute', inset: -2, borderRadius: 999,
    background: 'conic-gradient(from 0deg, #ff5f6d, #ffc371, #47e6b1, #38a3f5, #a86bf5, #ff5f6d)',
    filter: 'blur(9px)', opacity: 0.75,
    animation: 'codey-voice-spin 3.2s linear infinite',
  },
  content: {
    position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
    padding: '2px 4px',
  },
  bars: { display: 'flex', alignItems: 'center', gap: 3, height: 18 },
  label: {
    color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: 600,
    letterSpacing: 0.2, whiteSpace: 'nowrap',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  },
}

const CSS = `
@keyframes codey-voice-spin { to { transform: rotate(360deg); } }
@keyframes codey-voice-bounce {
  0%, 100% { height: 5px; opacity: 0.65; }
  50%      { height: 17px; opacity: 1; }
}
.codey-voice-bar {
  display: block;
  width: 3px;
  border-radius: 2px;
  background: #fff;
  animation-name: codey-voice-bounce;
  animation-iteration-count: infinite;
  animation-timing-function: ease-in-out;
}
@media (prefers-reduced-motion: reduce) {
  .codey-voice-bar { animation: none; height: 11px; }
}
`
