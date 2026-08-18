// codey-mac/src/components/automationsModel.ts
// Pure helpers for the Automations view — kept separate for unit tests.

import { isScheduled } from '../../../packages/core/src/types/automation'
import type { AutomationCheck } from '../../../packages/core/src/types/automation'

export interface ScheduleSlotLike { hour: number; minute: number; daysOfWeek?: number[] }
export interface ScheduleLike { slots: ScheduleSlotLike[]; tz: string }
export interface ScheduleSlotInput { time: string; days: number[] }

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

/** Slots collapsed into one label per distinct day-set, e.g. ["daily 09:00"]. */
function scheduleGroupLabels(s: ScheduleLike, maxTimes = Infinity): string[] {
  const groups = new Map<string, { days: number[]; times: string[] }>()
  for (const slot of s.slots) {
    const days = [...(slot.daysOfWeek ?? [])].sort((a, b) => a - b)
    const key = days.join(',')
    const group = groups.get(key) ?? { days, times: [] }
    group.times.push(`${pad(slot.hour)}:${pad(slot.minute)}`)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => {
    const shown = group.times.slice(0, maxTimes)
    const extra = group.times.length - shown.length
    return `${dayLabel(group.days)} ${shown.join(', ')}${extra ? ` +${extra}` : ''}`
  })
}

export function scheduleSummary(s: ScheduleLike | undefined): string {
  if (!s) return 'manual'
  return scheduleGroupLabels(s).join(' · ')
}

/** One-line schedule label for a list row. A single day-set is spelled out
 *  ("Mon–Fri 09:00"); anything more elaborate would be truncated mid-word, so
 *  it collapses to a cadence instead and leaves the detail to the tooltip and
 *  the one-pager. */
export function scheduleChipLabel(s: ScheduleLike | undefined, maxTimes = 3): string {
  if (!s) return 'Manual'
  const labels = scheduleGroupLabels(s, maxTimes)
  if (labels.length === 1) return labels[0].charAt(0).toUpperCase() + labels[0].slice(1)
  const days = new Set<number>()
  const times = new Set<string>()
  let runsPerWeek = 0
  for (const slot of s.slots) {
    const slotDays = slot.daysOfWeek?.length ? slot.daysOfWeek : [0, 1, 2, 3, 4, 5, 6]
    for (const day of slotDays) days.add(day)
    times.add(`${pad(slot.hour)}:${pad(slot.minute)}`)
    runsPerWeek += slotDays.length
  }
  // Same clock time on an irregular set of days is common enough to name.
  if (times.size === 1) return `${[...times][0]} · ${days.size} days/wk`
  return `${runsPerWeek} runs/wk · ${times.size} times`
}

function dayLabel(days: number[]): string {
  if (days.length === 0 || days.length === 7) return 'daily'
  const contiguous = days.length > 1 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  return contiguous
    ? `${DAY[days[0]]}–${DAY[days[days.length - 1]]}`
    : days.map(d => DAY[d]).join(', ')
}

/** Build a schedule from linked time/day inputs; null when any slot is invalid. */
export function slotsToSchedule(inputs: ScheduleSlotInput[], tz: string): ScheduleLike | null {
  if (inputs.length === 0) return null
  const slots: ScheduleSlotLike[] = []
  for (const input of inputs) {
    const m = input.time.match(/^(\d{1,2}):(\d{1,2})$/)
    if (!m) return null
    const hour = Number(m[1]); const minute = Number(m[2])
    if (hour > 23 || minute > 59) return null
    const days = [...new Set(input.days)].sort((a, b) => a - b)
    if (!days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) return null
    const slot = { hour, minute, ...(days.length && days.length < 7 ? { daysOfWeek: days } : {}) }
    const key = `${hour}:${minute}:${slot.daysOfWeek?.join(',') ?? '*'}`
    if (!slots.some(existing => `${existing.hour}:${existing.minute}:${existing.daysOfWeek?.join(',') ?? '*'}` === key)) slots.push(slot)
  }
  slots.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)
    || (a.daysOfWeek?.join(',') ?? '').localeCompare(b.daysOfWeek?.join(',') ?? ''))
  return { slots, tz }
}

// ---- Notify mode ----

export type NotifyMode = 'all' | 'failure' | 'success' | 'none'

export const NOTIFY_OPTIONS: ReadonlyArray<{ value: NotifyMode; label: string }> = [
  { value: 'all', label: 'All runs' },
  { value: 'failure', label: 'Failures only' },
  { value: 'success', label: 'Successes only' },
  { value: 'none', label: 'Never' },
]

export function notifyLabel(mode: NotifyMode): string {
  return NOTIFY_OPTIONS.find(o => o.value === mode)!.label.toLowerCase()
}

// ---- One-pager helpers ----

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number }
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const fmtCache = new Map<string, Intl.DateTimeFormat>()

function localParts(ms: number, tz: string): LocalParts {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  const parts: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, dayOfWeek: DOW[parts.weekday] ?? 0,
  }
}

/** Instant when the wall clock in `tz` reads y-m-d h:min (double-corrected for DST). */
function zonedInstant(y: number, mo: number, d: number, h: number, min: number, tz: string): number {
  const want = Date.UTC(y, mo - 1, d, h, min)
  let guess = want
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz)
    guess += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  }
  return guess
}

