import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_MEMORY,
  MAX_MEMORY_BYTES,
  claudeProjectSlug,
  projectMemoryDirs,
  scanProjectMemory,
  scanUserMemory,
  userMemoryFiles,
} from './memory'

const roots: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-agent-memory-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

describe('agent memory locations', () => {
  it('covers every agent Codey can route to', () => {
    expect(Object.keys(AGENT_MEMORY).sort()).toEqual(['claude-code', 'codex', 'opencode', 'pi'])
  })

  it('slugs a project path the way Claude Code does', () => {
    expect(claudeProjectSlug('/Users/test/Documents/projects/codey'))
      .toBe('-Users-test-Documents-projects-codey')
  })

  it('prefers a configured config dir over the default user file', () => {
    const files = userMemoryFiles(path, 'claude-code', '/Users/test', { CLAUDE_CONFIG_DIR: '~/alt' })
    expect(files[0]).toBe('/Users/test/alt/CLAUDE.md')
    expect(files).toContain('/Users/test/.claude/CLAUDE.md')
  })

  it('resolves each agent default user file', () => {
    const home = '/Users/test'
    expect(userMemoryFiles(path, 'codex', home, {})).toEqual([`${home}/.codex/AGENTS.md`])
    expect(userMemoryFiles(path, 'opencode', home, {})).toEqual([`${home}/.config/opencode/AGENTS.md`])
    expect(userMemoryFiles(path, 'pi', home, {})).toEqual([`${home}/.pi/agent/AGENTS.md`])
    expect(userMemoryFiles(path, 'opencode', home, { XDG_CONFIG_HOME: '/xdg' })[0])
      .toBe('/xdg/opencode/AGENTS.md')
  })

  it('only claude-code has per-project memory directories', () => {
    const home = '/Users/test'
    expect(projectMemoryDirs(path, 'claude-code', home, {}, '/repo/app')).toEqual([
      `${home}/.claude/projects/-repo-app/memory`,
      '/repo/app/.claude/agent-memory',
      '/repo/app/.claude/agent-memory-local',
    ])
    expect(projectMemoryDirs(path, 'codex', home, {}, '/repo/app')).toEqual([])
  })
})

describe('scanUserMemory', () => {
  it('reads only the global file, never the project or auto-memory ones', () => {
    const home = temp()
    const project = temp()
    write(path.join(home, '.claude', 'CLAUDE.md'), 'global rules')
    write(path.join(home, '.claude', 'projects', claudeProjectSlug(project), 'memory', 'a.md'), 'per project')
    write(path.join(project, 'CLAUDE.md'), 'project rules')

    const entries = scanUserMemory(fs, path, 'claude-code', home, {})
    expect(entries.map(e => `${e.scope}:${e.label}`)).toEqual(['user:CLAUDE.md'])
    expect(entries[0].content).toBe('global rules')
  })

  it('is empty when the agent has no global file yet', () => {
    expect(scanUserMemory(fs, path, 'codex', temp(), {})).toEqual([])
  })

  it('truncates a very large memory file', () => {
    const home = temp()
    write(path.join(home, '.codex', 'AGENTS.md'), 'x'.repeat(MAX_MEMORY_BYTES + 10))
    const entries = scanUserMemory(fs, path, 'codex', home, {})
    expect(entries[0].truncated).toBe(true)
    expect(entries[0].content).toHaveLength(MAX_MEMORY_BYTES)
    expect(entries[0].bytes).toBe(MAX_MEMORY_BYTES + 10)
  })
})

describe('scanProjectMemory', () => {
  it('lists repository files, auto-memory and subagent memory for claude-code', () => {
    const home = temp()
    const project = temp()
    write(path.join(home, '.claude', 'CLAUDE.md'), 'global rules')
    const memDir = path.join(home, '.claude', 'projects', claudeProjectSlug(project), 'memory')
    write(path.join(memDir, 'MEMORY.md'), '- index')
    write(path.join(memDir, 'node-version.md'), 'use v22')
    write(path.join(memDir, 'notes.txt'), 'ignored')
    write(path.join(project, 'CLAUDE.md'), 'project rules')
    write(path.join(project, '.claude', 'agent-memory', 'agent-architect', 'style.md'), 'shared')
    write(path.join(project, '.claude', 'agent-memory-local', 'agent-architect', 'box.md'), 'local only')

    const entries = scanProjectMemory(fs, path, 'claude-code', home, {}, project)
    expect(entries.map(e => e.label)).toEqual([
      'CLAUDE.md',
      'memory/MEMORY.md',
      'memory/node-version.md',
      'agent-memory/agent-architect/style.md',
      'agent-memory-local/agent-architect/box.md',
    ])
    expect(entries.every(e => e.scope === 'project')).toBe(true)
    expect(entries.some(e => e.content === 'global rules')).toBe(false)
  })

  it('skips files that do not exist', () => {
    const project = temp()
    write(path.join(project, 'AGENTS.md'), 'codex rules')
    const entries = scanProjectMemory(fs, path, 'codex', temp(), {}, project)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ scope: 'project', label: 'AGENTS.md', content: 'codex rules' })
  })

  it('reports nothing for an agent without memory files', () => {
    expect(scanProjectMemory(fs, path, 'unknown-agent', temp(), {}, temp())).toEqual([])
  })

  it('lists only the override file for pi when one exists', () => {
    const project = temp()
    write(path.join(project, 'AGENTS.md'), 'normal')
    write(path.join(project, 'CLAUDE.md'), 'normal too')
    write(path.join(project, 'AGENTS.override.md'), 'override wins')
    const labels = scanProjectMemory(fs, path, 'pi', temp(), {}, project).map(e => e.label)
    expect(labels).toEqual(['AGENTS.override.md'])
  })

  it('lists the normal pi context files when no override exists', () => {
    const project = temp()
    write(path.join(project, 'AGENTS.md'), 'normal')
    write(path.join(project, 'CLAUDE.md'), 'also read')
    const labels = scanProjectMemory(fs, path, 'pi', temp(), {}, project).map(e => e.label)
    expect(labels).toEqual(['AGENTS.md', 'CLAUDE.md'])
  })

  it('ignores an empty subagent memory directory', () => {
    const project = temp()
    fs.mkdirSync(path.join(project, '.claude', 'agent-memory', 'agent-architect'), { recursive: true })
    expect(scanProjectMemory(fs, path, 'claude-code', temp(), {}, project)).toEqual([])
  })
})
