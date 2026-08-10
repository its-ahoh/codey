import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectUsageFromTranscript, mergeUsage, scanSkillUsage } from './skill-usage'
import type { UsageCacheEntry } from './skill-usage'

const roots: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skill-usage-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const skillLine = (skill: string, timestamp: string) => JSON.stringify({
  timestamp,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
})

describe('collectUsageFromTranscript', () => {
  it('counts invocations and keeps the latest timestamp', () => {
    const text = [
      skillLine('superpowers:brainstorming', '2026-07-01T00:00:00.000Z'),
      skillLine('superpowers:brainstorming', '2026-07-03T00:00:00.000Z'),
      skillLine('graphify', '2026-07-02T00:00:00.000Z'),
    ].join('\n')
    expect(collectUsageFromTranscript(text)).toEqual({
      'superpowers:brainstorming': { count: 2, lastUsedAt: Date.parse('2026-07-03T00:00:00.000Z') },
      'graphify': { count: 1, lastUsedAt: Date.parse('2026-07-02T00:00:00.000Z') },
    })
  })

  it('lowercases ids and survives malformed or unrelated lines', () => {
    const text = [
      '{ not json',
      JSON.stringify({ timestamp: 'nonsense', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'GraphIfy' } }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ message: { content: 'plain text mentioning "name":"Skill"' } }),
    ].join('\n')
    expect(collectUsageFromTranscript(text)).toEqual({ graphify: { count: 1, lastUsedAt: 0 } })
  })

  it('ignores a tool result echoing the tool name', () => {
    const text = JSON.stringify({
      message: { role: 'user', content: [{ type: 'tool_result', name: 'Skill', content: 'done' }] },
    })
    expect(collectUsageFromTranscript(text)).toEqual({})
  })
})

describe('mergeUsage', () => {
  it('sums counts and takes the newer timestamp', () => {
    const target = { a: { count: 1, lastUsedAt: 500 } }
    mergeUsage(target, { a: { count: 2, lastUsedAt: 100 }, b: { count: 1, lastUsedAt: 900 } })
    expect(target).toEqual({ a: { count: 3, lastUsedAt: 500 }, b: { count: 1, lastUsedAt: 900 } })
  })
})

describe('scanSkillUsage', () => {
  it('aggregates nested transcripts and skips non-jsonl files', async () => {
    const root = temp()
    fs.mkdirSync(path.join(root, 'project-a'), { recursive: true })
    fs.writeFileSync(path.join(root, 'project-a', 'one.jsonl'), skillLine('graphify', '2026-07-01T00:00:00.000Z'))
    fs.writeFileSync(path.join(root, 'two.jsonl'), skillLine('graphify', '2026-07-05T00:00:00.000Z'))
    fs.writeFileSync(path.join(root, 'notes.txt'), skillLine('ignored', '2026-07-05T00:00:00.000Z'))

    expect(await scanSkillUsage(fs, path, [root, path.join(root, 'missing')], new Map())).toEqual({
      graphify: { count: 2, lastUsedAt: Date.parse('2026-07-05T00:00:00.000Z') },
    })
  })

  it('reuses the cache until a transcript changes', async () => {
    const root = temp()
    const file = path.join(root, 'session.jsonl')
    fs.writeFileSync(file, skillLine('graphify', '2026-07-01T00:00:00.000Z'))
    const cache = new Map<string, UsageCacheEntry>()

    expect(await scanSkillUsage(fs, path, [root], cache)).toEqual({
      graphify: { count: 1, lastUsedAt: Date.parse('2026-07-01T00:00:00.000Z') },
    })
    // Cached entries must not be mutated by the merge into the running total.
    expect(cache.get(file)?.usage).toEqual({ graphify: { count: 1, lastUsedAt: Date.parse('2026-07-01T00:00:00.000Z') } })
    expect(await scanSkillUsage(fs, path, [root], cache)).toEqual({
      graphify: { count: 1, lastUsedAt: Date.parse('2026-07-01T00:00:00.000Z') },
    })

    fs.appendFileSync(file, '\n' + skillLine('graphify', '2026-07-09T00:00:00.000Z'))
    expect(await scanSkillUsage(fs, path, [root], cache)).toEqual({
      graphify: { count: 2, lastUsedAt: Date.parse('2026-07-09T00:00:00.000Z') },
    })
  })
})
