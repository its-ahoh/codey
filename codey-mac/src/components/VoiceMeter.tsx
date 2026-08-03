import React from 'react'

/**
 * Five bars driven by the live audio level, shared by the floating capsule
 * and the in-composer indicator so both read the same way.
 *
 * The bars follow real sound rather than a canned animation: a meter that
 * moves identically whether or not you're speaking tells you nothing, and
 * looks broken next to the system's own meters.
 *
 * `level` is 0..1 (RMS x6, clamped — see useChatVoice). When there's nothing
 * to meter (transcribing, or the system voice, which can't be tapped) pass
 * `idle` for a slow resting pulse instead of a dead flat line.
 */
interface Props {
  level: number
  /** Resting animation for states with no measurable signal. */
  idle?: boolean
  height?: number
  color?: string
}

// Outer bars respond less than the centre ones, which reads as a meter
// rather than five copies of the same bar.
const WEIGHTS = [0.45, 0.75, 1, 0.75, 0.45]

export const VoiceMeter: React.FC<Props> = ({ level, idle = false, height = 18, color = '#fff' }) => {
  const min = Math.max(3, Math.round(height * 0.22))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, height }}>
      {WEIGHTS.map((weight, i) => (
        <span
          key={i}
          className={idle ? 'codey-voice-bar-idle' : undefined}
          style={{
            display: 'block',
            width: 3,
            borderRadius: 2,
            background: color,
            height: idle ? min : Math.round(min + (height - min) * Math.min(1, level * weight * 1.6)),
            opacity: idle ? 0.75 : 0.8 + Math.min(0.2, level * weight),
            // Fast enough to feel live, slow enough not to strobe at 20 Hz.
            transition: idle ? undefined : 'height 70ms linear, opacity 70ms linear',
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
      <style>{CSS}</style>
    </div>
  )
}

const CSS = `
@keyframes codey-voice-idle {
  0%, 100% { transform: scaleY(1);   opacity: 0.55; }
  50%      { transform: scaleY(2.1); opacity: 0.9; }
}
.codey-voice-bar-idle {
  animation: codey-voice-idle 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .codey-voice-bar-idle { animation: none; }
}
`
