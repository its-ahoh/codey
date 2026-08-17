import type { Chat } from '../types'
import type { AgentActivity } from './agentActivity'

/** Subset of useChats' internal InFlight needed to render a notification. */
export interface InFlightLike {
  agentStatus: AgentActivity
  queuedPosition?: number
}

/** How a finished turn ended: normally, or with an error. */
export type UnreadKind = 'done' | 'error'

export interface NotificationItem {
  chatId: string
  title: string
  workspaceName: string
  updatedAt: number
  kind: UnreadKind
}

export interface InProgressItem extends Omit<NotificationItem, 'kind'> {
  agentStatus: InFlightLike['agentStatus']
  queuedPosition?: number
}

export interface NotificationData {
  inProgress: InProgressItem[]
  completed: NotificationItem[]
  /** Badge count: number of unread-completed chats (in-progress is excluded). */
  unreadCount: number
  /** How many of those ended in an error — drives the red (vs neutral) badge. */
  errorCount: number
}

/**
 * Turns raw chat state into notification-center view data.
 *
 * - inProgress: one entry per chat with an in-flight turn.
 * - completed: unread-completed chats that are NOT currently back in flight
 *   (a re-sent chat shows only under inProgress).
 * - unreadCount: length of `completed`, used for the badge.
 * - errorCount: how many of those failed; red is reserved for errors, a plain
 *   finished turn gets the neutral accent instead.
 *
 * Each group is sorted by updatedAt descending. Ids with no matching chat
 * (e.g. a chat removed mid-flight) are skipped.
 */
export function deriveNotifications(
  chats: Record<string, Chat>,
  inFlight: Record<string, InFlightLike>,
  unreadChats: Record<string, UnreadKind>,
): NotificationData {
  const inProgress: InProgressItem[] = []
  for (const chatId of Object.keys(inFlight)) {
    const chat = chats[chatId]
    if (!chat) continue
    inProgress.push({
      chatId,
      title: chat.title,
      workspaceName: chat.workspaceName,
      updatedAt: chat.updatedAt,
      agentStatus: inFlight[chatId].agentStatus,
      queuedPosition: inFlight[chatId].queuedPosition,
    })
  }
  inProgress.sort((a, b) => b.updatedAt - a.updatedAt)

  const completed: NotificationItem[] = []
  for (const chatId of Object.keys(unreadChats)) {
    if (inFlight[chatId]) continue
    const chat = chats[chatId]
    if (!chat) continue
    completed.push({
      chatId,
      title: chat.title,
      workspaceName: chat.workspaceName,
      updatedAt: chat.updatedAt,
      kind: unreadChats[chatId] === 'error' ? 'error' : 'done',
    })
  }
  completed.sort((a, b) => b.updatedAt - a.updatedAt)

  return {
    inProgress,
    completed,
    unreadCount: completed.length,
    errorCount: completed.filter(c => c.kind === 'error').length,
  }
}
