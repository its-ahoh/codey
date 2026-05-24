import * as fs from 'fs';
import * as path from 'path';
import {
  initDiscussionDir,
  discussionDir,
  controlPath,
  summaryPath,
  topicPath,
  opinionPath,
  listOpinionFiles,
  appendTranscript,
  readControl,
  writeControl,
  buildParallelManagerPrompt,
  parseParallelManagerTurn,
  type ParallelManagerTurn,
  type ParallelSettings,
  type DiscussionTerminatedReason,
} from '@codey/core';
import type { AgentRequest, AgentResponse } from '@codey/core';

export type AgentRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface ParallelFinalEvent {
  reason: DiscussionTerminatedReason;
  message: string;
  summary: string;
  perWorker: Array<{ name: string; excerpt: string }>;
}

export interface ParallelUserQuestion {
  question: string;
  choices?: string[];
  /** Caller must invoke this once the user answers. */
  resume: (answer: string) => Promise<void>;
}

export interface ParallelTeamRunnerOptions {
  workspacesRoot: string;
  workspace: string;
  chatId: string;
  teamName: string;
  members: string[];
  topic: string;
  settings: ParallelSettings;
  workerRunner: AgentRunner;
  managerRunner: AgentRunner;
  buildWorkerPrompt: (worker: string) => string;
  onUserQuestion: (q: ParallelUserQuestion) => void;
  onFinal: (e: ParallelFinalEvent) => void;
}

export class ParallelTeamRunner {
  readonly discussionDir: string;
  private abort = new AbortController();
  private workerAborts: AbortController[] = [];
  private done = false;
  private donePromise: Promise<void>;
  private resolveDone!: () => void;
  private pendingResume: ((answer: string) => void) | null = null;
  private lastMtimeMs = 0;
  private startedAt = 0;
  private idleSince = 0;

  constructor(private opts: ParallelTeamRunnerOptions) {
    this.discussionDir = discussionDir(opts.workspacesRoot, opts.workspace, opts.chatId);
    this.donePromise = new Promise<void>(res => { this.resolveDone = res; });
  }

  async start(): Promise<void> {
    await initDiscussionDir(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, this.opts.topic, this.opts.members);
    this.startedAt = Date.now();
    this.idleSince = this.startedAt;
    await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, { actor: 'system', kind: 'started' });
    void this.runManagerLoop();
    this.spawnWorkers();
    this.armSupervisors();
  }

  waitDone(): Promise<void> { return this.donePromise; }

  async stop(reason: DiscussionTerminatedReason, finalMessage = ''): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      await writeControl(controlPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId),
        prev => ({ ...prev, status: 'terminated', directive: 'discussion ended' })).catch(() => undefined);
    } finally {
      this.abort.abort();
      for (const a of this.workerAborts) a.abort();
      await this.emitFinal(reason, finalMessage);
      this.resolveDone();
    }
  }

  // Worker loops, manager loop, supervisors, emitFinal — added in subsequent tasks.
  private spawnWorkers(): void {
    for (const w of this.opts.members) {
      const ac = new AbortController();
      this.workerAborts.push(ac);
      const req: AgentRequest = {
        prompt: this.opts.buildWorkerPrompt(w),
        signal: ac.signal,
      } as AgentRequest;
      void this.opts.workerRunner(req)
        .then(async res => {
          await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, {
            actor: w, kind: res.success ? 'worker_done' : 'worker_failed', note: res.error,
          });
        })
        .catch(async err => {
          await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, {
            actor: w, kind: 'worker_error', note: (err as Error).message,
          });
        });
    }
  }
  private async runManagerLoop(): Promise<void> { /* Task 10 */ }
  private armSupervisors(): void { /* Task 11 */ }
  private async emitFinal(reason: DiscussionTerminatedReason, message: string): Promise<void> {
    const summary = safeRead(summaryPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId));
    const perWorker: Array<{ name: string; excerpt: string }> = [];
    for (const w of this.opts.members) {
      const text = safeRead(opinionPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, w));
      const firstLine = text.split('\n').find(l => l.trim().length > 0) || '';
      perWorker.push({ name: w, excerpt: firstLine.slice(0, 200) });
    }
    this.opts.onFinal({ reason, message, summary, perWorker });
  }
}

function safeRead(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}
