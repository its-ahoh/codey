import type { ReactNode } from 'react'
import { C } from '../theme'
export const MEMBER_REPLY_LIMIT = 2400
export function memberReplyIsLong(content: string): boolean { return content.length > MEMBER_REPLY_LIMIT }
/** Native disclosure preserves the user's open choice during streaming. */
export function MemberReply({ content, children }: { content: string; children: ReactNode }) {
  if (!memberReplyIsLong(content)) return <>{children}</>
  return <details style={{ width: '100%' }}>
    <summary style={{ cursor: 'pointer', color: C.fg2 }}>
      <span>{content.replace(/\s+/g, ' ').slice(0, 280)}…</span>
      <span style={{ display: 'block', color: C.fg3, fontSize: 11 }}>Expand full reply</span>
    </summary>
    {children}
  </details>
}
