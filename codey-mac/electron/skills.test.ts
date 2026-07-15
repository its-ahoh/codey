import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { qualifySkillName, resolveUserPath, samePath, scanClaudePluginSkills, scanSkillsDir, uniqueSkills } from './skills'

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
      { name: 'Image Gen', qualifiedName: 'Image Gen', description: 'Makes images', scope: 'user', dir: skill },
    ])
  })

  it('keeps a nested skill collection prefix in its command name', () => {
    const root = temp()
    const skill = path.join(root, 'superpowers', 'skills', 'brainstorming')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: brainstorming\ndescription: Explore ideas\n---\n')

    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      {
        name: 'brainstorming',
        qualifiedName: 'superpowers:brainstorming',
        description: 'Explore ideas',
        scope: 'user',
        dir: skill,
      },
    ])
  })

  it('does not duplicate an explicit namespace from frontmatter', () => {
    expect(qualifySkillName(path, '/skills', '/skills/superpowers/brainstorming', 'superpowers:brainstorming'))
      .toBe('superpowers:brainstorming')
  })

  it('uses the Claude plugin id as the skill collection namespace', () => {
    const root = temp()
    const installPath = path.join(root, 'cache', 'superpowers', '4.1.1')
    const skill = path.join(installPath, 'skills', 'brainstorming')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: brainstorming\n---\n')
    const manifest = path.join(root, 'installed_plugins.json')
    fs.writeFileSync(manifest, JSON.stringify({
      plugins: {
        'superpowers@superpowers-marketplace': [{ scope: 'user', installPath }],
      },
    }))

    expect(scanClaudePluginSkills(fs, path, manifest)).toEqual([
      {
        name: 'brainstorming',
        qualifiedName: 'superpowers:brainstorming',
        managedBy: 'superpowers@superpowers-marketplace',
        description: '',
        scope: 'user',
        dir: skill,
      },
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
