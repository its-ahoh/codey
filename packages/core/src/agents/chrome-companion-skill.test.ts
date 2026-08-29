import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chromeCompanionSkillDir,
  chromeCompanionSkillStatus,
  installChromeCompanionSkill,
  isChromeCompanionSkillActive,
  setChromeCompanionSkillEnabled,
  uninstallChromeCompanionSkill,
} from './chrome-companion-skill'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chrome-skill-'))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('Chrome Companion skill', () => {
  it('has independent absent/installed/disabled state', async () => {
    expect(chromeCompanionSkillStatus(home).state).toBe('absent')
    expect(isChromeCompanionSkillActive(home)).toBe(false)
    const installed = await installChromeCompanionSkill(home, { today: '2026-08-26' })
    expect(installed).toMatchObject({ installed: true, source: 'bundled' })
    expect(chromeCompanionSkillStatus(home)).toMatchObject({ state: 'installed', origin: 'codey', hash: 'bundled' })
    expect(isChromeCompanionSkillActive(home)).toBe(true)
    fs.renameSync(
      path.join(chromeCompanionSkillDir(home), 'SKILL.md'),
      path.join(chromeCompanionSkillDir(home), 'SKILL.md.disabled'),
    )
    expect(chromeCompanionSkillStatus(home).state).toBe('disabled')
    expect(isChromeCompanionSkillActive(home)).toBe(false)
  })

  it('uninstalls without touching the Browser skill', async () => {
    const browserDir = path.join(home, '.codey', 'skills', 'browser')
    fs.mkdirSync(browserDir, { recursive: true })
    fs.writeFileSync(path.join(browserDir, 'SKILL.md'), 'browser', 'utf8')
    await installChromeCompanionSkill(home)
    await expect(uninstallChromeCompanionSkill(home)).resolves.toEqual({ removed: true })
    expect(fs.readFileSync(path.join(browserDir, 'SKILL.md'), 'utf8')).toBe('browser')
  })

  it('uses a reversible built-in switch without downloading or deleting the skill', async () => {
    await expect(setChromeCompanionSkillEnabled(true, home)).resolves.toMatchObject({ state: 'installed' })
    expect(fetch).not.toHaveBeenCalled()
    const file = path.join(chromeCompanionSkillDir(home), 'SKILL.md')
    expect(fs.readFileSync(file, 'utf8')).toContain('the Chrome Companion built into Codey')

    await expect(setChromeCompanionSkillEnabled(false, home)).resolves.toMatchObject({ state: 'disabled' })
    expect(fs.existsSync(path.join(chromeCompanionSkillDir(home), 'SKILL.md.disabled'))).toBe(true)
    expect(fs.existsSync(file)).toBe(false)

    await expect(setChromeCompanionSkillEnabled(true, home)).resolves.toMatchObject({ state: 'installed' })
    expect(fs.existsSync(file)).toBe(true)
  })
})
