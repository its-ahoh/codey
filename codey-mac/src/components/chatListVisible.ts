/** How many chats of a workspace group the sidebar renders while the group is
 *  folded, and how the fold interacts with the chat the user is looking at.
 *
 *  A folded group never hides the active chat: if it sits past the cut, the
 *  slice grows to reach it rather than dropping the selection out of view. */
export function visibleChatCount<T extends { id: string }>(
  chats: readonly T[],
  limit: number,
  expanded: boolean,
  activeChatId: string | null,
): number {
  if (expanded || limit <= 0 || chats.length <= limit) return chats.length
  const activeIndex = activeChatId ? chats.findIndex(chat => chat.id === activeChatId) : -1
  return Math.max(limit, activeIndex + 1)
}
