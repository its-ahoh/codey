import type * as Fs from 'fs'
import type * as Path from 'path'

export type SkillScope = 'user' | 'project'

export interface ScannedSkill {
  name: string
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
  const result: ScannedSkill[] = []
  const pending = [pathMod.resolve(dir)]
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
        result.push({ name: name || pathMod.basename(current), description, scope, dir: current })
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
