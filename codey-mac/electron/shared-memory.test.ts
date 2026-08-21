import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BLOCK_BEGIN,
  BLOCK_END,
  applyManagedBlock,
  hasManagedBlock,
  legacySharedFilePath,
  renderSharedBody,
  sharedMemoryTargets,
  syncSharedMemory,
} from './shared-memory'

const roots: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-shared-memory-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const noEnv = () => ({})

describe('applyManagedBlock', () => {
  it('appends the block after the user own text', () => {
    const out = applyManagedBlock('# My rules\nBe brief.\n', 'Shared fact.')
    expect(out.startsWith('# My rules\nBe brief.\n\n')).toBe(true)
    expect(out).toContain(BLOCK_BEGIN)
    expect(out).toContain('Shared fact.')
    expect(out.trimEnd().endsWith(BLOCK_END)).toBe(true)
  })

  it('replaces only the block and keeps text on both sides', () => {
    const first = applyManagedBlock('Top.\n', 'v1')
    const withTail = `${first}\nBottom.\n`
    const second = applyManagedBlock(withTail, 'v2')
    expect(second).toContain('Top.')
    expect(second).toContain('Bottom.')
    expect(second).toContain('v2')
    expect(second).not.toContain('v1')
    expect(second.match(new RegExp(BLOCK_BEGIN, 'g'))).toHaveLength(1)
  })

  it('removes the block when the body is empty, keeping the user text', () => {
    const withBlock = applyManagedBlock('Top.\n', 'shared')
    const out = applyManagedBlock(withBlock, '')
    expect(hasManagedBlock(out)).toBe(false)
    expect(out.trim()).toBe('Top.')
  })

  it('returns an empty string when the block was the whole file', () => {
    const withBlock = applyManagedBlock('', 'shared')
    expect(applyManagedBlock(withBlock, '')).toBe('')
  })

  it('leaves a file without a block untouched when the body is empty', () => {
    expect(applyManagedBlock('Just my notes.\n', '   ')).toBe('Just my notes.\n')
  })

  it('creates the file content from nothing', () => {
    const out = applyManagedBlock('', 'shared')
    expect(out.startsWith(BLOCK_BEGIN)).toBe(true)
    expect(out).toContain('shared')
  })
})

describe('sharedMemoryTargets', () => {
  it('points at each agent global memory file', () => {
    expect(sharedMemoryTargets(path, '/Users/test', noEnv)).toEqual([
      { agent: 'claude-code', path: '/Users/test/.claude/CLAUDE.md' },
      { agent: 'codex', path: '/Users/test/.codex/AGENTS.md' },
      { agent: 'opencode', path: '/Users/test/.config/opencode/AGENTS.md' },
      { agent: 'pi', path: '/Users/test/.pi/agent/AGENTS.md' },
    ])
  })

  it('follows an agent configured config dir', () => {
    const env = (agent: string): Record<string, string> => agent === 'codex' ? { CODEX_HOME: '/alt/codex' } : {}
    const targets = sharedMemoryTargets(path, '/Users/test', env)
    expect(targets.find(t => t.agent === 'codex')?.path).toBe('/alt/codex/AGENTS.md')
  })
})

describe('syncSharedMemory', () => {
  it('writes the block into every agent file, creating missing ones', () => {
    const home = temp()
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'My own rules.\n')

    const targets = sharedMemoryTargets(path, home, noEnv)
    const result = syncSharedMemory(fs, path, targets, 'Always use tabs.')
    expect(result.written).toHaveLength(4)

    for (const target of targets) {
      const text = fs.readFileSync(target.path, 'utf-8')
      expect(text).toContain('Always use tabs.')
    }
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf-8')).toContain('My own rules.')
  })

  it('is a no-op on a second run with the same body', () => {
    const home = temp()
    const targets = sharedMemoryTargets(path, home, noEnv)
    syncSharedMemory(fs, path, targets, 'Same text.')
    const again = syncSharedMemory(fs, path, targets, 'Same text.')
    expect(again.written).toEqual([])
    expect(again.unchanged).toHaveLength(4)
  })

  it('removes the block and deletes files it fully owned', () => {
    const home = temp()
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'Keep me.\n')
    const targets = sharedMemoryTargets(path, home, noEnv)
    syncSharedMemory(fs, path, targets, 'Shared.')

    syncSharedMemory(fs, path, targets, '')

    const claude = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(claude.trim()).toBe('Keep me.')
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(false)
  })

  it('never creates a file for an empty body', () => {
    const home = temp()
    const targets = sharedMemoryTargets(path, home, noEnv)
    expect(syncSharedMemory(fs, path, targets, '').written).toEqual([])
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(false)
  })
})

describe('renderSharedBody', () => {
  it('renders one bullet per entry', () => {
    expect(renderSharedBody([{ content: 'Uses tabs' }, { content: 'Ships on Fridays' }]))
      .toBe('- Uses tabs\n- Ships on Fridays')
  })

  it('indents the continuation lines of a multi-line entry', () => {
    expect(renderSharedBody([{ content: 'Node version\nuse v22.17.1' }]))
      .toBe('- Node version\n  use v22.17.1')
  })

  it('skips blank entries and returns nothing for an empty store', () => {
    expect(renderSharedBody([{ content: '  ' }])).toBe('')
    expect(renderSharedBody([])).toBe('')
  })
})

describe('the legacy shared file', () => {
  it('points at the text that used to hold the shared block', () => {
    expect(legacySharedFilePath(path, '/Users/test')).toBe('/Users/test/.codey/memory/MEMORY.md')
  })
})
