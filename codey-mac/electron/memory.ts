import type * as Fs from 'fs'
import type * as Path from 'path'
import { resolveUserPath } from './skills'

/**
 * Agent "memory" — the instruction files each CLI loads on its own before a
 * prompt is sent. Every agent Codey drives supports at least one such file:
 *
 *   claude-code  ~/.claude/CLAUDE.md, <project>/CLAUDE.md (+ its auto-memory
 *                directory ~/.claude/projects/<slug>/memory/*.md)
 *   codex        ~/.codex/AGENTS.md, <project>/AGENTS.md
 *   opencode     ~/.config/opencode/AGENTS.md, <project>/AGENTS.md
 *   pi           ~/.pi/agent/AGENTS.md, <project>/AGENTS.md or CLAUDE.md
 *
 * This module only reads: memory is owned by the CLIs and by the user.
 */

export type MemoryScope = 'user' | 'project'

export interface MemoryEntry {
  scope: MemoryScope
  /** Absolute path of the file. */
  path: string
  /** Short label shown in the UI, e.g. "CLAUDE.md" or "memory/node.md". */
  label: string
  bytes: number
  mtimeMs: number
  /** File contents, capped at MAX_MEMORY_BYTES. */
  content: string
  truncated: boolean
}

export interface AgentMemorySpec {
  /** Files below the user's home directory, most global first. */
  userFiles: string[]
  /** Files below the workspace working directory. */
  projectFiles: string[]
  /** Directories of loose memory files below the home directory. */
  userDirs?: string[]
}

/** Read no more than this per file — memory files are prose, not payloads. */
export const MAX_MEMORY_BYTES = 20000
/** Cap on files listed from one memory directory. */
export const MAX_DIR_FILES = 200

export const AGENT_MEMORY: Record<string, AgentMemorySpec> = {
  'claude-code': {
    userFiles: ['.claude/CLAUDE.md'],
    projectFiles: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
  },
  'codex': {
    userFiles: ['.codex/AGENTS.md'],
    projectFiles: ['AGENTS.md'],
  },
  'opencode': {
    userFiles: ['.config/opencode/AGENTS.md'],
    projectFiles: ['AGENTS.md', '.opencode/AGENTS.md'],
  },
  'pi': {
    // pi prefers AGENTS.override.md when a directory has one.
    userFiles: ['.pi/agent/AGENTS.md'],
    projectFiles: ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'],
  },
}

/**
 * Claude Code stores a project's auto-memory under a slug of its absolute
 * path, with every non-alphanumeric character replaced by a dash.
 */
