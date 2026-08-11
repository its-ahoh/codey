import React from 'react'
import { C } from '../theme'

/** The live status word ("Thinking", "Reading", …). The motion is a light
 *  sweeping across the letters — no marching dots beside it, so the word alone
 *  carries "still running" without pulling the eye off the transcript.
 *  Shared by the main chat transcript and the Quick Question side-thread so
 *  both surfaces report activity the same way. */
export const ShimmerStatus: React.FC<{ label: string; fontSize?: number }> = ({ label, fontSize }) => (
  <>
    <style>{`
      @keyframes codey-status-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .codey-status-shimmer { animation: none !important; }
      }
    `}</style>
    <span
      className="codey-status-shimmer"
      aria-live="polite"
      style={{
        backgroundImage: `linear-gradient(90deg, ${C.fg3} 0%, ${C.fg3} 35%, ${C.fg} 50%, ${C.fg3} 65%, ${C.fg3} 100%)`,
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        animation: 'codey-status-shimmer 2s linear infinite',
        fontWeight: 600,
        ...(fontSize ? { fontSize } : null),
      }}
    >
      {label}
    </span>
  </>
)
