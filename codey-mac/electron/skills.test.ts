import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { qualifySkillName, resolveUserPath, samePath, scanClaudePluginSkills, scanSkillsDir, setSkillEnabled, uniqueSkills } from './skills'

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
      { name: 'Image Gen', qualifiedName: 'Image Gen', description: 'Makes images', scope: 'user', dir: skill, enabled: true },
    ])
  })

  it('lists a disabled skill and stops descending into it', () => {
    const root = temp()
    const skill = path.join(root, 'noisy')
    fs.mkdirSync(path.join(skill, 'references'), { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md.disabled'), '---\nname: noisy\ndescription: Too chatty\n---\n')
    fs.writeFileSync(path.join(skill, 'references', 'SKILL.md'), '---\nname: wrong\n---\n')

    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      { name: 'noisy', qualifiedName: 'noisy', description: 'Too chatty', scope: 'user', dir: skill, enabled: false },
    ])
  })

  it('prefers the active SKILL.md when a stale disabled copy is left behind', () => {
    const root = temp()
    const skill = path.join(root, 'both')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: both\ndescription: Live\n---\n')
    fs.writeFileSync(path.join(skill, 'SKILL.md.disabled'), '---\nname: both\ndescription: Stale\n---\n')

    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      { name: 'both', qualifiedName: 'both', description: 'Live', scope: 'user', dir: skill, enabled: true },
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
        enabled: true,
      },
    ])
  })

  it('keeps the collection prefix on a disabled nested skill', () => {
    const root = temp()
    const skill = path.join(root, 'superpowers', 'skills', 'brainstorming')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md.disabled'), '---\nname: brainstorming\ndescription: Explore ideas\n---\n')

    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      {
        name: 'brainstorming',
        qualifiedName: 'superpowers:brainstorming',
        description: 'Explore ideas',
        scope: 'user',
        dir: skill,
        enabled: false,
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
        enabled: true,
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

describe('setSkillEnabled', () => {
  const makeSkill = (): string => {
    const root = temp()
    const skill = path.join(root, 'one')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: A skill\n---\n')
    return skill
  }

  it('round-trips a skill from enabled to disabled and back', () => {
    const skill = makeSkill()

    setSkillEnabled(fs, path, skill, false)
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(skill, 'SKILL.md.disabled'))).toBe(true)
    expect(scanSkillsDir(fs, path, skill, 'user')[0]?.enabled).toBe(false)

    setSkillEnabled(fs, path, skill, true)
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(skill, 'SKILL.md.disabled'))).toBe(false)
    expect(scanSkillsDir(fs, path, skill, 'user')[0]?.enabled).toBe(true)
  })

  it('preserves the skill body across the rename', () => {
    const skill = makeSkill()
    setSkillEnabled(fs, path, skill, false)
    expect(fs.readFileSync(path.join(skill, 'SKILL.md.disabled'), 'utf-8'))
      .toBe('---\nname: one\ndescription: A skill\n---\n')
  })

  it('is a no-op when the skill is already in the requested state', () => {
    const skill = makeSkill()
    setSkillEnabled(fs, path, skill, true)
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(true)

    setSkillEnabled(fs, path, skill, false)
    setSkillEnabled(fs, path, skill, false)
    expect(fs.existsSync(path.join(skill, 'SKILL.md.disabled'))).toBe(true)
  })

  it('throws when the directory holds no skill file', () => {
    const root = temp()
    expect(() => setSkillEnabled(fs, path, root, false)).toThrow(/SKILL\.md/)
  })
})
