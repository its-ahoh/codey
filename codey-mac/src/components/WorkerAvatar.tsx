import { resolveWorkerAvatar, avatarStateLabels, type AvatarState, type WorkerAvatarConfig } from './workerAvatarModel'
import './workerAvatar.css'

export function WorkerAvatar({ name, config, state = 'idle', size = 36 }: {
  name: string; config?: Partial<WorkerAvatarConfig>; state?: AvatarState; size?: number
}) {
  const { shape, color } = resolveWorkerAvatar(name, config)
  const resting = state === 'idle' || state === 'stopped'
  return <svg className={`worker-avatar worker-avatar--${state}`} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${name}: ${avatarStateLabels[state]}`} style={{ flexShrink: 0 }}>
    <g className="worker-avatar-body">
      {shape === 'circle' && <path d="M50 7 C76 5 94 27 94 53 C94 80 75 94 49 93 C22 95 6 78 6 53 C5 27 23 8 50 7Z" fill={color} />}
      {shape === 'square' && <path d="M29 9 Q50 6 72 9 Q90 11 91 30 L93 70 Q92 90 72 92 L29 92 Q8 91 8 71 L9 31 Q9 11 29 9Z" fill={color} />}
      {shape === 'capsule' && <path d="M36 18 L64 18 C84 18 96 31 96 51 C96 73 82 84 62 84 L37 84 C16 84 4 72 4 51 C4 31 17 18 36 18Z" fill={color} />}
      {shape === 'triangle' && <path d="M39 16 Q50 -1 62 17 L90 66 Q107 92 77 94 L23 94 Q-6 92 10 67Z" fill={color} />}
      <g transform={shape === 'triangle' ? 'translate(0 9)' : undefined}>
        {state === 'done' ? <g fill="none" stroke="#303C42" strokeWidth="5" strokeLinecap="round"><path d="M23 50 Q33 36 42 50"/><path d="M58 50 Q67 36 77 50"/></g> :
          state === 'failed' ? <g>
            <path d="M22 51 Q34 54 46 44 C46 65 22 65 22 51Z" fill="#FFFDF5"/>
            <path d="M54 44 Q66 54 78 51 C78 65 54 65 54 44Z" fill="#FFFDF5"/>
            <ellipse cx="35" cy="56" rx="4.5" ry="4" fill="#303C42"/>
            <ellipse cx="65" cy="56" rx="4.5" ry="4" fill="#303C42"/>
          </g> :
          <g className="worker-avatar-eyes">
            {[34, 66].map((x, i) => <g key={x} transform={state === 'reply' && i === 1 ? 'translate(0 -6)' : undefined}>
              {state === 'waiting' ? <>
                <path d={`M${x - 10} 51 Q${x} 56 ${x + 10} 51`} fill="none" stroke="#303C42" strokeWidth="5" strokeLinecap="round"/>
              </> : state === 'working' ? <>
                <path d={i === 0 ? `M${x - 12} 39 L${x + 12} 45 C${x + 12} 65 ${x - 12} 65 ${x - 12} 39Z` : `M${x - 12} 45 L${x + 12} 39 C${x + 12} 65 ${x - 12} 65 ${x - 12} 45Z`} fill="#FFFDF5"/>
                <ellipse className="worker-avatar-pupil" cx={x + (i === 0 ? 2 : -2)} cy="51" rx="5" ry="7" fill="#303C42"/>
              </> : <>
                <ellipse cx={x} cy="48" rx="12" ry={resting ? 12 : 16} fill="#FFFDF5"/>
                <ellipse cx={x + (state === 'reply' ? 3 : 0)} cy={resting ? 51 : 49} rx="5.5" ry={resting ? 6 : 8} fill="#303C42"/>
              </>}

            </g>)}
          </g>}
        {state === 'waiting' && <path className="worker-avatar-sleep-bubble"
          d="M51 59 C54 60 55 64 57 66 C61 69 69 66 69 61 C69 55 62 53 58 56 C55 58 53 59 51 59Z"
          fill="#FFFDF5" fillOpacity=".65" stroke="#FFFDF5" strokeWidth="1.5" />}
      </g>
    </g>
  </svg>
}