/** Next firing instant strictly after nowMs, or null for manual-only. */
export function nextRunAt(s: ScheduleLike | undefined, nowMs: number): number | null {
  if (!s) return null
  const base = localParts(nowMs, s.tz)
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    // Iterate calendar days (Date.UTC normalizes day overflow) so a real-time
    // step across a spring-forward transition can never skip a date.
    const candidates = s.slots
      .map(slot => ({ slot, instant: zonedInstant(base.year, base.month, base.day + dayOffset, slot.hour, slot.minute, s.tz) }))
      .filter(candidate => candidate.instant > nowMs)
      .sort((a, b) => a.instant - b.instant)
    for (const candidate of candidates) {
      const dow = localParts(candidate.instant, s.tz).dayOfWeek
      if (candidate.slot.daysOfWeek?.length && !candidate.slot.daysOfWeek.includes(dow)) continue
      return candidate.instant
    }
  }
  return null
}

export function humanizeDelta(ms: number): string {
  if (ms < 60_000) return 'in <1m'
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`
  return `in ${Math.round(ms / 86_400_000)}d`
}

export function formatHHMM(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`
}

/** Staged, directly-editable knobs shown on the one-pager Overview tab. */
export interface Knobs {
  params: Record<string, string>
  scheduleOn: boolean
  slots: ScheduleSlotInput[]
  notify: NotifyMode
  /** true = each run gets a throwaway worktree; false = the workspace checkout. */
  isolated: boolean
}

interface KnobSource {
  enabled?: boolean
  params: Record<string, string>
  schedule?: ScheduleLike
  report: { notify: NotifyMode }
  target?: { sandbox?: boolean }
}

/** Seed knobs from an automation. Days are sorted so an unsorted persisted
 *  weekday order can't create a phantom-dirty state. */
export function knobsFrom(a: KnobSource): Knobs {
  return {
    params: { ...a.params },
    scheduleOn: isScheduled(a),
    slots: a.schedule
      ? a.schedule.slots.map(slot => ({ time: formatHHMM(slot.hour, slot.minute), days: [...(slot.daysOfWeek ?? [])].sort((x, y) => x - y) }))
      : [{ time: '09:00', days: [] }],
    notify: a.report.notify,
    isolated: !!a.target?.sandbox,
  }
}

/** True when the staged knobs match the automation (nothing to save). */
export function knobsEqual(k: Knobs, a: KnobSource): boolean {
  if (JSON.stringify(k.params) !== JSON.stringify(a.params)) return false
  if (k.scheduleOn !== isScheduled(a)) return false
  if (k.scheduleOn) {
    const canonical = (slots: ScheduleSlotInput[]) => slots
      .map(slot => ({ time: slot.time, days: [...slot.days].sort((x, y) => x - y) }))
      .sort((x, y) => x.time.localeCompare(y.time) || x.days.join(',').localeCompare(y.days.join(',')))
    const actual = (a.schedule?.slots ?? []).map(slot => ({ time: formatHHMM(slot.hour, slot.minute), days: [...(slot.daysOfWeek ?? [])] }))
    if (JSON.stringify(canonical(k.slots)) !== JSON.stringify(canonical(actual))) return false
  }
  if (k.isolated !== !!a.target?.sandbox) return false
  return k.notify === a.report.notify
}

export interface DraftLike {
  name?: string
  brief?: string
  target?: { kind?: 'prompt' | 'team'; workspaceName?: string; teamName?: string }
}

/** Client-side gate for the Create/Save button in the authoring chat. */
export function draftComplete(d: DraftLike): boolean {
  return !!(
    d.name?.trim() && d.brief?.trim() && d.target?.workspaceName?.trim()
    && (d.target.kind !== 'team' || d.target.teamName?.trim())
  )
}

export type CheckTone = 'pending' | 'ok' | 'warn' | 'muted'

export interface CheckChip {
  tone: CheckTone
  /** Short label shown beside the automation title. */
  label: string
  /** Tooltip, and the heading of the detail panel. */
  title: string
  /** Present for 'gaps'. */
  questions?: string[]
  /** Present for 'error'. */
  detail?: string
  /** Only a finished check with something to show opens the detail panel. */
  expandable: boolean
}

/** Compact dry-run status shown next to the automation title. Every state is
 *  representable: the chip is a glance, the detail panel carries the words. */
export function checkChip(check: AutomationCheck | undefined): CheckChip | null {
  switch (check?.status) {
    case 'pending':
      return { tone: 'pending', label: 'Dry run…', title: 'Dry run in progress', expandable: false }
    case 'clean':
      return { tone: 'ok', label: 'Dry run OK', title: 'Dry run passed', expandable: false }
    case 'gaps': {
      const questions = check.questions ?? []
      return {
        tone: 'warn',
        label: `${questions.length} ${questions.length === 1 ? 'issue' : 'issues'}`,
        title: 'Dry run found things to pin down',
        questions, expandable: true,
      }
    }
    case 'error':
      return { tone: 'muted', label: 'Dry run failed', title: 'Last dry run didn’t complete', detail: check.detail, expandable: true }
    default:
      return null
  }
}
