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

export const CHROME_COMPANION_SKILL_NAME = 'chrome-companion'
export const CHROME_COMPANION_SKILL_SOURCE = path.join(
  __dirname, '..', 'skills', CHROME_COMPANION_SKILL_NAME, 'SKILL.md',
)

const SKILL_FILE = 'SKILL.md'
const DISABLED_SKILL_FILE = 'SKILL.md.disabled'
const HASH_RE = new RegExp(
  `<!-- Installed by Codey: ${CHROME_COMPANION_SKILL_NAME} ([0-9a-f]{40}|${BUNDLED_SKILL_MARK}) `,
)
let cached: string | undefined

function installedHash(markdown: string): string | undefined {
  return HASH_RE.exec(markdown)?.[1]
}

function stamp(markdown: string, from: string, hash: string | undefined, today: string): string {
  const line = `${CODEY_INSTALL_MARKER} ${CHROME_COMPANION_SKILL_NAME}${hash ? ` ${hash}` : ''} `
    + `from ${from} on ${today}. `
    + 'Manage it in Tools -> Plugins; edits here are replaced by the next update. -->'
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(markdown)
  if (!frontmatter) return `${line}\n\n${markdown}`
  const head = markdown.slice(0, frontmatter[0].length)
  const body = markdown.slice(frontmatter[0].length).replace(/^\n+/, '')
  return `${head}\n${line}\n\n${body}`
}

function isManaged(markdown: string): boolean {
  return markdown.includes(`${CODEY_INSTALL_MARKER} ${CHROME_COMPANION_SKILL_NAME}`)
}

export function chromeCompanionSkillMarkdown(): string {
  if (cached === undefined) cached = fs.readFileSync(CHROME_COMPANION_SKILL_SOURCE, 'utf8')
  return cached
}

export function chromeCompanionSkillDir(home: string = os.homedir()): string {
  return path.join(path.resolve(home), CODEY_GLOBAL_SKILLS_SUBDIR, CHROME_COMPANION_SKILL_NAME)
}

export function chromeCompanionSkillStatus(home: string = os.homedir()): BrowserSkillStatus {
  const dir = chromeCompanionSkillDir(home)
  const base = { dir, sourceUrl: 'Bundled with Codey' }
  for (const [file, state] of [[SKILL_FILE, 'installed'], [DISABLED_SKILL_FILE, 'disabled']] as const) {
    try {
      const markdown = fs.readFileSync(path.join(dir, file), 'utf8')
      return { ...base, state, origin: isManaged(markdown) ? 'codey' : 'user', hash: installedHash(markdown) }
    } catch { /* try disabled, then absent */ }
  }
  return { ...base, state: 'absent' }
}

export function isChromeCompanionSkillActive(home: string = os.homedir()): boolean {
  return chromeCompanionSkillStatus(home).state === 'installed'
}

/** Enable or disable the built-in capability without deleting its files. The
 *  ordinary skill filename remains the source of truth shared with Agents. */
export async function setChromeCompanionSkillEnabled(
  enabled: boolean,
  home: string = os.homedir(),
): Promise<BrowserSkillStatus> {
  const current = chromeCompanionSkillStatus(home)
  if (enabled && current.state === 'absent') {
    const result = await installChromeCompanionSkill(home)
    if (!result.installed) throw new Error('A user-managed Chrome Companion skill blocks the built-in plugin')
  } else if (enabled && current.state === 'disabled') {
    await fs.promises.rename(path.join(current.dir, DISABLED_SKILL_FILE), path.join(current.dir, SKILL_FILE))
  } else if (!enabled && current.state === 'installed') {
    const disabled = path.join(current.dir, DISABLED_SKILL_FILE)
    try { await fs.promises.access(disabled); throw new Error(`Cannot disable Chrome Companion: ${disabled} already exists`) }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot disable Chrome Companion:')) throw error
    }
    await fs.promises.rename(path.join(current.dir, SKILL_FILE), disabled)
  }
  return chromeCompanionSkillStatus(home)
}

export async function installChromeCompanionSkill(
  home: string = os.homedir(),
  { force = false, today = new Date().toISOString().slice(0, 10) }: {
    force?: boolean; timeoutMs?: number; today?: string
  } = {},
): Promise<BrowserSkillInstallResult> {
  const dir = chromeCompanionSkillDir(home)
  const existing = chromeCompanionSkillStatus(home)
  if (!force && existing.origin === 'user') return { installed: false, conflict: 'user-copy', dir }
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, SKILL_FILE)
  await fs.promises.writeFile(file, stamp(
    chromeCompanionSkillMarkdown(),
    'the Chrome Companion built into Codey',
    BUNDLED_SKILL_MARK,
    today,
  ), 'utf8')
  await fs.promises.rm(path.join(dir, DISABLED_SKILL_FILE), { force: true })
  return { installed: true, file, source: 'bundled' }
}

export async function uninstallChromeCompanionSkill(
  home: string = os.homedir(), { force = false }: { force?: boolean } = {},
): Promise<{ removed: boolean; conflict?: 'user-copy' }> {
  const existing = chromeCompanionSkillStatus(home)
  if (!force && existing.origin === 'user') return { removed: false, conflict: 'user-copy' }
  try { await fs.promises.rm(chromeCompanionSkillDir(home), { recursive: true, force: true }); return { removed: true } }
  catch { return { removed: false } }
}

export async function checkChromeCompanionSkillUpdate(
  home: string = os.homedir(), _options: { timeoutMs?: number } = {},
): Promise<BrowserSkillUpdateCheck> {
  let recorded: string | undefined
  try { recorded = installedHash(fs.readFileSync(path.join(chromeCompanionSkillDir(home), SKILL_FILE), 'utf8')) }
  catch { /* absent */ }
  return { recorded, current: BUNDLED_SKILL_MARK, needsUpdate: false }
}
