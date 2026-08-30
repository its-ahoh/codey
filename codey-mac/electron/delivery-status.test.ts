import { describe, expect, it } from 'vitest'
import { deriveDeliveryState, shouldRediscoverPr } from './delivery-status'

describe('shouldRediscoverPr', () => {
  it('re-resolves when a chat-owned checkout moved to another branch', () => {
    expect(shouldRediscoverPr({ pinnedHeadBranch: 'old-work', currentBranch: 'new-work', ownsCheckout: true })).toBe(true)
  })

  it('keeps the pinned PR on its own branch', () => {
    expect(shouldRediscoverPr({ pinnedHeadBranch: 'work', currentBranch: 'work', ownsCheckout: true })).toBe(false)
  })

  it('keeps the pinned PR when the branch is unknown or detached', () => {
    expect(shouldRediscoverPr({ pinnedHeadBranch: 'work', currentBranch: '', ownsCheckout: true })).toBe(false)
    expect(shouldRediscoverPr({ pinnedHeadBranch: 'work', currentBranch: 'HEAD', ownsCheckout: true })).toBe(false)
    expect(shouldRediscoverPr({ currentBranch: 'work', ownsCheckout: true })).toBe(false)
  })

  it('never adopts another chat\'s branch in a shared checkout', () => {
    expect(shouldRediscoverPr({ pinnedHeadBranch: 'old-work', currentBranch: 'new-work' })).toBe(false)
    expect(shouldRediscoverPr({ pinnedHeadBranch: 'old-work', currentBranch: 'new-work', ownsCheckout: false })).toBe(false)
  })
})

describe('deriveDeliveryState', () => {
  it('maps open and closed pull requests', () => {
    expect(deriveDeliveryState({ providerState: 'OPEN', sameBranch: true, commitsAfterMerge: false })).toBe('pr-open')
    expect(deriveDeliveryState({ providerState: 'CLOSED', sameBranch: true, commitsAfterMerge: false })).toBe('closed-unmerged')
  })

  it('marks a merged checkout with no new commits as merged', () => {
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: true, commitsAfterMerge: false })).toBe('merged')
  })

  it('detects commits added after merge', () => {
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: true, commitsAfterMerge: true })).toBe('merged-with-changes')
  })

  it('does not treat a different checkout branch as post-merge work', () => {
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: false, commitsAfterMerge: true })).toBe('merged')
  })
})
