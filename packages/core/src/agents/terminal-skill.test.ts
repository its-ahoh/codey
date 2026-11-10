import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installTerminalSkill,
  isTerminalSkillActive,
  setTerminalSkillEnabled,
  terminalSkill,
  terminalSkillStatus,
  uninstallTerminalSkill,
} from './terminal-skill'

let home: string

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-terminal-skill-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('Terminal skill', () => {
  it('ships a skill named terminal that documents the CLI', () => {
    const text = terminalSkill.markdown()
    expect(text).toMatch(/^---\nname: terminal\n/)
    expect(text).toContain('$CODEY_TERMINAL_CLI')
  })

  it('installs the bundled copy with a stamp and reports it as Codey-managed', async () => {
    expect(terminalSkillStatus(home).state).toBe('absent')
    await expect(installTerminalSkill(home, { today: '2026-11-09' })).resolves.toMatchObject({ installed: true, source: 'bundled' })
    expect(terminalSkillStatus(home)).toMatchObject({ state: 'installed', origin: 'codey', hash: 'bundled' })
    expect(isTerminalSkillActive(home)).toBe(true)
    const text = fs.readFileSync(path.join(terminalSkill.dir(home), 'SKILL.md'), 'utf8')
    expect(text.startsWith('---\nname: terminal\n')).toBe(true)
    expect(text).toContain('<!-- Installed by Codey: terminal bundled from the Terminal plugin built into Codey on 2026-11-09.')
  })

  it('switches on and off by renaming the file', async () => {
    await expect(setTerminalSkillEnabled(true, home)).resolves.toMatchObject({ state: 'installed' })
    await expect(setTerminalSkillEnabled(false, home)).resolves.toMatchObject({ state: 'disabled' })
    expect(isTerminalSkillActive(home)).toBe(false)
    expect(fs.existsSync(path.join(terminalSkill.dir(home), 'SKILL.md.disabled'))).toBe(true)
    await expect(setTerminalSkillEnabled(true, home)).resolves.toMatchObject({ state: 'installed' })
  })

  it('refuses to replace or delete a hand-written skill of the same name', async () => {
    fs.mkdirSync(terminalSkill.dir(home), { recursive: true })
    fs.writeFileSync(path.join(terminalSkill.dir(home), 'SKILL.md'), 'mine', 'utf8')
    expect(terminalSkillStatus(home).origin).toBe('user')
    await expect(installTerminalSkill(home)).resolves.toMatchObject({ installed: false, conflict: 'user-copy' })
    await expect(uninstallTerminalSkill(home)).resolves.toEqual({ removed: false, conflict: 'user-copy' })
    await expect(setTerminalSkillEnabled(true, home)).resolves.toMatchObject({ state: 'installed', origin: 'user' })
    expect(fs.readFileSync(path.join(terminalSkill.dir(home), 'SKILL.md'), 'utf8')).toBe('mine')
  })
})
