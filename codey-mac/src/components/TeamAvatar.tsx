import { BotAvatar } from './BotAvatar'
import type { AvatarState, BotAvatarConfig } from './botAvatarModel'
import { UIIcon } from './UIIcons'
import { C } from '../theme'

// Use member order so the same team keeps the same visual identity everywhere.
export function TeamAvatar({ name, members, bots, size = 34, state = 'idle' }: {
  name: string
  members: readonly string[]
  bots: readonly { name: string; config: { avatar?: Partial<BotAvatarConfig> } }[]
  size?: number
  state?: AvatarState
}) {
  const visible = [...new Map(members.filter(Boolean).map(member => [member.toLowerCase(), member])).values()].slice(0, 4)
  const positions = visible.length === 2 ? [[0, 0], [0.36, 0.36]]
    : visible.length === 3 ? [[0.25, 0], [0, 0.48], [0.5, 0.48]]
    : [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]
  const faceSize = size * (visible.length === 1 ? 1 : visible.length === 2 ? 0.64 : 0.5)
  return <span role="img" aria-label={`${name}: ${members.length} Bots`} style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0, verticalAlign: 'middle' }}>
    {visible.length === 0 ? <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', width: size, height: size, borderRadius: size * 0.28, background: C.accentDim, color: C.accent }}><UIIcon name="users" size={size * 0.55} /></span>
      : visible.map((member, index) => <span key={member.toLowerCase()} aria-hidden="true" style={{ position: 'absolute', display: 'flex', left: size * positions[index][0], top: size * positions[index][1] }}>
        <BotAvatar name={member} config={bots.find(bot => bot.name.toLowerCase() === member.toLowerCase())?.config.avatar} size={faceSize} state={state} />
      </span>)}
  </span>
}
