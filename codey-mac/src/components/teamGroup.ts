import type { ChatMessage } from '../types'
import { parseTeamMessage } from './teamMessageFormat'

export type RenderItem = { kind: 'single'; message: ChatMessage }

/** Show bot messages once their work starts, keeping pending roster stubs
 * out of the transcript. Suppress a generated combined transcript only when
 * its individual bot messages already exist.
 * Questions, errors, and distinct Advisor responses must remain visible. */
export function groupMessages(messages: ChatMessage[]): RenderItem[] {
  return messages.flatMap(message => {
    if (message.teamFinal) return [{ kind: 'single' as const, message }]
    if (message.teamTurnId && message.bot && message.botStatus === 'pending') return []
    if (!message.teamTurnId || message.bot || message.role !== 'assistant' || message.userQuestion || message.choices?.length) return [{ kind: 'single' as const, message }]
    const bots = messages.filter(m => m.teamTurnId === message.teamTurnId && m.bot)
    if (!bots.length) return [{ kind: 'single' as const, message }]
    if (message.content.trim() && bots.some(m => m.content.trim() === message.content.trim())) return []
    const parsed = parseTeamMessage(message.content)
    if (parsed && parsed.steps.every(step => bots.some(m => m.bot === step.bot && m.content.trim() === step.output.trim()))) {
      return parsed.summary ? [{ kind: 'single' as const, message: { ...message, content: parsed.summary } }] : []
    }
    return [{ kind: 'single' as const, message }]
  })
}
