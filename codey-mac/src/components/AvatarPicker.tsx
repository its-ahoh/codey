import { WorkerAvatar } from './WorkerAvatar'
import { avatarShapes, avatarColors, type WorkerAvatarConfig } from './workerAvatarModel'
import { C } from '../theme'
export function AvatarPicker({ value, onChange }: { value: WorkerAvatarConfig; onChange: (avatar: WorkerAvatarConfig) => void }) {
  return <>
    <p>Shape</p>
    <div style={{ display: 'flex', gap: 8 }}>
      {avatarShapes.map(shape => <button type="button" key={shape} aria-label={shape} aria-pressed={value.shape === shape} onClick={() => onChange({ ...value, shape })}
        style={{ background: C.surface2, border: `2px solid ${value.shape === shape ? C.accent : C.border}`, borderRadius: 10, padding: 5, cursor: 'pointer' }}>
        <WorkerAvatar name={shape} config={{ ...value, shape }} size={44} />
      </button>)}
    </div>
    <p>Color</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {avatarColors.map(color => <button type="button" key={color} aria-label={`Color ${color}`} aria-pressed={value.color === color} onClick={() => onChange({ ...value, color })}
        style={{ width: 28, height: 28, background: color, border: `3px solid ${value.color === color ? C.fg : 'transparent'}`, borderRadius: '50%', cursor: 'pointer' }} />)}
    </div>
  </>
}
