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

function validateDays(days: unknown): void {
  if (days !== undefined && (!Array.isArray(days) || !days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) {
    throw new Error('invalid schedule: daysOfWeek must contain integers 0-6')
  }
}

/** Throws Error('invalid schedule: ...') when the schedule shape is bad.
 *  Accepts current {slots: [...]} schedules plus both legacy shapes. */
export function validateSchedule(schedule: unknown): void {
  if (schedule === undefined || schedule === null) return // manual-only is fine
  const s = schedule as { slots?: unknown; times?: unknown; tz?: unknown; daysOfWeek?: unknown }
  if (typeof s !== 'object') throw new Error('invalid schedule: must be an object')
  if (s.slots !== undefined) {
    if (!Array.isArray(s.slots) || s.slots.length === 0) {
      throw new Error('invalid schedule: slots must be a non-empty array')
    }
    for (const slot of s.slots) {
      validateTime(slot)
      validateDays((slot as { daysOfWeek?: unknown }).daysOfWeek)
    }
  } else if (s.times !== undefined) {
    if (!Array.isArray(s.times) || s.times.length === 0) {
      throw new Error('invalid schedule: times must be a non-empty array')
    }
    for (const t of s.times) validateTime(t)
    validateDays(s.daysOfWeek)
  } else {
    validateTime(s)
    validateDays(s.daysOfWeek)
  }
  if (typeof s.tz !== 'string' || !validTz(s.tz)) {
    throw new Error(`invalid schedule: unknown time zone "${String(s.tz)}"`)
  }
}

function validNotify(v: unknown): boolean {
  return v === 'all' || v === 'failure' || v === 'success' || v === 'none'
}

function validateReport(report: unknown): void {
  if (!report || typeof report !== 'object' || Array.isArray(report) || !validNotify((report as { notify?: unknown }).notify)) {
    throw new Error('invalid automation: report.notify ("all" | "failure" | "success" | "none") is required')
  }
  const channel = (report as { channel?: unknown }).channel
  if (channel !== undefined) {
    const c = channel as { platform?: unknown; target?: unknown }
    if (!c || typeof c !== 'object' || Array.isArray(c)
      || typeof c.platform !== 'string' || !c.platform.trim()
      || typeof c.target !== 'string' || !c.target.trim()) {
      throw new Error('invalid automation: report.channel requires platform and target')
    }
  }
}

const CREATE_FIELDS = new Set(['name', 'enabled', 'target', 'brief', 'params', 'schedule', 'report'])
const UPDATE_FIELDS = new Set(['name', 'target', 'brief', 'params', 'schedule', 'report'])
const CHAT_FIELDS = new Set(['name', 'target', 'brief', 'params', 'schedule', 'notify'])
const AGENTS = new Set(['claude-code', 'opencode', 'codex'])

function validateObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid automation: ${label} must be an object`)
  }
}

function validateFields(value: Record<string, unknown>, allowed: Set<string>): void {
  const disallowed = Object.keys(value).filter(k => !allowed.has(k))
  if (disallowed.length) throw new Error(`invalid automation: field cannot be changed: ${disallowed.join(', ')}`)
}

function validateName(value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid automation: name is required')
}

function validateBrief(value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid automation: brief is required')
}

function validateParams(value: unknown): void {
  validateObject(value, 'params')
  if (!Object.values(value).every(v => typeof v === 'string')) {
    throw new Error('invalid automation: params values must be strings')
  }
}

function validateTarget(value: unknown): void {
  validateObject(value, 'target')
  if (typeof value.workspaceName !== 'string' || !value.workspaceName.trim()) {
    throw new Error('invalid automation: target.workspaceName is required')
  }
  if (value.kind === 'prompt') {
    if (value.agent !== undefined && !AGENTS.has(value.agent as string)) {
      throw new Error('invalid automation: unknown prompt target agent')
    }
    if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
      throw new Error('invalid automation: target.model must be a non-empty string')
    }
    return
  }
  if (value.kind === 'team' && typeof value.teamName === 'string' && value.teamName.trim()) return
  throw new Error('invalid automation: target must be a prompt or named team')
}

function validateMutableFields(value: Record<string, unknown>): void {
  if ('name' in value) validateName(value.name)
  if ('target' in value) validateTarget(value.target)
  if ('brief' in value) validateBrief(value.brief)
  if ('params' in value) validateParams(value.params)
  if ('schedule' in value) validateSchedule(value.schedule)
  if ('report' in value) validateReport(value.report)
}

/** Create-time validation for the complete persisted definition. */
export function validateAutomationDraft(draft: any): void {
  validateObject(draft, 'draft')
  validateFields(draft, CREATE_FIELDS)
  validateName(draft.name)
  validateTarget(draft.target)
  validateBrief(draft.brief)
  validateParams(draft.params)
  if (typeof draft.enabled !== 'boolean') throw new Error('invalid automation: enabled must be a boolean')
  validateSchedule(draft.schedule)
  validateReport(draft.report)
}

/** Update-time validation: allowlisted mutable fields only. */
export function validateAutomationPatch(patch: any): void {
  validateObject(patch, 'patch')
  validateFields(patch, UPDATE_FIELDS)
  validateMutableFields(patch)
}

/** Partial draft edits from the structured authoring form. Null clears a field. */
export function validateAutomationChatPatch(patch: any): void {
  validateObject(patch, 'chat patch')
  validateFields(patch, CHAT_FIELDS)
  const present = (key: string) => key in patch && patch[key] !== null
  if (present('name')) validateName(patch.name)
  if (present('target')) validateTarget(patch.target)
  if (present('brief')) validateBrief(patch.brief)
  if (present('params')) validateParams(patch.params)
  if (present('schedule')) validateSchedule(patch.schedule)
  if (present('notify') && !validNotify(patch.notify)) {
    throw new Error('invalid automation: notify mode is invalid')
  }
}
