import React, { useEffect, useState } from 'react'

/**
 * The floating capsule shown while a spoken conversation is in progress.
 *
 * Lives in its own always-on-top window rather than inside the main window,
 * because the whole point of the converse hotkey is that it works while
 * Codey is in the background — a pill drawn inside the app would be
 * invisible exactly when it matters.
 *
 * The capsule *is* the moving gradient: a conversation is ongoing and
 * two-way, and should feel alive rather than like a recording light. That
 * also keeps it distinct from dictation, whose pill stays plain.
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

  // index.html paints the theme background onto <html> before React mounts so
  // the app's first frame isn't white-on-white. In a transparent window that
  // shows up as a black rectangle around the capsule, so undo it here.
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  if (state === 'hidden') return null

  return (
    <div style={styles.root}>
      <div className="codey-voice-capsule" style={styles.capsule}>
        <Bars state={state} />
        <span style={styles.label}>{LABEL[state]}</span>
      </div>
      <style>{CSS}</style>
    </div>
  )
}

/**
 * Five bars whose heights animate out of phase, faster while speaking than
 * while listening, so the capsule reads differently at a glance depending on
 * who currently holds the turn.
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
    background: 'transparent', overflow: 'hidden',
    WebkitUserSelect: 'none', cursor: 'default',
  },
  capsule: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 18px', borderRadius: 999,
    // No dark plate behind it: the gradient itself is the surface.
    boxShadow: '0 6px 22px rgba(0,0,0,0.28)',
  },
  bars: { display: 'flex', alignItems: 'center', gap: 3, height: 18 },
  label: {
    color: '#fff', fontSize: 12, fontWeight: 600,
    letterSpacing: 0.2, whiteSpace: 'nowrap',
    textShadow: '0 1px 2px rgba(0,0,0,0.28)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  },
}

const CSS = `
@keyframes codey-voice-drift {
  0%   { background-position:   0% 50%; }
  100% { background-position: 200% 50%; }
}
@keyframes codey-voice-bounce {
  0%, 100% { height: 5px; opacity: 0.7; }
  50%      { height: 17px; opacity: 1; }
}
.codey-voice-capsule {
  background-image: linear-gradient(90deg,
    #ff5f6d, #ffc371, #47e6b1, #38a3f5, #a86bf5, #ff5f6d);
  background-size: 200% 100%;
  animation: codey-voice-drift 4s linear infinite;
}
.codey-voice-bar {
  display: block;
  width: 3px;
  border-radius: 2px;
  background: rgba(255,255,255,0.95);
  animation-name: codey-voice-bounce;
  animation-iteration-count: infinite;
  animation-timing-function: ease-in-out;
}
@media (prefers-reduced-motion: reduce) {
  .codey-voice-capsule { animation: none; }
  .codey-voice-bar { animation: none; height: 11px; }
}
`
