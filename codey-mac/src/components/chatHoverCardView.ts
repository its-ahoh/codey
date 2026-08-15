// codey-mac/src/components/chatHoverCard.ts
//
// What the sidebar says about a chat when you hover its title. The row itself
// has space for a name and one dot, so everything else a user needs to answer
// "what is this chat doing right now?" has to live here.
//
// Pure by convention (see checklistView.ts): no React, core types only, so the
// precedence rules below can be tested directly rather than through the DOM.

import type { Chat } from '../types'
import { ACTIVITY_LABEL, type AgentActivity } from './agentActivity'
import { checklistProgress, currentChecklistItem, currentItemLabel } from './checklistView'
import { formatAgo, isTaskBriefStale, statusMeta, type StatusTone } from './taskHudView'

/** taskHudView's tones plus the one a HUD never needs: nothing has happened. */
export type HoverTone = StatusTone | 'muted'

export interface HoverCardRow {
  label: string
  value: string
}

export interface HoverCardProgress {
  percent: number
  /** "3/7" when counted from the agent's own list; absent for an LLM estimate. */
  label?: string
}

export interface HoverCard {
  title: string
  status: { label: string; tone: HoverTone }
  /** One line under the status: the current step, question, or blocker. */
  detail?: string
  progress?: HoverCardProgress
  rows: HoverCardRow[]
}

export interface HoverCardInput {
  chat: Chat
  /** state.inFlight[chat.id] — present only while a turn is running. */
  flight?: { agentStatus: AgentActivity; queuedPosition?: number }
  unread: boolean
  /** state.pendingPermissions[chat.id] — tools awaiting a decision. */
  pendingPermissions?: string[]
  /** Gateway default, shown when the chat has no per-chat agent override. */
  defaultAgent?: string
  now?: number
}

const PR_STATE_LABEL: Record<NonNullable<Chat['pullRequest']>['state'], string> = {
  'pr-open': 'open',
  merged: 'merged',
  'merged-with-changes': 'merged, new changes since',
  'closed-unmerged': 'closed without merging',
}

function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/** The status line, most-blocking cause first. A permission prompt outranks the
 *  running state because the run has already stopped for it; an unread reply
 *  outranks "idle" because it is the reason to open the chat. */
function deriveStatus(
  input: HoverCardInput,
  brief: Chat['taskBrief'] | undefined,
): { status: { label: string; tone: HoverTone }; detail?: string } {
  const { chat, flight, unread, pendingPermissions } = input

  if (pendingPermissions?.length) {
    return { status: { label: 'Needs permission', tone: 'yellow' }, detail: pendingPermissions.join(', ') }
  }

  if (chat.pendingTeam) {
    return { status: { label: 'Waiting on you', tone: 'yellow' }, detail: chat.pendingTeam.question }
  }

  if (flight) {
    const current = chat.checklist?.length ? currentChecklistItem(chat.checklist) : null
    const label = flight.queuedPosition
      ? `Queued · ${ordinal(flight.queuedPosition)} in line`
      : ACTIVITY_LABEL[flight.agentStatus]
    return {
      status: { label, tone: 'accent' },
      // The agent's own words for the step beat our verb for the tool it ran.
      detail: current ? currentItemLabel(current.item) : undefined,
    }
  }

  if (brief) {
    const meta = statusMeta(brief.state.status)
    return { status: meta, detail: brief.nextAction?.text }
  }

  if (unread) return { status: { label: 'New reply', tone: 'green' } }
  if (!chat.messages.length) return { status: { label: 'No messages yet', tone: 'muted' } }
  return { status: { label: 'Idle', tone: 'muted' } }
}

function deriveProgress(chat: Chat, brief: Chat['taskBrief'] | undefined): HoverCardProgress | undefined {
  // Counted beats estimated: the checklist is what the agent said it would do.
  if (chat.checklist?.length) {
    const p = checklistProgress(chat.checklist)
    return { percent: p.percent, label: p.label }
  }
  if (brief) return { percent: brief.state.progress }
  return undefined
}

function deriveRows(input: HoverCardInput): HoverCardRow[] {
  const { chat, defaultAgent, now } = input
  const rows: HoverCardRow[] = []

  const agent = chat.agent
    ? [chat.agent, chat.model, chat.effort ? `${chat.effort} effort` : undefined].filter(Boolean).join(' · ')
    : defaultAgent ? `${defaultAgent} (default)` : 'Gateway default'
  rows.push({ label: 'Agent', value: agent })

  if (chat.selection.type === 'team' && chat.selection.name) rows.push({ label: 'Team', value: chat.selection.name })
  if (chat.selection.type === 'worker' && chat.selection.name) rows.push({ label: 'Worker', value: chat.selection.name })

  rows.push({
    label: 'Checkout',
    value: chat.executionMode === 'isolated-worktree'
      ? ['Isolated worktree', chat.chatWorkspace?.name].filter(Boolean).join(' · ')
      : 'Shared checkout',
  })

  if (chat.pullRequest) {
    const pr = chat.pullRequest.number ? `PR #${chat.pullRequest.number}` : 'Pull request'
    rows.push({ label: 'Delivery', value: `${pr} · ${PR_STATE_LABEL[chat.pullRequest.state]}` })
  }

  if (chat.routes?.length) {
    rows.push({ label: 'Channels', value: chat.routes.map(r => r.channel).join(', ') })
  }

  rows.push({ label: 'Messages', value: String(chat.messages.length) })
  rows.push({ label: 'Last active', value: formatAgo(chat.updatedAt, now) })

  return rows
}

export function buildChatHoverCard(input: HoverCardInput): HoverCard {
  const { chat } = input
  // A brief generated before the newest message describes a turn that has since
  // moved on, so it is dropped rather than shown as the current state.
  const brief = chat.taskBrief && !isTaskBriefStale(chat) ? chat.taskBrief : undefined
  const { status, detail } = deriveStatus(input, brief)

  return {
    title: chat.title?.trim() || 'New Chat',
    status,
    detail,
    progress: deriveProgress(chat, brief),
    rows: deriveRows(input),
  }
}

export const HOVER_CARD_WIDTH = 260
/** Long enough that skimming the list doesn't strobe cards open. */
export const HOVER_CARD_DELAY_MS = 450

const GAP = 8

export interface HoverCardAnchor {
  top: number
  bottom: number
  left: number
  right: number
}

/** Fixed-position placement beside the hovered row. The sidebar scrolls and the
 *  window resizes, so the card is clamped into the viewport instead of trusting
 *  the row's position. */
export function hoverCardPosition(
  anchor: HoverCardAnchor,
  viewport: { width: number; height: number },
  cardHeight: number,
): { left: number; top: number } {
  const right = anchor.right + GAP
  const fitsRight = right + HOVER_CARD_WIDTH <= viewport.width - GAP
  const left = fitsRight ? right : anchor.left - GAP - HOVER_CARD_WIDTH
  const maxLeft = Math.max(GAP, viewport.width - GAP - HOVER_CARD_WIDTH)

  const maxTop = viewport.height - cardHeight - GAP
  return {
    left: Math.min(Math.max(GAP, left), maxLeft),
    top: Math.min(Math.max(GAP, anchor.top), Math.max(GAP, maxTop)),
  }
}
