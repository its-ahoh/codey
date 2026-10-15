import { createHash } from 'crypto';
import type { Chat, TaskBrief } from '@codey/core';

export function taskBriefKey(chat: Chat, generator = ''): string {
  return createHash('sha256').update(JSON.stringify({ title: chat.title, messages: chat.messages,
    pendingTeam: chat.pendingTeam, checklist: chat.checklist, generator })).digest('hex');
}

/** A failed input is not retried until this long has passed. */
export const TASK_BRIEF_RETRY_MS = 60_000;

/** Coalesce identical requests and never persist a result for obsolete input. */
export class TaskBriefCache {
  private pending = new Map<string, { key: string; promise: Promise<TaskBrief | null> }>();
  private failed = new Map<string, { key: string; at: number }>();

  constructor(private now: () => number = Date.now) {}

  /** `generator` names the Aide agent/model so switching it invalidates the cache. */
  get(id: string, read: () => Chat | undefined, save: (brief: TaskBrief) => void,
    generate: (snapshot: Chat) => Promise<TaskBrief>, generator = ''): Promise<TaskBrief | null> {
    const chat = read();
    if (!chat) return Promise.resolve(null);
    const key = taskBriefKey(chat, generator);
    if (chat.taskBrief?.inputKey === key) return Promise.resolve(chat.taskBrief);
    const active = this.pending.get(id);
    if (active?.key === key) return active.promise;
    // Every panel open would otherwise re-run a model that just failed on
    // this exact input. Back off; a changed chat retries immediately.
    const lastFailure = this.failed.get(id);
    if (lastFailure?.key === key && this.now() - lastFailure.at < TASK_BRIEF_RETRY_MS) {
      return Promise.reject(new Error('Task brief failed recently for this input; retrying later'));
    }
    const snapshot = structuredClone(chat);
    const entry = { key, promise: Promise.resolve(null) as Promise<TaskBrief | null> };
    entry.promise = Promise.resolve().then(() => generate(snapshot)).then(brief => {
      const current = read();
      if (this.pending.get(id) !== entry || !current || taskBriefKey(current, generator) !== key) return null;
      this.failed.delete(id);
      const cached = { ...brief, inputKey: key };
      save(cached);
      return cached;
    }, err => {
      if (this.pending.get(id) === entry) this.failed.set(id, { key, at: this.now() });
      throw err;
    }).finally(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    });
    this.pending.set(id, entry);
    return entry.promise;
  }
}
