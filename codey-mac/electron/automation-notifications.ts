// Pure decision logic for automation notifications and the launch-time
// unseen-run scan. No Electron imports so it is unit-testable; main.ts
// renders decisions with the Notification API.
import { mdToPlainText, truncate } from './chat-notifications'

export type NotifyMode = 'all' | 'failure' | 'success' | 'none'

/** Anything unrecognized (including pre-mode boolean values) means 'none'. */
export function normalizeNotifyMode(v: unknown): NotifyMode {
  return v === 'all' || v === 'failure' || v === 'success' ? v : 'none'
}

export interface AutomationLike {
  id: string
  name: string
  report: { notify: NotifyMode }
}
export interface RunLike {
  runId: string
  startedAt: number
  endedAt?: number
  status: string
  output?: string
  error?: string
  question?: string
  seenAt?: number
  notifiedAt?: number
}
export interface AutomationNotification { automationId: string; runId: string; title: string; body: string }

const MAX_BODY = 180
export const UNSEEN_WINDOW_MS = 24 * 3600_000

export function decideAutomationNotification(a: AutomationLike, run: RunLike): AutomationNotification | null {
  const mode = normalizeNotifyMode(a.report.notify)
  if (mode === 'none') return null
  // Parked runs block until answered, so 'failure' surfaces them too.
  const wanted =
    mode === 'all' ||
    (mode === 'failure' && (run.status === 'failed' || run.status === 'parked')) ||
    (mode === 'success' && run.status === 'success')
  if (!wanted) return null
  const title =
    run.status === 'parked' ? `⏸ ${a.name} needs an answer` :
    run.status === 'failed' ? `❌ ${a.name} failed` :
    `✅ ${a.name} finished`
  const raw = run.status === 'parked' ? (run.question ?? '')
    : run.status === 'failed' ? (run.error ?? '')
    : (run.output ?? '')
  return { automationId: a.id, runId: run.runId, title, body: truncate(mdToPlainText(raw), MAX_BODY) }
}

/** Runs that ended recently, unseen — surfaced as the launch-time badge count. */
export function findUnseenRuns(runs: RunLike[], now: number): RunLike[] {
  return runs.filter(r => !r.seenAt && r.endedAt !== undefined && now - r.endedAt <= UNSEEN_WINDOW_MS)
}

/** Of those, the ones no OS notification has fired for yet. Unseen alone is the
 *  wrong gate for notifying: a run announced live stays unseen until the user
 *  opens it, so the launch scan would announce it again on the next start. */
export function findUnnotifiedRuns(runs: RunLike[], now: number): RunLike[] {
  return findUnseenRuns(runs, now).filter(r => !r.notifiedAt)
}
