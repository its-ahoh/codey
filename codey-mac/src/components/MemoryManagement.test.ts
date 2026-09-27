import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryHistory, ArchivedMemories, MemoryConflictCard } from './MemoryManagement'

describe('native memory management views', () => {
  it('shows conflict alternatives as escaped text without preselecting a resolution', () => {
    const html = renderToStaticMarkup(React.createElement(MemoryConflictCard, {
      conflict: { id: 'conflict', memoryId: 'note', currentVersion: 3, currentContent: '<script>current</script>', proposals: [{ replicaId: 'replica', content: null }], candidates: [{ id: 'candidate', content: 'Alternative' }], createdAt: 0, revision: 'revision' },
      busy: false, resolve: () => {},
    }))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('(Archived)')
    expect(html).toContain('Alternative')
    expect(html).toContain('disabled="">Save merge')
  })
  it('shows archived state and historical versions', () => {
    const note = { id: 'note', version: 1, scope: 'project' as const, projectId: 'project', content: 'Earlier content', deleted: true, createdAt: 0, updatedAt: 0, origin: 'test' }
    const html = renderToStaticMarkup(React.createElement(MemoryHistory, { details: { memory: note, history: [note], conflicts: [] }, onClose: () => {} }))
    expect(html).toContain('Version 1')
    expect(html).toContain('Archived')
    expect(html).toContain('Earlier content')
    const empty = renderToStaticMarkup(React.createElement(ArchivedMemories, { entries: [], busy: false, restore: () => {}, history: () => {} }))
    expect(empty).toContain('No archived memories.')
  })
})
