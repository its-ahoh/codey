import type * as Fs from 'fs'
import type * as Path from 'path'

export type SkillScope = 'user' | 'project'

export interface ScannedSkill {
  name: string
  qualifiedName: string
  managedBy?: string
  description: string
  scope: SkillScope
  dir: string
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
 * (for example Codex's .system skills); once SKILL.md is found, that directory
 * is treated as the skill boundary and its internals are not scanned again.
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

    const skillMdPath = pathMod.join(current, 'SKILL.md')
    if (fsMod.existsSync(skillMdPath)) {
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
