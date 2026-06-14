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
  buildParallelAdvisorPrompt,
  parseParallelAdvisorTurn,
  type ParallelAdvisorTurn,
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
  advisorRunner: AgentRunner;
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
    console.log(`[parallel-runner] start() called. members=${this.opts.members.join(',')} topic=${this.opts.topic.substring(0, 80)}`);
    await initDiscussionDir(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, this.opts.topic, this.opts.members);
    console.log(`[parallel-runner] discussion dir initialized: ${this.discussionDir}`);
    this.startedAt = Date.now();
    this.idleSince = this.startedAt;
    await appendTranscript(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, { actor: 'system', kind: 'started' });
    void this.runAdvisorLoop();
    this.spawnWorkers();
    this.armSupervisors();
    console.log(`[parallel-runner] all workers spawned, advisor loop running, supervisors armed`);
  }

  waitDone(): Promise<void> { return this.donePromise; }

  async stop(reason: DiscussionTerminatedReason, finalMessage = ''): Promise<void> {
    if (this.done) return;
    this.done = true;
    console.log(`[parallel-runner] stop() called. reason=${reason} message=${finalMessage.substring(0, 100)}`);
    console.trace('[parallel-runner] stop() call stack');
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

  private spawnWorkers(): void {
    for (const w of this.opts.members) {
      const ac = new AbortController();
      this.workerAborts.push(ac);
      void this.runWorkerLoop(w, ac);
    }
  }

  private async runWorkerLoop(worker: string, ac: AbortController): Promise<void> {
    const wsRoot = this.opts.workspacesRoot;
    const ws = this.opts.workspace;
    const chat = this.opts.chatId;
    const ctrlPath = controlPath(wsRoot, ws, chat);
    let round = 0;

    while (!this.done && !ac.signal.aborted) {
      round++;
      console.log(`[parallel-runner] worker "${worker}" starting round ${round}`);
      const prompt = this.opts.buildWorkerPrompt(worker);
      console.log(`[parallel-runner] worker "${worker}" prompt length: ${prompt.length}`);
      const req: AgentRequest = { prompt, signal: ac.signal } as AgentRequest;

      try {
        const res = await this.opts.workerRunner(req);
        console.log(`[parallel-runner] worker "${worker}" round ${round} done. success=${res.success} output=${(res.output || '').substring(0, 100)}`);
        await appendTranscript(wsRoot, ws, chat, {
          actor: worker, kind: res.success ? 'worker_done' : 'worker_failed',
          note: res.error || `round ${round}`,
        });
        if (!res.success) break;
      } catch (err) {
        await appendTranscript(wsRoot, ws, chat, {
          actor: worker, kind: 'worker_error', note: (err as Error).message,
        });
        break;
      }

      if (this.done || ac.signal.aborted) break;

      let ctrl;
      try {
        ctrl = await readControl(ctrlPath);
      } catch {
        break;
      }
      const status = ctrl?.status ?? 'running';
      if (status === 'terminated') break;
      if (status === 'finalizing') {
        await appendTranscript(wsRoot, ws, chat, { actor: worker, kind: 'worker_done', note: 'finalizing exit' });
        break;
      }
      if (status === 'paused') {
        while (!this.done && !ac.signal.aborted) {
          await new Promise(r => setTimeout(r, 5000));
          let c;
          try { c = await readControl(ctrlPath); } catch { break; }
          if (!c || c.status !== 'paused') break;
        }
      }
    }
  }
  private async runAdvisorLoop(): Promise<void> {
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
      await new Promise<void>(res => setTimeout(res, this.opts.settings.advisorPollMs));
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

      const prompt = buildParallelAdvisorPrompt({
        topic, summary, opinions, pendingAsks, idleMs: 0,
        revision: ctrl?.revision ?? 0,
        userAnswer: pendingUserAnswer,
      });
      pendingUserAnswer = undefined;

      console.log(`[parallel-runner] advisor poll: opinions=${opinions.map(o => o.name).join(',')}, revision=${ctrl?.revision ?? 0}`);
      let resp: AgentResponse;
      try {
        resp = await this.opts.advisorRunner({ prompt, signal: this.abort.signal } as AgentRequest);
      } catch (err) {
        console.log(`[parallel-runner] advisor runner threw: ${(err as Error).message}`);
        await appendTranscript(wsRoot, ws, chat, { actor: 'advisor', kind: 'error', note: (err as Error).message });
        continue;
      }
      console.log(`[parallel-runner] advisor response: success=${resp.success} output=${(resp.output || '').substring(0, 200)}`);
      if (!resp.success) {
        await appendTranscript(wsRoot, ws, chat, { actor: 'advisor', kind: 'error', note: resp.error });
        continue;
      }
      const turn = parseParallelAdvisorTurn(resp.output);
      console.log(`[parallel-runner] advisor parsed: action=${turn?.action} reason=${turn?.reason}`);
      if (!turn) {
        await appendTranscript(wsRoot, ws, chat, { actor: 'advisor', kind: 'parse_error' });
        continue;
      }

      if (turn.summary_update) {
        await fs.promises.writeFile(sumPath, `# Summary\n\n${turn.summary_update}\n`, 'utf-8');
      }
      if (turn.directive) {
        await writeControl(ctrlPath, prev => ({ ...prev, status: prev.status, directive: turn.directive! })).catch(() => undefined);
      }

      if (turn.action === 'continue') {
        await appendTranscript(wsRoot, ws, chat, { actor: 'advisor', kind: 'continue', note: turn.reason });
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
  private armSupervisors(): void {
    const start = Date.now();
    const checkMs = Math.min(5000, Math.max(500, this.opts.settings.idleTimeoutMs / 4));
    let firstWriteSeen = false;
    const interval = setInterval(async () => {
      if (this.done) { clearInterval(interval); return; }
      if (Date.now() - start >= this.opts.settings.maxDurationMs) {
        clearInterval(interval);
        await this.stop('max_duration', 'discussion exceeded maximum duration');
        return;
      }
      let latest = 0;
      try {
        const files = [summaryPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId)];
        const wnames = await listOpinionFiles(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId);
        for (const w of wnames) files.push(opinionPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, w));
        for (const f of files) {
          try { latest = Math.max(latest, (await fs.promises.stat(f)).mtimeMs); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      if (latest > this.lastMtimeMs) {
        this.lastMtimeMs = latest;
        this.idleSince = Date.now();
        firstWriteSeen = true;
      } else if (firstWriteSeen && Date.now() - this.idleSince >= this.opts.settings.idleTimeoutMs) {
        clearInterval(interval);
        await this.stop('timeout', 'no activity within idle window');
      }
    }, checkMs);
  }
  private async emitFinal(reason: DiscussionTerminatedReason, message: string): Promise<void> {
    const summary = safeRead(summaryPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId));
    const perWorker: Array<{ name: string; excerpt: string }> = [];
    for (const w of this.opts.members) {
      const text = safeRead(opinionPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, w));
      const contentLines = text.split('\n').filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('#') && !t.startsWith('(not started');
      });
      const excerpt = contentLines.slice(0, 3).join(' ').slice(0, 300);
      perWorker.push({ name: w, excerpt: excerpt || '(no content)' });
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
      const m = /^\[ASK_ADVISOR\]:\s*(.+)$/.exec(line.trim());
      if (m) out.push({ worker: o.name, question: m[1] });
    }
  }
  return out;
}
