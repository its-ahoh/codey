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
