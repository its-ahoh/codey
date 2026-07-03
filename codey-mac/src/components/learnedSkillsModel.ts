// Pure view helpers for LearnedSkillsTab — kept renderer-free so vitest (node env) can test them.

export interface EvolutionEventLike {
  at: number
  kind: 'created' | 'evolved' | 'rolled-back'
  fromVersion?: number
  toVersion: number
  trigger?: { runId: string; promptSummary: string }
  steps: string
}

export interface TimelineRow {
  label: string
  when: string
  trigger: string | undefined
  steps: string
}

export function relativeTime(ts: number, now: number): string {
  const mins = Math.floor((now - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const KIND_LABEL: Record<EvolutionEventLike['kind'], string> = {
  'created': 'created',
  'evolved': 'evolved',
  'rolled-back': 'rolled back',
}

export function timelineRows(events: EvolutionEventLike[], now: number): TimelineRow[] {
  return events.map(ev => ({
    label: `v${ev.toVersion} ${KIND_LABEL[ev.kind]}`,
    when: relativeTime(ev.at, now),
    trigger: ev.trigger
      ? (ev.trigger.promptSummary.length > 80
          ? `${ev.trigger.promptSummary.slice(0, 80)}…`
          : ev.trigger.promptSummary)
      : undefined,
    steps: ev.steps,
  }))
}

export function skillActions(s: { archived: boolean; canRollback: boolean }): {
  forget: boolean; restore: boolean; rollback: boolean
} {
  return { forget: !s.archived, restore: s.archived, rollback: !s.archived && s.canRollback }
}
