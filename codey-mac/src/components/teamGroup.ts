import type { ChatMessage } from '../types'
import { parseTeamMessage } from './teamMessageFormat'

export type RenderItem = { kind: 'single'; message: ChatMessage }

/** Keep worker messages in the shared transcript. Only suppress a generated
 * combined transcript when its individual worker messages already exist.
 * Questions, errors, and distinct Advisor responses must remain visible. */
export function groupMessages(messages: ChatMessage[]): RenderItem[] {
  return messages.flatMap(message => {
    if (message.teamFinal) return [{ kind: 'single' as const, message }]
    if (!message.teamTurnId || message.worker || message.role !== 'assistant' || message.userQuestion || message.choices?.length) return [{ kind: 'single' as const, message }]
    const workers = messages.filter(m => m.teamTurnId === message.teamTurnId && m.worker)
    if (!workers.length) return [{ kind: 'single' as const, message }]
    if (message.content.trim() && workers.some(m => m.content.trim() === message.content.trim())) return []
    const parsed = parseTeamMessage(message.content)
    if (parsed && parsed.steps.every(step => workers.some(m => m.worker === step.worker && m.content.trim() === step.output.trim()))) {
      return parsed.summary ? [{ kind: 'single' as const, message: { ...message, content: parsed.summary } }] : []
    }
    return [{ kind: 'single' as const, message }]
  })
}
