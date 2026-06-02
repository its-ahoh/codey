import type { Chat } from '../types'

/** Subset of useChats' internal InFlight needed to render a notification. */
export interface InFlightLike {
  agentStatus: 'idle' | 'thinking' | 'working' | 'writing'
  queuedPosition?: number
}

export interface NotificationItem {
  chatId: string
  title: string
  workspaceName: string
  updatedAt: number
}

export interface InProgressItem extends NotificationItem {
  agentStatus: InFlightLike['agentStatus']
  queuedPosition?: number
}

export interface NotificationData {
  inProgress: InProgressItem[]
  completed: NotificationItem[]
  /** Badge count: number of unread-completed chats (in-progress is excluded). */
  unreadCount: number
}

/**
 * Turns raw chat state into notification-center view data.
 *
 * - inProgress: one entry per chat with an in-flight turn.
 * - completed: unread-completed chats that are NOT currently back in flight
 *   (a re-sent chat shows only under inProgress).
 * - unreadCount: length of `completed`, used for the badge.
 *
 * Each group is sorted by updatedAt descending. Ids with no matching chat
 * (e.g. a chat removed mid-flight) are skipped.
 */
export function deriveNotifications(
  chats: Record<string, Chat>,
  inFlight: Record<string, InFlightLike>,
  unreadChats: Record<string, true>,
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
    })
  }
  completed.sort((a, b) => b.updatedAt - a.updatedAt)

  return { inProgress, completed, unreadCount: completed.length }
}
