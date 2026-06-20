import type { ChatMessage } from '../types'

export type RenderItem =
  | { kind: 'single'; message: ChatMessage }
  | { kind: 'team'; teamTurnId: string; teamName?: string; teamMode?: ChatMessage['teamMode']; messages: ChatMessage[] }

/** Collapse consecutive assistant messages sharing a teamTurnId into one team
 *  block; everything else passes through as a single. */
export function groupMessages(messages: ChatMessage[]): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    const ttid = msg.teamTurnId
    if (ttid) {
      const group: ChatMessage[] = []
      while (i < messages.length && messages[i].teamTurnId === ttid) { group.push(messages[i]); i++ }
      out.push({ kind: 'team', teamTurnId: ttid, teamName: group[0].teamName, teamMode: group[0].teamMode, messages: group })
    } else {
      out.push({ kind: 'single', message: msg })
      i++
    }
  }
  return out
}
