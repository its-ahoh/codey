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
  private async runManagerLoop(): Promise<void> {
    const dir = this.discussionDir;
    const wsRoot = this.opts.workspacesRoot;
    const ws = this.opts.workspace;
    const chat = this.opts.chatId;
    const ctrlPath = controlPath(wsRoot, ws, chat);
    const sumPath = summaryPath(wsRoot, ws, chat);
    const topPath = topicPath(wsRoot, ws, chat);

    let watcher: fs.FSWatcher | undefined;
    let debounce: NodeJS.Timeout | null = null;
    const tickSignal = (() => {
      let resolveTick: (() => void) | null = null;
      return {
        wait: () => new Promise<void>(res => { resolveTick = res; }),
        poke: () => { if (resolveTick) { const r = resolveTick!; resolveTick = null; r(); } },
      };
    })();

    try {
      watcher = fs.watch(dir, { recursive: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => tickSignal.poke(), 2000);
      });
    } catch { /* watch may fail on some FS; poll covers it */ }

    let pendingUserAnswer: { question: string; answer: string } | undefined;

    while (!this.done) {
      await new Promise<void>(res => setTimeout(res, this.opts.settings.managerPollMs));
      if (this.done) break;

      const topic = safeRead(topPath);
      const summary = safeRead(sumPath);
      const opinions = (await listOpinionFiles(wsRoot, ws, chat)).map(name => ({
        name,
        text: safeRead(opinionPath(wsRoot, ws, chat, name)),
      }));
      const pendingAsks = extractPendingAsks(opinions);
      const ctrl = await readControl(ctrlPath);
      this.idleSince = Date.now();

      const prompt = buildParallelManagerPrompt({
        topic, summary, opinions, pendingAsks, idleMs: 0,
        revision: ctrl?.revision ?? 0,
        userAnswer: pendingUserAnswer,
      });
      pendingUserAnswer = undefined;

      let resp: AgentResponse;
      try {
        resp = await this.opts.managerRunner({ prompt, signal: this.abort.signal } as AgentRequest);
      } catch (err) {
        await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'error', note: (err as Error).message });
        continue;
      }
      if (!resp.success) {
        await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'error', note: resp.error });
        continue;
      }
      const turn = parseParallelManagerTurn(resp.output);
      if (!turn) {
        await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'parse_error' });
        continue;
      }

      if (turn.summary_update) {
        await fs.promises.writeFile(sumPath, `# Summary\n\n${turn.summary_update}\n`, 'utf-8');
      }
      if (turn.directive) {
        await writeControl(ctrlPath, prev => ({ ...prev, status: prev.status, directive: turn.directive! })).catch(() => undefined);
      }

      if (turn.action === 'continue') {
        await appendTranscript(wsRoot, ws, chat, { actor: 'manager', kind: 'continue', note: turn.reason });
        continue;
      }
      if (turn.action === 'ask_user') {
        await writeControl(ctrlPath, prev => ({
          ...prev,
          status: 'paused',
          userQuestion: turn.user_question,
          userQuestionChoices: turn.user_question_choices,
        })).catch(() => undefined);
        const answerPromise = new Promise<string>(res => { this.pendingResume = res; });
        this.opts.onUserQuestion({
          question: turn.user_question!,
          choices: turn.user_question_choices,
          resume: async (answer: string) => {
            if (this.pendingResume) { this.pendingResume(answer); this.pendingResume = null; }
          },
        });
        const answer = await answerPromise;
        pendingUserAnswer = { question: turn.user_question!, answer };
        await writeControl(ctrlPath, prev => ({
          ...prev,
          status: 'running',
          resumeNote: `User answered: ${answer}`,
          userQuestion: undefined,
          userQuestionChoices: undefined,
        })).catch(() => undefined);
        continue;
      }
      if (turn.action === 'finalize' || turn.action === 'terminate') {
        const reason: DiscussionTerminatedReason = turn.action === 'finalize' ? 'consensus' : (turn.reason === 'drift' ? 'drift' : 'consensus');
        await this.stop(reason, turn.final_message || '');
        break;
      }
    }
    if (watcher) watcher.close();
    if (debounce) clearTimeout(debounce);
  }
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

function extractPendingAsks(opinions: Array<{ name: string; text: string }>): Array<{ worker: string; question: string }> {
  const out: Array<{ worker: string; question: string }> = [];
  for (const o of opinions) {
    const lines = o.text.split('\n');
    for (const line of lines) {
      const m = /^\[ASK_MANAGER\]:\s*(.+)$/.exec(line.trim());
      if (m) out.push({ worker: o.name, question: m[1] });
    }
  }
  return out;
}
