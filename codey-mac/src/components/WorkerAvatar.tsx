import { resolveWorkerAvatar, avatarStateLabels, type AvatarState, type WorkerAvatarConfig } from './workerAvatarModel'
import './workerAvatar.css'

export function WorkerAvatar({ name, config, state = 'idle', size = 36 }: {
  name: string; config?: Partial<WorkerAvatarConfig>; state?: AvatarState; size?: number
}) {
  const { shape, color } = resolveWorkerAvatar(name, config)
  return <svg className={`worker-avatar worker-avatar--${state}`} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${name}: ${avatarStateLabels[state]}`} style={{ flexShrink: 0 }}>
    {shape === 'circle' && <circle cx="50" cy="50" r="45" fill={color} />}
    {shape === 'square' && <rect x="5" y="5" width="90" height="90" rx="25" fill={color} />}
    {shape === 'capsule' && <rect x="4" y="15" width="92" height="70" rx="35" fill={color} />}
    {shape === 'triangle' && <path d="M43 12 Q50 0 57 12 L94 79 Q102 94 85 94 H15 Q-2 94 6 79 Z" fill={color} />}
    <g transform={shape === 'triangle' ? 'translate(0 10)' : undefined}>
      {state === 'done' ? <g fill="none" stroke="#34434A" strokeWidth="5" strokeLinecap="round"><path d="M25 53 Q34 39 43 53"/><path d="M57 53 Q66 39 75 53"/></g> :
        <g className="worker-avatar-eyes">
          {[34, 66].map((x, i) => <g key={x} transform={state === 'reply' && i === 1 ? 'translate(0 -5)' : undefined}>
            <ellipse cx={x} cy="49" rx="12" ry={state === 'working' ? 11 : state === 'failed' ? 9 : 16} fill="#FFFDF8"/>
            <ellipse className="worker-avatar-pupil" cx={x + (state === 'reply' ? 2 : 0)} cy={state === 'failed' ? 53 : 50} rx="5" ry="6" fill="#34434A"/>
            {state === 'failed' && <path d={`M${x - 11} 42 L${x + 10} 47`} stroke={color} strokeWidth="7"/>}
          </g>)}
        </g>}
    </g>
  </svg>
}
