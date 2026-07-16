/** Merge the backend's newest-first workspace list into a saved user order.
 * Existing names keep their custom positions; newly added names go on top. */
export function reconcileWorkspaceOrder(saved: string[], liveNewestFirst: string[]): string[] {
  const live = new Set(liveNewestFirst)
  const kept = saved.filter((name, index) => live.has(name) && saved.indexOf(name) === index)
  const keptSet = new Set(kept)
  return [...liveNewestFirst.filter(name => !keptSet.has(name)), ...kept]
}

export function moveWorkspace(order: string[], dragged: string, target: string): string[] {
  if (dragged === target || !order.includes(dragged)) return order
  const next = order.filter(name => name !== dragged)
  const targetIndex = next.indexOf(target)
  if (targetIndex === -1) return order
  next.splice(targetIndex, 0, dragged)
  return next
}