export function claudeProjectSlug(workingDir: string): string {
  return workingDir.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Home-directory root an agent's user-level config lives under, honouring env overrides. */
export function agentConfigRoot(
  pathMod: typeof Path,
  agent: string,
  home: string,
  env: Record<string, string>,
): string | null {
  if (agent === 'claude-code' && env.CLAUDE_CONFIG_DIR) {
    return resolveUserPath(pathMod, env.CLAUDE_CONFIG_DIR, home)
  }
  if (agent === 'codex' && env.CODEX_HOME) {
    return resolveUserPath(pathMod, env.CODEX_HOME, home)
  }
  if (agent === 'opencode' && env.XDG_CONFIG_HOME) {
    return pathMod.join(resolveUserPath(pathMod, env.XDG_CONFIG_HOME, home), 'opencode')
  }
  return null
}

/** Absolute user-scope memory files for an agent, most global first. */
export function userMemoryFiles(
  pathMod: typeof Path,
  agent: string,
  home: string,
  env: Record<string, string>,
): string[] {
  const spec = AGENT_MEMORY[agent]
  if (!spec) return []
  const root = agentConfigRoot(pathMod, agent, home, env)
  const files = spec.userFiles.map(rel => pathMod.join(home, rel))
  if (!root) return files
  // An override replaces the default location rather than adding to it.
  const overridden = spec.userFiles.map(rel => pathMod.join(root, pathMod.basename(rel)))
  return [...overridden, ...files.filter(f => !overridden.includes(f))]
}

/**
 * Per-project memory directories claude-code keeps for a working directory:
 * its own auto-memory (kept under the home config dir but keyed by project
 * path) and the subagent memory dirs that live inside the repository.
 */
export function projectMemoryDirs(
  pathMod: typeof Path,
  agent: string,
  home: string,
  env: Record<string, string>,
  workingDir: string,
): string[] {
  if (agent !== 'claude-code') return []
  const root = agentConfigRoot(pathMod, agent, home, env) ?? pathMod.join(home, '.claude')
  return [
    pathMod.join(root, 'projects', claudeProjectSlug(workingDir), 'memory'),
    // Official subagent memory: agent-memory is committed, -local is not.
    pathMod.join(workingDir, '.claude', 'agent-memory'),
    pathMod.join(workingDir, '.claude', 'agent-memory-local'),
  ]
}

function readEntry(
  fsMod: typeof Fs,
  file: string,
  scope: MemoryScope,
  label: string,
): MemoryEntry | null {
  let stat: Fs.Stats
  try {
    stat = fsMod.statSync(file)
  } catch { return null }
  if (!stat.isFile()) return null
  let content = ''
  try {
    content = fsMod.readFileSync(file, 'utf-8')
  } catch { return null }
  const truncated = content.length > MAX_MEMORY_BYTES
  return {
    scope,
    path: file,
    label,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    content: truncated ? content.slice(0, MAX_MEMORY_BYTES) : content,
    truncated,
  }
}

/**
 * Markdown files inside a memory directory, name-sorted. Subagent memory nests
 * one level deeper (agent-memory/<agent>/note.md), so a shallow tree is walked
 * and labels stay relative to the directory the scan started from.
 */
export function scanMemoryDir(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  dir: string,
  scope: MemoryScope,
  depth = 1,
): MemoryEntry[] {
  let names: string[]
  try {
    names = fsMod.readdirSync(dir)
  } catch { return [] }
  const base = pathMod.basename(dir)
  const files: MemoryEntry[] = []
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (files.length >= MAX_DIR_FILES) break
    const full = pathMod.join(dir, name)
    if (name.toLowerCase().endsWith('.md')) {
      const entry = readEntry(fsMod, full, scope, `${base}/${name}`)
      if (entry) files.push(entry)
      continue
    }
    if (depth <= 0 || name.startsWith('.')) continue
    let isDir = false
    try { isDir = fsMod.statSync(full).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const nested of scanMemoryDir(fsMod, pathMod, full, scope, depth - 1)) {
      files.push({ ...nested, label: `${base}/${nested.label}` })
    }
  }
  return files.slice(0, MAX_DIR_FILES)
}

/**
 * What an agent knows about the USER, independent of any project: the one
 * global instruction file each CLI reads from the home directory.
 */
export function scanUserMemory(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  agent: string,
  home: string,
  env: Record<string, string>,
): MemoryEntry[] {
  if (!AGENT_MEMORY[agent]) return []
  const entries: MemoryEntry[] = []
  const seen = new Set<string>()
  for (const file of userMemoryFiles(pathMod, agent, home, env)) {
    if (seen.has(file)) continue
    seen.add(file)
    const entry = readEntry(fsMod, file, 'user', pathMod.basename(file))
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * What an agent knows about ONE project: the repository's own instruction
 * files plus, for claude-code, its per-project memory directories.
 */
export function scanProjectMemory(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  agent: string,
  home: string,
  env: Record<string, string>,
  workingDir: string,
): MemoryEntry[] {
  const spec = AGENT_MEMORY[agent]
  if (!spec) return []
  const seen = new Set<string>()
  const entries: MemoryEntry[] = []
  const push = (entry: MemoryEntry | null) => {
    if (!entry || seen.has(entry.path)) return
    seen.add(entry.path)
    entries.push(entry)
  }

  // pi loads AGENTS.override.md *instead of* the other context files in a
  // directory, so listing them all would misreport what pi actually reads.
  const override = agent === 'pi'
    && spec.projectFiles.includes('AGENTS.override.md')
    && fsMod.existsSync(pathMod.join(workingDir, 'AGENTS.override.md'))
  const files = override ? ['AGENTS.override.md'] : spec.projectFiles.filter(rel => rel !== 'AGENTS.override.md')
  for (const rel of files) {
    push(readEntry(fsMod, pathMod.join(workingDir, rel), 'project', rel))
  }
  for (const dir of projectMemoryDirs(pathMod, agent, home, env, workingDir)) {
    for (const entry of scanMemoryDir(fsMod, pathMod, dir, 'project')) push(entry)
  }
  return entries
}
