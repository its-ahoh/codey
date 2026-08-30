import { describe, expect, it } from 'vitest'
import { resolveWorkspaceDockLayout } from './workspaceDockLayout'

describe('resolveWorkspaceDockLayout', () => {
  it('uses the width beside the chat when both columns fit', () => {
    expect(resolveWorkspaceDockLayout(729, 620)).toEqual({ overlay: false, width: 369 })
  })

  it('keeps an overlay inside its actual chat container', () => {
    expect(resolveWorkspaceDockLayout(600, 620)).toEqual({ overlay: true, width: 528 })
  })

  it('can shrink below the normal dock minimum without crossing the sidebar', () => {
    expect(resolveWorkspaceDockLayout(300, 620)).toEqual({ overlay: true, width: 228 })
  })

  it('never returns a negative width', () => {
    expect(resolveWorkspaceDockLayout(50, 620)).toEqual({ overlay: true, width: 0 })
  })
})
