/** How many chats of a workspace group the sidebar renders, and how the fold
 *  interacts with the chat the user is looking at.
 *
 *  A group starts at `limit` rows and grows by whatever the user has revealed
 *  through "Show more", one step at a time. A folded group never hides the
 *  active chat: if it sits past the cut, the slice grows to reach it rather
 *  than dropping the selection out of view. */
export function visibleChatCount<T extends { id: string }>(
  chats: readonly T[],
  limit: number,
  revealed: number,
  activeChatId: string | null,
): number {
  if (limit <= 0) return chats.length
  const base = limit + Math.max(0, revealed)
  if (chats.length <= base) return chats.length
  const activeIndex = activeChatId ? chats.findIndex(chat => chat.id === activeChatId) : -1
  return Math.max(base, activeIndex + 1)
}
