// Pure IPC-boundary validation for automation drafts/patches. Bad data (a
// garbage tz especially — Intl throws RangeError on it) must be rejected here
// so it never reaches the store and starves the scheduler tick. No Electron
// imports so it is unit-testable.

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function validateTime(t: unknown): void {
  const s = t as { hour?: unknown; minute?: unknown }
  if (!s || typeof s !== 'object') throw new Error('invalid schedule: time must be an object')
  if (!Number.isInteger(s.hour) || (s.hour as number) < 0 || (s.hour as number) > 23) {
    throw new Error('invalid schedule: hour must be an integer 0-23')
  }
  if (!Number.isInteger(s.minute) || (s.minute as number) < 0 || (s.minute as number) > 59) {
    throw new Error('invalid schedule: minute must be an integer 0-59')
  }
}

/** Throws Error('invalid schedule: ...') when the schedule shape is bad.
 *  Accepts the current {times: [...]} shape and the legacy single
 *  {hour, minute} shape (the store normalizes legacy data on read). */
export function validateSchedule(schedule: unknown): void {
  if (schedule === undefined || schedule === null) return // manual-only is fine
  const s = schedule as { times?: unknown; tz?: unknown }
  if (typeof s !== 'object') throw new Error('invalid schedule: must be an object')
  if (s.times !== undefined) {
    if (!Array.isArray(s.times) || s.times.length === 0) {
      throw new Error('invalid schedule: times must be a non-empty array')
    }
    for (const t of s.times) validateTime(t)
  } else {
    validateTime(s)
  }
  if (typeof s.tz !== 'string' || !validTz(s.tz)) {
    throw new Error(`invalid schedule: unknown time zone "${String(s.tz)}"`)
  }
}

function validNotify(v: unknown): boolean {
  return v === 'all' || v === 'failure' || v === 'success' || v === 'none'
}

function validateReport(report: unknown): void {
  if (!report || typeof report !== 'object' || !validNotify((report as { notify?: unknown }).notify)) {
    throw new Error('invalid automation: report.notify ("all" | "failure" | "success" | "none") is required')
  }
}

/** Create-time validation: schedule (if any) plus a report object with a valid notify mode. */
export function validateAutomationDraft(draft: any): void {
  validateSchedule(draft?.schedule)
  validateReport(draft?.report)
}

/** Update-time validation: only checks fields present on the patch. */
export function validateAutomationPatch(patch: any): void {
  if (patch && 'schedule' in patch) validateSchedule(patch.schedule)
  if (patch && 'report' in patch) validateReport(patch.report)
}
