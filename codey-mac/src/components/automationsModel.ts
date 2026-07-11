// codey-mac/src/components/automationsModel.ts
// Pure helpers for the Automations view — kept separate for unit tests.

export interface ScheduleLike { hour: number; minute: number; daysOfWeek?: number[]; tz: string }

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

export function scheduleSummary(s: ScheduleLike | undefined): string {
  if (!s) return 'manual'
  const time = `${pad(s.hour)}:${pad(s.minute)}`
  if (!s.daysOfWeek || s.daysOfWeek.length === 0 || s.daysOfWeek.length === 7) return `daily ${time}`
  const days = [...s.daysOfWeek].sort((a, b) => a - b)
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const label = contiguous
    ? `${DAY[days[0]]}–${DAY[days[days.length - 1]]}`
    : days.map(d => DAY[d]).join(', ')
  return `${label} ${time}`
}

/** The interview is the gate: no schedule without a synthesized brief. */
export function canSchedule(a: { brief: string }): boolean {
  return a.brief.trim().length > 0
}

export function timeOfDayToSchedule(hhmm: string, tz: string, daysOfWeek?: number[]): ScheduleLike | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{1,2})$/)
  if (!m) return null
  const hour = Number(m[1]); const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute, tz, ...(daysOfWeek && daysOfWeek.length ? { daysOfWeek } : {}) }
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
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const ref = localParts(nowMs + dayOffset * 86_400_000, s.tz)
    const candidate = zonedInstant(ref.year, ref.month, ref.day, s.hour, s.minute, s.tz)
    if (candidate <= nowMs) continue
    const dow = localParts(candidate, s.tz).dayOfWeek
    if (s.daysOfWeek && s.daysOfWeek.length > 0 && !s.daysOfWeek.includes(dow)) continue
    return candidate
  }
  return null
}

export function humanizeDelta(ms: number): string {
  if (ms < 60_000) return 'in <1m'
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`
  return `in ${Math.round(ms / 86_400_000)}d`
}

export interface DraftLike {
  name?: string
  brief?: string
  target?: { workspaceName?: string }
}

/** Client-side gate for the Create/Save button in the authoring chat. */
export function draftComplete(d: DraftLike): boolean {
  return !!(d.name?.trim() && d.brief?.trim() && d.target?.workspaceName)
}
