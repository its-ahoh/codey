// codey-mac/src/components/automationsModel.ts
// Pure helpers for the Automations view — kept separate for unit tests.

export interface ScheduleTimeLike { hour: number; minute: number }
export interface ScheduleLike { times: ScheduleTimeLike[]; daysOfWeek?: number[]; tz: string }

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

export function scheduleSummary(s: ScheduleLike | undefined): string {
  if (!s) return 'manual'
  const time = s.times.map(t => `${pad(t.hour)}:${pad(t.minute)}`).join(', ')
  if (!s.daysOfWeek || s.daysOfWeek.length === 0 || s.daysOfWeek.length === 7) return `daily ${time}`
  const days = [...s.daysOfWeek].sort((a, b) => a - b)
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const label = contiguous
    ? `${DAY[days[0]]}–${DAY[days[days.length - 1]]}`
    : days.map(d => DAY[d]).join(', ')
  return `${label} ${time}`
}

/** Build a schedule from "HH:MM" strings; null when empty or any is invalid. */
export function timesToSchedule(hhmms: string[], tz: string, daysOfWeek?: number[]): ScheduleLike | null {
  if (hhmms.length === 0) return null
  const times: ScheduleTimeLike[] = []
  for (const hhmm of hhmms) {
    const m = hhmm.match(/^(\d{1,2}):(\d{1,2})$/)
    if (!m) return null
    const hour = Number(m[1]); const minute = Number(m[2])
    if (hour > 23 || minute > 59) return null
    if (!times.some(t => t.hour === hour && t.minute === minute)) times.push({ hour, minute })
  }
  times.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))
  return { times, tz, ...(daysOfWeek && daysOfWeek.length ? { daysOfWeek } : {}) }
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
    const candidates = s.times
      .map(t => zonedInstant(base.year, base.month, base.day + dayOffset, t.hour, t.minute, s.tz))
      .filter(c => c > nowMs)
      .sort((a, b) => a - b)
    for (const candidate of candidates) {
      const dow = localParts(candidate, s.tz).dayOfWeek
      if (s.daysOfWeek && s.daysOfWeek.length > 0 && !s.daysOfWeek.includes(dow)) continue
      return candidate
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
  /** "HH:MM" strings, one per daily firing time. */
  times: string[]
  days: number[]
  notify: NotifyMode
}

interface KnobSource {
  params: Record<string, string>
  schedule?: ScheduleLike
  report: { notify: NotifyMode }
}

/** Seed knobs from an automation. Days are sorted so an unsorted persisted
 *  daysOfWeek can't create a phantom-dirty state. */
export function knobsFrom(a: KnobSource): Knobs {
  return {
    params: { ...a.params },
    scheduleOn: !!a.schedule,
    times: a.schedule ? a.schedule.times.map(t => formatHHMM(t.hour, t.minute)) : ['09:00'],
    days: [...(a.schedule?.daysOfWeek ?? [])].sort((x, y) => x - y),
    notify: a.report.notify,
  }
}

/** True when the staged knobs match the automation (nothing to save). */
export function knobsEqual(k: Knobs, a: KnobSource): boolean {
  if (JSON.stringify(k.params) !== JSON.stringify(a.params)) return false
  if (k.scheduleOn !== !!a.schedule) return false
  if (k.scheduleOn) {
    const kt = [...k.times].sort()
    const at = (a.schedule?.times ?? []).map(t => formatHHMM(t.hour, t.minute)).sort()
    if (JSON.stringify(kt) !== JSON.stringify(at)) return false
    const kd = [...k.days].sort((x, y) => x - y)
    const ad = [...(a.schedule?.daysOfWeek ?? [])].sort((x, y) => x - y)
    if (JSON.stringify(kd) !== JSON.stringify(ad)) return false
  }
  return k.notify === a.report.notify
}

export interface DraftLike {
  name?: string
  brief?: string
  target?: { workspaceName?: string }
}

/** Client-side gate for the Create/Save button in the authoring chat. */
export function draftComplete(d: DraftLike): boolean {
  return !!(d.name?.trim() && d.brief?.trim() && d.target?.workspaceName?.trim())
}

export type CheckTone = 'dim' | 'good' | 'warn'

/** Status-row label for the authoring dry-run check; null hides the row. */
export function checkLabel(
  check: 'pending' | 'clean' | 'gaps' | 'error' | undefined,
): { text: string; tone: CheckTone } | null {
  switch (check) {
    case 'pending': return { text: 'checking…', tone: 'dim' }
    case 'clean': return { text: 'unattended-ready', tone: 'good' }
    case 'gaps': return { text: 'may need input during runs', tone: 'warn' }
    case 'error': return { text: 'check failed', tone: 'dim' }
    default: return null
  }
}
