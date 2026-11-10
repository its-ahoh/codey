import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  BUNDLED_SKILL_MARK,
  CODEY_INSTALL_MARKER,
  type BrowserSkillInstallResult,
  type BrowserSkillStatus,
  type BrowserSkillUpdateCheck,
} from './browser-skill'
import { CODEY_GLOBAL_SKILLS_SUBDIR } from './codey-skills'

const SKILL_FILE = 'SKILL.md'
const DISABLED_SKILL_FILE = 'SKILL.md.disabled'

/** Everything a plugin skill that ships inside the app needs: install it from
 *  the bundled copy, read its state from disk, and flip it on and off by
 *  renaming the file (the same switch the Skills tab uses). */
export interface BundledSkill {
  name: string
  markdown(): string
  dir(home?: string): string
  status(home?: string): BrowserSkillStatus
  isActive(home?: string): boolean
  setEnabled(enabled: boolean, home?: string): Promise<BrowserSkillStatus>
  install(home?: string, options?: { force?: boolean; timeoutMs?: number; today?: string }): Promise<BrowserSkillInstallResult>
  uninstall(home?: string, options?: { force?: boolean }): Promise<{ removed: boolean; conflict?: 'user-copy' }>
  checkUpdate(home?: string, options?: { timeoutMs?: number }): Promise<BrowserSkillUpdateCheck>
}

/**
 * Build the helpers for one bundled plugin skill. `label` names the plugin in
 * errors and in the install stamp ("from the <from> on <date>").
 */
export function bundledSkill(name: string, label: string, from: string): BundledSkill {
  const source = path.join(__dirname, '..', 'skills', name, SKILL_FILE)
  const hashRe = new RegExp(`<!-- Installed by Codey: ${name} ([0-9a-f]{40}|${BUNDLED_SKILL_MARK}) `)
  let cached: string | undefined

  const stamp = (markdown: string, today: string): string => {
    const line = `${CODEY_INSTALL_MARKER} ${name} ${BUNDLED_SKILL_MARK} from ${from} on ${today}. `
      + 'Manage it in Tools -> Plugins; edits here are replaced by the next update. -->'
    const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(markdown)
    if (!frontmatter) return `${line}\n\n${markdown}`
    const head = markdown.slice(0, frontmatter[0].length)
    const body = markdown.slice(frontmatter[0].length).replace(/^\n+/, '')
    return `${head}\n${line}\n\n${body}`
  }

  const markdown = (): string => {
    if (cached === undefined) cached = fs.readFileSync(source, 'utf8')
    return cached
  }

  const dir = (home: string = os.homedir()): string =>
    path.join(path.resolve(home), CODEY_GLOBAL_SKILLS_SUBDIR, name)

  const status = (home: string = os.homedir()): BrowserSkillStatus => {
    const skillDir = dir(home)
    const base = { dir: skillDir, sourceUrl: 'Bundled with Codey' }
    for (const [file, state] of [[SKILL_FILE, 'installed'], [DISABLED_SKILL_FILE, 'disabled']] as const) {
      try {
        const text = fs.readFileSync(path.join(skillDir, file), 'utf8')
        const managed = text.includes(`${CODEY_INSTALL_MARKER} ${name} `)
        return { ...base, state, origin: managed ? 'codey' : 'user', hash: hashRe.exec(text)?.[1] }
      } catch { /* try disabled, then absent */ }
    }
    return { ...base, state: 'absent' }
  }

  const install: BundledSkill['install'] = async (
    home = os.homedir(),
    { force = false, today = new Date().toISOString().slice(0, 10) } = {},
  ) => {
    const skillDir = dir(home)
    if (!force && status(home).origin === 'user') return { installed: false, conflict: 'user-copy', dir: skillDir }
    await fs.promises.mkdir(skillDir, { recursive: true })
    const file = path.join(skillDir, SKILL_FILE)
    await fs.promises.writeFile(file, stamp(markdown(), today), 'utf8')
    await fs.promises.rm(path.join(skillDir, DISABLED_SKILL_FILE), { force: true })
    return { installed: true, file, source: 'bundled' }
  }

  return {
    name,
    markdown,
    dir,
    status,
    isActive: (home = os.homedir()) => status(home).state === 'installed',
    install,
    async setEnabled(enabled, home = os.homedir()) {
      const current = status(home)
      if (enabled && current.state === 'absent') {
        const result = await install(home)
        if (!result.installed) throw new Error(`A user-managed ${label} skill blocks the built-in plugin`)
      } else if (enabled && current.state === 'disabled') {
        await fs.promises.rename(path.join(current.dir, DISABLED_SKILL_FILE), path.join(current.dir, SKILL_FILE))
      } else if (!enabled && current.state === 'installed') {
        const disabled = path.join(current.dir, DISABLED_SKILL_FILE)
        if (fs.existsSync(disabled)) throw new Error(`Cannot disable ${label}: ${disabled} already exists`)
        await fs.promises.rename(path.join(current.dir, SKILL_FILE), disabled)
      }
      return status(home)
    },
    async uninstall(home = os.homedir(), { force = false } = {}) {
      if (!force && status(home).origin === 'user') return { removed: false, conflict: 'user-copy' }
      try { await fs.promises.rm(dir(home), { recursive: true, force: true }); return { removed: true } }
      catch { return { removed: false } }
    },
    async checkUpdate(home = os.homedir()) {
      let recorded: string | undefined
      try { recorded = hashRe.exec(fs.readFileSync(path.join(dir(home), SKILL_FILE), 'utf8'))?.[1] }
      catch { /* absent */ }
      return { recorded, current: BUNDLED_SKILL_MARK, needsUpdate: false }
    },
  }
}
