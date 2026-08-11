import { describe, expect, it } from 'vitest'
import { deriveDeliveryState } from './delivery-status'

describe('deriveDeliveryState', () => {
  it('maps open and closed pull requests', () => {
    expect(deriveDeliveryState({ providerState: 'OPEN', sameBranch: true, commitsAfterMerge: false, dirty: false })).toBe('pr-open')
    expect(deriveDeliveryState({ providerState: 'CLOSED', sameBranch: true, commitsAfterMerge: false, dirty: false })).toBe('closed-unmerged')
  })

  it('marks a clean merged checkout as merged', () => {
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: true, commitsAfterMerge: false, dirty: false })).toBe('merged')
  })

  it('detects dirty files or commits added after merge', () => {
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: true, commitsAfterMerge: false, dirty: true })).toBe('merged-with-changes')
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: true, commitsAfterMerge: true, dirty: false })).toBe('merged-with-changes')
  })

  it('does not treat a different checkout branch as post-merge work', () => {
    expect(deriveDeliveryState({ providerState: 'MERGED', sameBranch: false, commitsAfterMerge: true, dirty: true })).toBe('merged')
  })
})
