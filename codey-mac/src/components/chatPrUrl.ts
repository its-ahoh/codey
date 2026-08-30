import type { Chat } from '../types'

/** `https://github.com/<owner>/<repo>/pull/<n>` — the shape `gh pr create`
 *  prints and the one the PR modal hands back. Trailing path segments
 *  (`/files`, `/conflicts`) and a query string are dropped so two mentions of
 *  the same PR resolve to one url. */
const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi

/** The PR this chat can prove is its own.
 *
 *  A shared checkout's branch belongs to whoever moved it last, so the branch
 *  cannot say which PR a chat delivered — and an agent that opens its PR from
 *  a scratch worktree never moves the shared branch at all. What it does do is
 *  report the url in its reply, which is evidence tied to this chat and no
 *  other. The newest mention wins: a chat that opens a second PR has moved on
 *  to it.
 *
 *  Assistant turns only. A user pasting a github link is usually asking about
 *  someone else's PR, not claiming it. */
export function chatOwnedPrUrl(chat: Chat | undefined): string | undefined {
  const messages = chat?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const found = message.content?.match(PR_URL)
    if (found?.length) return found[found.length - 1]
  }
  return undefined
}
