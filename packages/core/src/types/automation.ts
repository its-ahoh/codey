import type { CodingAgent } from './index';

/** Structured time-of-day schedule (spec decision #10 — not a cron string). */
export interface AutomationSchedule {
  /** 0-23, in `tz`. */
  hour: number;
  /** 0-59. */
  minute: number;
  /** 0=Sun … 6=Sat. Absent = every day. */
  daysOfWeek?: number[];
  /** IANA zone, e.g. "Asia/Shanghai". */
  tz: string;
}

export type AutomationTarget =
  | { kind: 'prompt'; workspaceName: string; agent?: CodingAgent; model?: string }
  | { kind: 'team'; teamName: string; workspaceName: string };

export interface AutomationReport {
  /** Fire an OS notification (delivered by the Mac app when attached).
   *  Delivery rides on automation events: a headless daemon with no event
   *  listener produces no notification. */
  notify: boolean;
  /** Optional chat/channel post, e.g. { platform: 'telegram', target: '<chatId>' }. */
  channel?: { platform: string; target: string };
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  target: AutomationTarget;
  /** Frozen, self-contained instruction block synthesized by the interview.
   *  May contain {{param}} placeholders resolved from `params` at run time. */
  brief: string;
  /** Surfaced editable knobs. Editing these does not re-open the interview. */
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

export interface AutomationEvent {
  type: 'run-started' | 'run-finished' | 'run-parked';
  automationId: string;
  runId: string;
  run?: AutomationRun;
}
