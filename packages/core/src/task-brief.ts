import { TaskBrief, TaskEvent, TaskEventKind, TaskStatus } from './types/chat';

const STATUSES: TaskStatus[] = ['working', 'waiting', 'blocked', 'done'];
const KINDS: TaskEventKind[] = ['progress', 'action', 'decision', 'dropped'];

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function coerceEvent(e: unknown): TaskEvent | null {
  if (!e || typeof e !== 'object') return null;
  const ev = e as Record<string, unknown>;
  const text = str(ev.text);
  if (!text) return null;
  const kind = (KINDS as string[]).includes(ev.kind as string) ? (ev.kind as TaskEventKind) : 'action';
  const detailArr = Array.isArray(ev.detail)
    ? ev.detail.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map(d => d.trim())
    : undefined;
  return {
    kind,
    text,
    why: str(ev.why),
    when: typeof ev.when === 'number' && Number.isFinite(ev.when) ? ev.when : undefined,
    detail: detailArr && detailArr.length ? detailArr : undefined,
  };
}

/**
 * Normalize whatever the Aide returned into a valid TaskBrief. Never throws;
 * missing/garbage fields fall back to safe defaults (goal -> fallbackGoal).
 */
export function coerceTaskBrief(raw: unknown, fallbackGoal: string, now: number = Date.now()): TaskBrief {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = o.state && typeof o.state === 'object' ? (o.state as Record<string, unknown>) : {};

  const status = (STATUSES as string[]).includes(s.status as string) ? (s.status as TaskStatus) : 'working';
  const rawProgress = typeof s.progress === 'number' && Number.isFinite(s.progress) ? s.progress : 0;
  const progress = Math.max(0, Math.min(100, Math.round(rawProgress)));

  const na = o.nextAction && typeof o.nextAction === 'object' ? (o.nextAction as Record<string, unknown>) : undefined;
  const naText = na ? str(na.text) : undefined;
  const nextAction = naText
    ? { text: naText, detail: na ? str(na.detail) : undefined, messageId: na ? str(na.messageId) : undefined }
    : undefined;

  const timeline = (Array.isArray(o.timeline) ? o.timeline : [])
    .map(coerceEvent)
    .filter((e): e is TaskEvent => e !== null);

  return {
    goal: str(o.goal) ?? fallbackGoal,
    state: { progress, stepLabel: str(s.stepLabel), status },
    nextAction,
    timeline,
    generatedAt: now,
  };
}
