import type { CodingAgent } from './index';

/** One independently configured firing slot in the schedule's `tz`. */
export interface AutomationScheduleSlot {
  /** 0-23. */
  hour: number;
  /** 0-59. */
  minute: number;
  /** 0=Sun … 6=Sat. Absent = every day. */
  daysOfWeek?: number[];
}

/** Structured time-of-day schedule (spec decision #10 — not a cron string). */
export interface AutomationSchedule {
  /** One or more independently scheduled time/day combinations. */
  slots: AutomationScheduleSlot[];
  /** IANA zone, e.g. "Asia/Shanghai". */
  tz: string;
}

function normalizeDays(v: unknown): number[] | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every(d => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  const unique = [...new Set(v as number[])].sort((a, b) => a - b);
  return unique.length === 0 || unique.length === 7 ? undefined : unique;
}

function coerceScheduleSlot(v: unknown, fallbackDays?: number[]): AutomationScheduleSlot | undefined {
  const t = v as { hour?: unknown; minute?: unknown; daysOfWeek?: unknown };
  const hour = typeof t?.hour === 'string' ? Number(t.hour) : t?.hour;
  const minute = typeof t?.minute === 'string' ? Number(t.minute) : t?.minute;
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  const days = normalizeDays(t.daysOfWeek === undefined ? fallbackDays : t.daysOfWeek);
  if (days === null) return undefined;
  return { hour, minute, ...(days ? { daysOfWeek: days } : {}) };
}

/**
 * Coerce a schedule-shaped value to the current slot schema, or undefined if
 * it can't be one. Accepts legacy {times, daysOfWeek} schedules and the oldest
 * single {hour, minute} shape. `tz` is not defaulted unless supplied.
 */
export function normalizeSchedule(v: unknown, fallbackTz?: string): AutomationSchedule | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const s = v as { slots?: unknown; times?: unknown; daysOfWeek?: unknown; tz?: unknown; hour?: unknown; minute?: unknown };
  const legacyDays = normalizeDays(s.daysOfWeek);
  if (legacyDays === null) return undefined;
  const rawSlots = Array.isArray(s.slots) ? s.slots : Array.isArray(s.times) ? s.times : [s];
  const slots: AutomationScheduleSlot[] = [];
  for (const raw of rawSlots) {
    const slot = coerceScheduleSlot(raw, legacyDays);
    if (!slot) return undefined;
    const key = `${slot.hour}:${slot.minute}:${slot.daysOfWeek?.join(',') ?? '*'}`;
    if (!slots.some(x => `${x.hour}:${x.minute}:${x.daysOfWeek?.join(',') ?? '*'}` === key)) slots.push(slot);
  }
  if (slots.length === 0) return undefined;
  slots.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)
    || (a.daysOfWeek?.join(',') ?? '').localeCompare(b.daysOfWeek?.join(',') ?? ''));
  const tz = typeof s.tz === 'string' && s.tz ? s.tz : fallbackTz;
  if (!tz) return undefined;
  return { slots, tz };
}

export type AutomationTarget =
  | { kind: 'prompt'; workspaceName: string; agent?: CodingAgent; model?: string }
  | { kind: 'team'; teamName: string; workspaceName: string };

/** When to fire an OS notification for a run. 'failure' includes parked
 *  runs — they block until answered, so they count as needing attention. */
export type AutomationNotifyMode = 'all' | 'failure' | 'success' | 'none';

export const NOTIFY_MODES: readonly AutomationNotifyMode[] = ['all', 'failure', 'success', 'none'];

/** Anything unrecognized (including pre-mode boolean values) falls back to
 *  'none' — the default is no notification. */
export function normalizeNotifyMode(v: unknown): AutomationNotifyMode {
  return NOTIFY_MODES.includes(v as AutomationNotifyMode) ? (v as AutomationNotifyMode) : 'none';
}

export interface AutomationReport {
  /** OS notification policy (delivered by the Mac app when attached).
   *  Delivery rides on automation events: a headless daemon with no event
   *  listener produces no notification. */
  notify: AutomationNotifyMode;
  /** Optional chat/channel post, e.g. { platform: 'telegram', target: '<chatId>' }. */
  channel?: { platform: string; target: string };
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  target: AutomationTarget;
  /** Frozen, self-contained instruction block synthesized by the authoring chat.
   *  May contain {{param}} placeholders resolved from `params` at run time. */
  brief: string;
  /** Surfaced editable knobs. Editing these does not re-open the chat. */
  params: Record<string, string>;
  /** Absent = manual-only. */
  schedule?: AutomationSchedule;
  report: AutomationReport;
  /** Hidden system chat this automation executes in (created lazily). */
  chatId?: string;
  /** Last slot fired, for double-fire protection. Never used to back-fire. */
  lastFiredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type AutomationRunStatus = 'success' | 'failed' | 'parked' | 'resumed';

export interface AutomationRun {
  runId: string;
  startedAt: number;
  endedAt?: number;
  status: AutomationRunStatus;
  trigger: 'manual' | 'schedule';
  /** Capped at OUTPUT_CAP chars by the engine; truncation is marked. */
  output?: string;
  error?: string;
  /** Pending question when status === 'parked'. */
  question?: string;
  /** Choice options when the parked question was [ASK_USER:choice]. */
  options?: string[];
  /** runId of the parked run this record resumed. */
  resumedFrom?: string;
  /** notify/channel delivery failure, recorded not just logged. */
  reportFailure?: string;
  /** Set when the Mac app has surfaced this result. */
  seenAt?: number;
}

/** Status of the authoring-time dry-run check for a chat session. */
export type AutomationCheckStatus = 'pending' | 'clean' | 'gaps' | 'error';

export type AutomationEvent =
  | {
      type: 'run-started' | 'run-finished' | 'run-parked';
      automationId: string;
      runId: string;
      run?: AutomationRun;
    }
  | {
      /** Dry-run verdict for an authoring chat session (never 'pending' -
       *  pending is signaled by the ChatStep that triggered the check). */
      type: 'chat-check';
      sessionId: string;
      check: Exclude<AutomationCheckStatus, 'pending'>;
      questions?: string[];
      /** Assistant message the gateway appended to the session, so the
       *  renderer can show it without waiting for the next turn. */
      message?: string;
      /** Failure detail when check === 'error' (tooltip only, not a chat message). */
      detail?: string;
    };
