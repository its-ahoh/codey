import type * as Fs from 'fs'
import type * as Path from 'path'

export interface SkillUsage {
  /** How many times the skill was invoked across all recorded sessions. */
  count: number
  /** Epoch ms of the most recent invocation, or 0 when unknown. */
  lastUsedAt: number
}

/** Usage keyed by the skill id as it was invoked, lowercased. */
export type SkillUsageMap = Record<string, SkillUsage>

export interface UsageCacheEntry {
  mtimeMs: number
  size: number
  usage: SkillUsageMap
}

/** Cheap pre-filter so we only JSON.parse the handful of lines that matter. */
const SKILL_TOOL_HINT = '"name":"Skill"'

function record(into: SkillUsageMap, id: string, at: number): void {
  const key = id.trim().toLowerCase()
  if (!key) return
  const prev = into[key]
  if (prev) {
    prev.count += 1
    if (at > prev.lastUsedAt) prev.lastUsedAt = at
  } else {
    into[key] = { count: 1, lastUsedAt: at }
  }
}

/**
 * Extract Skill tool invocations from one agent transcript (JSONL).
 *
 * Agents log every tool call, so the transcripts are the only record of what a
 * skill was actually used for — nothing in the app writes usage stats itself.
 */
export function collectUsageFromTranscript(text: string): SkillUsageMap {
  const usage: SkillUsageMap = {}
  for (const line of text.split('\n')) {
    if (!line.includes(SKILL_TOOL_HINT)) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    const at = Date.parse(entry?.timestamp ?? '')
    for (const block of content) {
      if (block?.type !== 'tool_use' || block?.name !== 'Skill') continue
      const id = block?.input?.skill
      if (typeof id === 'string') record(usage, id, Number.isNaN(at) ? 0 : at)
    }
  }
  return usage
}

export function mergeUsage(target: SkillUsageMap, extra: SkillUsageMap): SkillUsageMap {
  for (const [key, value] of Object.entries(extra)) {
    const prev = target[key]
    if (prev) {
      prev.count += value.count
      if (value.lastUsedAt > prev.lastUsedAt) prev.lastUsedAt = value.lastUsedAt
    } else {
      target[key] = { count: value.count, lastUsedAt: value.lastUsedAt }
    }
  }
  return target
}

function collectTranscriptFiles(fsMod: typeof Fs, pathMod: typeof Path, root: string): string[] {
  const files: string[] = []
  const pending = [root]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    let entries: Fs.Dirent[] = []
    try { entries = fsMod.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const child = pathMod.join(current, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child)
    }
  }
  return files
}

/**
 * Aggregate skill usage across an agent's transcript roots. Transcripts are
 * append-only, but a single history can run to hundreds of megabytes, so
 * results are cached per file and only re-read when size or mtime moves.
 */
export async function scanSkillUsage(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  roots: string[],
  cache: Map<string, UsageCacheEntry>,
): Promise<SkillUsageMap> {
  const total: SkillUsageMap = {}
  for (const root of roots) {
    for (const file of collectTranscriptFiles(fsMod, pathMod, root)) {
      let stat: Fs.Stats
      try { stat = fsMod.statSync(file) } catch { continue }
      const cached = cache.get(file)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        mergeUsage(total, cached.usage)
        continue
      }
      let text: string
      try { text = await fsMod.promises.readFile(file, 'utf-8') } catch { continue }
      const usage = collectUsageFromTranscript(text)
      cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage })
      mergeUsage(total, usage)
    }
  }
  return total
}
