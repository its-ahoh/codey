import type { Chat } from '../types'
import { ACTIVITY_LABEL, type AgentActivity } from './agentActivity'
import { formatAgo, type StatusTone } from './taskHudView'

export interface HoverCardRow {
  label: string
  value: string
}

export interface ChatHoverCardView {
  title: string
  status: { label: string; tone: StatusTone }
  /** The Aide's one-line goal, when a task brief exists. */
  goal?: string
  /** 0–100 from the task brief; only set alongside `goal`. */
  progress?: number
  rows: HoverCardRow[]
  /** Channel labels this chat is paired with (Telegram / Discord / iMessage). */
  channels: string[]
}

export interface HoverCardInput {
  /** Live activity from the chat store's inFlight entry; absent when idle. */
  activity?: AgentActivity
  /** Tool names awaiting a permission decision. */
  pendingPermissions?: string[]
  unread?: boolean
  now?: number
}

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  imessage: 'iMessage',
}

const PR_LABEL: Record<NonNullable<Chat['pullRequest']>['state'], string> = {
  'pr-open': 'open',
  merged: 'merged',
  'merged-with-changes': 'merged · new changes',
  'closed-unmerged': 'closed without merge',
}

/** The one line that answers "what is this chat doing right now?".
 *  Ordered by how much it demands the user: a blocked run outranks a running
 *  one, which outranks a finished-but-unseen reply. */
function resolveStatus(chat: Chat, input: HoverCardInput): { label: string; tone: StatusTone } {
  if (input.pendingPermissions?.length) {
    const [first, ...rest] = input.pendingPermissions
    const suffix = rest.length ? ` +${rest.length}` : ''
    return { label: `Needs permission — ${first}${suffix}`, tone: 'red' }
  }
  if (chat.pendingTeam) return { label: 'Paused — waiting on your reply', tone: 'yellow' }
  if (input.activity) return { label: ACTIVITY_LABEL[input.activity], tone: 'accent' }
  if (input.unread) return { label: 'New reply', tone: 'green' }
  const status = chat.taskBrief?.state.status
  if (status === 'blocked') return { label: 'Blocked', tone: 'red' }
  if (status === 'waiting') return { label: 'Waiting on you', tone: 'yellow' }
  if (status === 'done') return { label: 'Done', tone: 'green' }
  return { label: 'Idle', tone: 'accent' }
}

function resolveRunner(chat: Chat): string | undefined {
  if (chat.selection?.type === 'team') return `Team${chat.selection.name ? ` · ${chat.selection.name}` : ''}`
  if (chat.selection?.type === 'worker') return `Worker · ${chat.selection.name}`
  return undefined
}

function resolveCheckout(chat: Chat): string | undefined {
  if (chat.chatWorkspace) return chat.chatWorkspace.name?.trim() || 'Isolated worktree'
  if (chat.executionMode === 'isolated-worktree') return 'Isolated worktree'
  return 'Shared checkout'
}

/** Everything the hover card shows, derived from the chat plus the live store
 *  slices the list already tracks. Pure so the wording stays under test. */
export function buildChatHoverCard(chat: Chat, input: HoverCardInput = {}): ChatHoverCardView {
  const now = input.now ?? Date.now()
  const rows: HoverCardRow[] = []

  const agent = chat.agent ?? 'gateway default'
  rows.push({ label: 'Agent', value: chat.model ? `${agent} · ${chat.model}` : agent })
  if (chat.effort) rows.push({ label: 'Effort', value: chat.effort })

  const runner = resolveRunner(chat)
  if (runner) rows.push({ label: 'Runs as', value: runner })

  rows.push({ label: 'Workspace', value: chat.workspaceName })
  const checkout = resolveCheckout(chat)
  if (checkout) rows.push({ label: 'Checkout', value: checkout })

  if (chat.pullRequest) {
    const number = chat.pullRequest.number ? `#${chat.pullRequest.number}` : 'PR'
    rows.push({ label: 'Pull request', value: `${number} · ${PR_LABEL[chat.pullRequest.state]}` })
  }

  const messages = chat.messages?.length ?? 0
  rows.push({ label: 'Messages', value: `${messages}` })
  rows.push({ label: 'Last activity', value: formatAgo(chat.updatedAt, now) })

  const brief = chat.taskBrief
  return {
    title: chat.title?.trim() || 'New Chat',
    status: resolveStatus(chat, input),
    goal: brief?.goal?.trim() || undefined,
    progress: brief?.goal?.trim() ? brief.state.progress : undefined,
    rows,
    channels: (chat.routes ?? []).map(r => CHANNEL_LABEL[r.channel] ?? r.channel),
  }
}

/** Keep the card fully on screen: prefer aligning its top with the hovered row,
 *  but slide it up when it would spill past the bottom edge. */
export function clampCardTop(rowTop: number, cardHeight: number, viewportHeight: number, margin = 12): number {
  const maxTop = viewportHeight - cardHeight - margin
  if (maxTop < margin) return margin
  return Math.min(Math.max(rowTop, margin), maxTop)
}
