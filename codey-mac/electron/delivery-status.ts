export type DeliveryState = 'pr-open' | 'merged' | 'merged-with-changes' | 'closed-unmerged'

/** A pinned PR url describes one branch. Once the checkout has moved to a
 *  different branch, that PR no longer describes the chat's work and its state
 *  (typically `merged`) would stick forever — re-resolve from the branch we're
 *  actually on. `HEAD` (detached) and an unknown head branch are not evidence
 *  of drift, so they keep the pinned PR.
 *
 *  Only the owner of a checkout may re-resolve. In a shared checkout the branch
 *  is global: another chat switching branches would otherwise hand this chat
 *  that other branch's PR, so a chat that opened #367 starts claiming #370. */
export function shouldRediscoverPr(input: {
  pinnedHeadBranch?: string
  currentBranch?: string
  ownsCheckout?: boolean
}): boolean {
  const { pinnedHeadBranch, currentBranch, ownsCheckout } = input
  if (!ownsCheckout) return false
  if (!pinnedHeadBranch || !currentBranch || currentBranch === 'HEAD') return false
  return pinnedHeadBranch !== currentBranch
}

/** Post-merge work is commits, not a dirty tree. A dirty working tree belongs to
 *  the checkout, not to one chat: chats sharing a checkout would all go yellow
 *  because of each other's edits (or build output), and since the state is
 *  persisted and the watcher skips terminal PRs, that flip never reverses. */
export function deriveDeliveryState(input: {
  providerState: string
  sameBranch: boolean
  commitsAfterMerge: boolean
}): DeliveryState {
  const state = input.providerState.toUpperCase()
  if (state === 'OPEN') return 'pr-open'
  if (state !== 'MERGED') return 'closed-unmerged'
  if (!input.sameBranch) return 'merged'
  return input.commitsAfterMerge ? 'merged-with-changes' : 'merged'
}
