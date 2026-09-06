import type { ChatMessage } from '../types'

import { avatarShapes, avatarColors } from '../../../packages/core/src/member-avatars'
export { avatarShapes, avatarColors, builtinAvatar } from '../../../packages/core/src/member-avatars'
export type { MemberAvatar as WorkerAvatarConfig } from '../../../packages/core/src/member-avatars'
import type { MemberAvatar as WorkerAvatarConfig } from '../../../packages/core/src/member-avatars'
export type AvatarState = 'waiting' | 'working' | 'reply' | 'done' | 'failed' | 'idle' | 'stopped'
export const avatarStateLabels: Record<AvatarState, string> = {
  waiting: 'Waiting', working: 'Working', reply: 'Waiting for your reply', done: 'Completed',
  failed: 'Failed', idle: 'Not participating', stopped: 'Stopped',
}
export function resolveWorkerAvatar(name: string, config?: Partial<WorkerAvatarConfig>): WorkerAvatarConfig {
  const hash = Array.from(name.toLowerCase()).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0)
  return {
    shape: avatarShapes.includes(config?.shape as any) ? config!.shape! : avatarShapes[hash % avatarShapes.length],
    color: avatarColors.includes(config?.color as any) ? config!.color! : avatarColors[hash % avatarColors.length],
  }
}
export function workerAvatarState(message: ChatMessage, active: boolean): AvatarState {
  if (message.teamFinal) return message.teamFinal.outcome === 'stopped' ? 'stopped' : message.teamFinal.outcome === 'failed' ? 'failed' : message.teamFinal.outcome === 'completed' ? 'done' : 'idle'
  if (message.workerStatus === 'failed') return 'failed'
  if (message.workerStatus === 'askedUser' || message.userQuestion) return 'reply'
  if (message.workerStatus === 'done') return 'done'
  if (message.workerStatus === 'pending') return active ? 'waiting' : 'idle'
  if (message.workerStatus === 'running') return active ? 'working' : 'stopped'
  return active ? 'working' : message.isComplete === false ? 'stopped' : 'done'
}
