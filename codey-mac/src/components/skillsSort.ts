import type { SkillEntry, SkillUsage, SkillUsageMap } from '../codey-api'

export type SkillSortMode = 'name' | 'recent' | 'frequent'

export const SKILL_SORT_MODES: { key: SkillSortMode; label: string; title: string }[] = [
  { key: 'name',     label: 'Name',          title: 'Alphabetical by name' },
  { key: 'recent',   label: 'Recently used', title: 'Most recently used first (LRU)' },
  { key: 'frequent', label: 'Most used',     title: 'Most frequently used first (LFU)' },
]

const NO_USAGE: SkillUsage = { count: 0, lastUsedAt: 0 }

/**
 * A skill is invoked by its qualified name (`superpowers:brainstorming`), but
 * transcripts from before a skill was namespaced — and skills installed
 * outside a collection — carry the bare name, so both are worth checking.
 */
export function usageFor(usage: SkillUsageMap, skill: SkillEntry): SkillUsage {
  return usage[skill.qualifiedName.toLowerCase()] ?? usage[skill.name.toLowerCase()] ?? NO_USAGE
}

const byName = (a: SkillEntry, b: SkillEntry) => a.qualifiedName.localeCompare(b.qualifiedName)

/** Sort a copy of `skills`; ties and never-used skills fall back to name order. */
export function sortSkills(skills: SkillEntry[], mode: SkillSortMode, usage: SkillUsageMap): SkillEntry[] {
  const sorted = [...skills]
  if (mode === 'name') return sorted.sort(byName)
  return sorted.sort((a, b) => {
    const ua = usageFor(usage, a)
    const ub = usageFor(usage, b)
    if (mode === 'recent') {
      if (ub.lastUsedAt !== ua.lastUsedAt) return ub.lastUsedAt - ua.lastUsedAt
      if (ub.count !== ua.count) return ub.count - ua.count
    } else {
      if (ub.count !== ua.count) return ub.count - ua.count
      if (ub.lastUsedAt !== ua.lastUsedAt) return ub.lastUsedAt - ua.lastUsedAt
    }
    return byName(a, b)
  })
}

/** Compact "used 4× · 3d ago" line for a card; empty when never used. */
export function usageLabel(usage: SkillUsage, now: number): string {
  if (usage.count === 0) return ''
  const times = `used ${usage.count}×`
  if (!usage.lastUsedAt) return times
  return `${times} · ${relativeTime(usage.lastUsedAt, now)}`
}

/** Structured copy lets the card give calls and recency their own visual weight. */
export function usageMeta(usage: SkillUsage, now: number): { calls: string; recency?: string } | null {
  if (usage.count === 0) return null
  return {
    calls: `${usage.count} ${usage.count === 1 ? 'call' : 'calls'}`,
    recency: usage.lastUsedAt ? relativeTime(usage.lastUsedAt, now) : undefined,
  }
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.round(days / 30)}mo ago`
}
