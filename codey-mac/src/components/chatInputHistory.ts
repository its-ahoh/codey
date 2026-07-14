export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** User-authored prompts in chronological order for the current chat. */
export function chatInputHistory(messages: HistoryMessage[]): string[] {
  return messages
    .filter(message => message.role === 'user' && message.content.trim().length > 0)
    .map(message => message.content)
}

export function moveInInputHistory(
  history: string[],
  currentIndex: number | null,
  direction: 'up' | 'down',
): { index: number | null; value: string } | null {
  if (history.length === 0) return null
  if (direction === 'up') {
    const index = currentIndex === null
      ? history.length - 1
      : Math.max(0, currentIndex - 1)
    return { index, value: history[index] }
  }
  if (currentIndex === null) return null
  if (currentIndex >= history.length - 1) return { index: null, value: '' }
  const index = currentIndex + 1
  return { index, value: history[index] }
}
