import { describe, expect, it } from 'vitest'
import { moveWorkspace, reconcileWorkspaceOrder } from './workspaceOrder'

describe('workspace ordering', () => {
  it('uses newest-added-first order when no override exists', () => {
    expect(reconcileWorkspaceOrder([], ['newest', 'middle', 'oldest']))
      .toEqual(['newest', 'middle', 'oldest'])
  })

  it('preserves a custom order and puts newly added workspaces on top', () => {
    expect(reconcileWorkspaceOrder(
      ['oldest', 'middle', 'removed'],
      ['newest', 'middle', 'oldest'],
    )).toEqual(['newest', 'oldest', 'middle'])
  })

  it('moves a workspace before its drop target', () => {
    expect(moveWorkspace(['newest', 'middle', 'oldest'], 'oldest', 'newest'))
      .toEqual(['oldest', 'newest', 'middle'])
  })
})
