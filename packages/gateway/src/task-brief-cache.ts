import { createHash } from 'crypto';
import type { Chat, TaskBrief } from '@codey/core';

export function taskBriefKey(chat: Chat): string {
  return createHash('sha256').update(JSON.stringify({ title: chat.title, messages: chat.messages,
    pendingTeam: chat.pendingTeam, checklist: chat.checklist })).digest('hex');
}

/** Coalesce identical requests and never persist a result for obsolete input. */
export class TaskBriefCache {
  private pending = new Map<string, { key: string; promise: Promise<TaskBrief | null> }>();

  get(id: string, read: () => Chat | undefined, save: (brief: TaskBrief) => void,
    generate: (snapshot: Chat) => Promise<TaskBrief>): Promise<TaskBrief | null> {
    const chat = read();
    if (!chat) return Promise.resolve(null);
    const key = taskBriefKey(chat);
    if (chat.taskBrief?.inputKey === key) return Promise.resolve(chat.taskBrief);
    const active = this.pending.get(id);
    if (active?.key === key) return active.promise;
    const snapshot = structuredClone(chat);
    const entry = { key, promise: Promise.resolve(null) as Promise<TaskBrief | null> };
    entry.promise = Promise.resolve().then(() => generate(snapshot)).then(brief => {
      const current = read();
      if (this.pending.get(id) !== entry || !current || taskBriefKey(current) !== key) return null;
      const cached = { ...brief, inputKey: key };
      save(cached);
      return cached;
    }).finally(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    });
    this.pending.set(id, entry);
    return entry.promise;
  }
}
