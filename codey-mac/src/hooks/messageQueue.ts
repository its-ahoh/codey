import type { QueuedMessage } from './useChats'

/** Which queued prompts are ready to go out right now: the head of every
 *  chat's queue whose turn has finished, that is not already being delivered,
 *  and whose queue is not paused by a stop. Pure so the drain rule can be
 *  tested without a DOM. */
export function readyDeliveries(
  queuedMessages: Record<string, QueuedMessage[]>,
  inFlight: Record<string, unknown>,
  draining: ReadonlySet<string>,
  pausedQueues: Record<string, true> = {},
): Array<{ chatId: string; message: QueuedMessage }> {
  const ready: Array<{ chatId: string; message: QueuedMessage }> = []
  for (const [chatId, queue] of Object.entries(queuedMessages)) {
    const head = queue[0]
    if (!head || inFlight[chatId] || draining.has(chatId) || pausedQueues[chatId]) continue
    ready.push({ chatId, message: head })
  }
  return ready
}
