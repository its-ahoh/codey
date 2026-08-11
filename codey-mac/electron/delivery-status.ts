export type DeliveryState = 'pr-open' | 'merged' | 'merged-with-changes' | 'closed-unmerged'

export function deriveDeliveryState(input: {
  providerState: string
  sameBranch: boolean
  commitsAfterMerge: boolean
  dirty: boolean
}): DeliveryState {
  const state = input.providerState.toUpperCase()
  if (state === 'OPEN') return 'pr-open'
  if (state !== 'MERGED') return 'closed-unmerged'
  if (!input.sameBranch) return 'merged'
  return input.dirty || input.commitsAfterMerge ? 'merged-with-changes' : 'merged'
}
