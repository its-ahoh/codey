import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computerSkill, computerSkillStatus, isComputerSkillActive, setComputerSkillEnabled } from './computer-skill'

let home: string

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-computer-skill-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('Computer skill', () => {
  it('ships a skill named computer that documents the CLI and element tokens', () => {
    const text = computerSkill.markdown()
    expect(text).toMatch(/^---\nname: computer\n/)
    expect(text).toContain('$CODEY_COMPUTER_CLI')
    expect(text).toContain('element_token')
  })

  it('is off until switched on, and remembers the switch on disk', async () => {
    expect(computerSkillStatus(home).state).toBe('absent')
    expect(isComputerSkillActive(home)).toBe(false)
    await expect(setComputerSkillEnabled(true, home)).resolves.toMatchObject({ state: 'installed', origin: 'codey' })
    expect(isComputerSkillActive(home)).toBe(true)
    await expect(setComputerSkillEnabled(false, home)).resolves.toMatchObject({ state: 'disabled' })
    expect(isComputerSkillActive(home)).toBe(false)
    expect(fs.existsSync(path.join(computerSkill.dir(home), 'SKILL.md.disabled'))).toBe(true)
  })

  it('switching off a skill that was never installed is a no-op', async () => {
    await expect(setComputerSkillEnabled(false, home)).resolves.toMatchObject({ state: 'absent' })
  })
})
