import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveUserPath, samePath, scanSkillsDir, uniqueSkills } from './skills'

const roots: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-agent-skills-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('agent skill discovery', () => {
  it('expands a tilde path and removes a trailing slash', () => {
    expect(resolveUserPath(path, '~/.claude/skills/', '/Users/test')).toBe('/Users/test/.claude/skills')
  })

  it('finds nested configured skills and treats a skill as a boundary', () => {
    const root = temp()
    const skill = path.join(root, '.system', 'imagegen')
    fs.mkdirSync(path.join(skill, 'references'), { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\r\nname: "Image Gen"\r\ndescription: Makes images\r\n---\r\n')
    fs.writeFileSync(path.join(skill, 'references', 'SKILL.md'), '---\nname: wrong\n---\n')
    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      { name: 'Image Gen', description: 'Makes images', scope: 'user', dir: skill },
    ])
  })

  it('recognizes the same root despite trailing separators and deduplicates it', () => {
    const root = temp()
    const skill = path.join(root, 'one')
    fs.mkdirSync(skill)
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: one\n---\n')
    expect(samePath(fs, path, root, `${root}${path.sep}`)).toBe(true)
    const twice = [
      ...scanSkillsDir(fs, path, root, 'user'),
      ...scanSkillsDir(fs, path, `${root}${path.sep}`, 'user'),
    ]
    expect(uniqueSkills(fs, path, twice)).toHaveLength(1)
  })
})
