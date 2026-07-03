import type { AutomationSchedule } from '@codey/core';

/** Wall-clock parts of an instant in an IANA time zone. */
export interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number;
  /** 0=Sun … 6=Sat */
  dayOfWeek: number;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    dayOfWeek: DOW[parts.weekday] ?? 0,
  };
}

/** Minute-granularity identity of the slot `ms` falls in, in `tz`. */
export function slotId(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * True when `now` lands in the schedule's minute slot and that slot hasn't
 * fired yet. Missed slots never match later instants — restart-safe, no
 * back-fire by construction.
 */
export function shouldFire(
  schedule: AutomationSchedule,
  lastFiredAt: number | undefined,
  now: number,
): boolean {
  const p = localParts(now, schedule.tz);
  if (p.hour !== schedule.hour || p.minute !== schedule.minute) return false;
  if (schedule.daysOfWeek && !schedule.daysOfWeek.includes(p.dayOfWeek)) return false;
  if (lastFiredAt !== undefined && slotId(lastFiredAt, schedule.tz) === slotId(now, schedule.tz)) return false;
  return true;
}
