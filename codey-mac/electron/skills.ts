import type * as Fs from 'fs'
import type * as Path from 'path'

export type SkillScope = 'user' | 'project'

export const SKILL_FILE = 'SKILL.md'
/** Renaming to this hides the skill from CLIs that discover skills by SKILL.md. */
export const DISABLED_SKILL_FILE = `${SKILL_FILE}.disabled`

export interface ScannedSkill {
  name: string
  qualifiedName: string
  managedBy?: string
  description: string
  scope: SkillScope
  dir: string
  enabled: boolean
}

export function parseSkillFrontmatter(md: string): { name: string; description: string } {
  const fmMatch = md.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return { name: '', description: '' }
  const fm = fmMatch[1]
  const nameMatch = fm.match(/^name:[ \t]*(.+)$/m)
  const descMatch = fm.match(/^description:[ \t]*(.+)$/m)
  return {
    name: (nameMatch?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2'),
    description: (descMatch?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2'),
  }
}

/** Expand paths typed in the UI. Node's fs APIs deliberately do not expand ~. */
export function resolveUserPath(pathMod: typeof Path, value: string, home: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return pathMod.resolve(home)
  if (trimmed.startsWith(`~${pathMod.sep}`) || trimmed.startsWith('~/')) {
    return pathMod.resolve(home, trimmed.slice(2))
  }
  return pathMod.resolve(trimmed)
}

function isDirectory(fsMod: typeof Fs, dir: string): boolean {
  try { return fsMod.statSync(dir).isDirectory() } catch { return false }
}

/** Preserve the collection namespace for skills nested below a shared root. */
export function qualifySkillName(
  pathMod: typeof Path,
  root: string,
  skillDir: string,
  name: string,
): string {
  if (name.includes(':')) return name
  const parts = pathMod.relative(pathMod.resolve(root), pathMod.resolve(skillDir))
    .split(pathMod.sep)
    .filter(Boolean)
  if (parts.length < 2) return name
  const collection = parts[0]
  if (!collection || collection.startsWith('.') || collection === 'skills') return name
  return `${collection}:${name}`
}

/**
 * Discover skills below an agent's configured root. Nested roots are supported
 * (for example Codex's .system skills); once a SKILL.md, or a disabled one, is
 * found, that directory is treated as the skill boundary and its internals are
 * not scanned again.
 */
export function scanSkillsDir(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  dir: string,
  scope: SkillScope,
): ScannedSkill[] {
  if (!isDirectory(fsMod, dir)) return []
  const root = pathMod.resolve(dir)
  const result: ScannedSkill[] = []
  const pending = [root]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const current = pending.pop()!
    let real = current
    try { real = fsMod.realpathSync(current) } catch { /* use resolved path */ }
    if (visited.has(real)) continue
    visited.add(real)

    // A disabled skill is still a skill: it marks the boundary so we neither
    // lose it from the list nor walk its internals as if they were roots.
    const activePath = pathMod.join(current, SKILL_FILE)
    const disabledPath = pathMod.join(current, DISABLED_SKILL_FILE)
    const enabled = fsMod.existsSync(activePath)
    const skillMdPath = enabled ? activePath : disabledPath
    if (enabled || fsMod.existsSync(disabledPath)) {
      try {
        const md = fsMod.readFileSync(skillMdPath, 'utf-8')
        const { name, description } = parseSkillFrontmatter(md)
        const resolvedName = name || pathMod.basename(current)
        result.push({
          name: resolvedName,
          qualifiedName: qualifySkillName(pathMod, root, current, resolvedName),
          description,
          scope,
          dir: current,
          enabled,
        })
      } catch { /* skip unreadable skill */ }
      continue
    }

    let entries: import('fs').Dirent[] = []
    try { entries = fsMod.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const child = pathMod.join(current, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(fsMod, child))) pending.push(child)
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** Discover Claude plugin skills using the installed plugin id as namespace. */
export function scanClaudePluginSkills(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  manifestPath: string,
): ScannedSkill[] {
  let manifest: any
  try { manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf-8')) } catch { return [] }
  if (!manifest?.plugins || typeof manifest.plugins !== 'object') return []

  const result: ScannedSkill[] = []
  for (const [pluginId, rawInstalls] of Object.entries(manifest.plugins)) {
    const collection = pluginId.split('@')[0]?.trim()
    if (!collection || !Array.isArray(rawInstalls)) continue
    for (const raw of rawInstalls) {
      const install = raw as { installPath?: unknown; scope?: unknown }
      if (typeof install.installPath !== 'string') continue
      const scope: SkillScope = install.scope === 'project' ? 'project' : 'user'
      for (const skill of scanSkillsDir(fsMod, pathMod, install.installPath, scope)) {
        result.push({
          ...skill,
          qualifiedName: skill.name.includes(':') ? skill.name : `${collection}:${skill.name}`,
          managedBy: pluginId,
        })
      }
    }
  }
  return result.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
}

/**
 * Toggle a skill by renaming its SKILL.md. Agent CLIs only load a directory
 * whose skill file is named exactly SKILL.md, so the rename is what actually
 * disables it — there is no separate state to keep in sync.
 *
 * Never renames over an existing target: a directory holding both files (an
 * installed collection can carry one in) may hold a hand-written backup, so
 * disabling that reports an error rather than silently clobbering it.
 * Enabling with both present is deliberately a no-op rather than an error —
 * the skill genuinely is enabled, and the disabled copy is only litter.
 */
export function setSkillEnabled(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  dir: string,
  enabled: boolean,
): void {
  const activePath = pathMod.join(dir, SKILL_FILE)
  const disabledPath = pathMod.join(dir, DISABLED_SKILL_FILE)
  const target = enabled ? activePath : disabledPath
  const source = enabled ? disabledPath : activePath
  if (fsMod.existsSync(target)) {
    if (enabled || !fsMod.existsSync(source)) return // already in the requested state
    throw new Error(`Cannot disable: ${DISABLED_SKILL_FILE} already exists in ${dir} — remove or rename it first`)
  }
  if (!fsMod.existsSync(source)) throw new Error(`No SKILL.md found in: ${dir}`)
  fsMod.renameSync(source, target)
}

export function samePath(fsMod: typeof Fs, pathMod: typeof Path, a: string, b: string): boolean {
  const resolvedA = pathMod.resolve(a)
  const resolvedB = pathMod.resolve(b)
  if (resolvedA === resolvedB) return true
  try { return fsMod.realpathSync(resolvedA) === fsMod.realpathSync(resolvedB) } catch { return false }
}

export function uniqueSkills(fsMod: typeof Fs, pathMod: typeof Path, skills: ScannedSkill[]): ScannedSkill[] {
  const seen = new Set<string>()
  return skills.filter(skill => {
    let key = pathMod.resolve(skill.dir)
    try { key = fsMod.realpathSync(key) } catch { /* use resolved path */ }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Tag one installed skill with the product/plugin that owns its lifecycle.
 *  Path identity follows symlinks so the same Codey skill is labelled when it
 *  is viewed through any agent's discovery directory. */
export function markSkillManagedBy(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  skills: ScannedSkill[],
  managedDir: string,
  managedBy: string,
): ScannedSkill[] {
  return skills.map(skill => (
    samePath(fsMod, pathMod, skill.dir, managedDir)
      ? { ...skill, managedBy }
      : skill
  ))
}

/**
 * Delete the short-lived `~/.codey/managed-skills` root and the discovery links
 * pointing into it. Skills Codey owned on the user's behalf lived there for one
 * development build, before installing them into the user's own
 * `~/.codey/skills` replaced the idea. A leftover link matters: it targets a
 * directory outside the sync's source root, so `syncCodeyGlobalSkills` reads it
 * as a conflict and declines to link the real skill — an install that reports
 * success and reaches no agent.
 */
export function removeLegacyManagedSkills(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  home: string,
  discoverySubdirs: readonly string[],
): void {
  const legacyRoot = pathMod.join(home, '.codey', 'managed-skills')
  if (!fsMod.existsSync(legacyRoot)) return
  for (const subdir of discoverySubdirs) {
    const discoveryRoot = pathMod.join(home, subdir)
    let entries: Fs.Dirent[]
    try { entries = fsMod.readdirSync(discoveryRoot, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue
      const linkPath = pathMod.join(discoveryRoot, entry.name)
      try {
        const target = pathMod.resolve(discoveryRoot, fsMod.readlinkSync(linkPath))
        if (target.startsWith(`${legacyRoot}${pathMod.sep}`)) fsMod.unlinkSync(linkPath)
      } catch { /* leave anything unreadable alone */ }
    }
  }
  fsMod.rmSync(legacyRoot, { recursive: true, force: true })
}
