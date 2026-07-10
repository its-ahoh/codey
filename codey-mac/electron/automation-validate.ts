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

/** Throws Error('invalid schedule: ...') when the schedule shape is bad. */
export function validateSchedule(schedule: unknown): void {
  if (schedule === undefined || schedule === null) return // manual-only is fine
  const s = schedule as { hour?: unknown; minute?: unknown; tz?: unknown }
  if (typeof s !== 'object') throw new Error('invalid schedule: must be an object')
  if (!Number.isInteger(s.hour) || (s.hour as number) < 0 || (s.hour as number) > 23) {
    throw new Error('invalid schedule: hour must be an integer 0-23')
  }
  if (!Number.isInteger(s.minute) || (s.minute as number) < 0 || (s.minute as number) > 59) {
    throw new Error('invalid schedule: minute must be an integer 0-59')
  }
  if (typeof s.tz !== 'string' || !validTz(s.tz)) {
    throw new Error(`invalid schedule: unknown time zone "${String(s.tz)}"`)
  }
}

/** Create-time validation: schedule (if any) plus a report object with boolean notify. */
export function validateAutomationDraft(draft: any): void {
  validateSchedule(draft?.schedule)
  if (!draft?.report || typeof draft.report !== 'object' || typeof draft.report.notify !== 'boolean') {
    throw new Error('invalid automation: report.notify (boolean) is required')
  }
}

/** Update-time validation: only checks fields present on the patch. */
export function validateAutomationPatch(patch: any): void {
  if (patch && 'schedule' in patch) validateSchedule(patch.schedule)
}
