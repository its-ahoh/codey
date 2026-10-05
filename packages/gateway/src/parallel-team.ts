import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { teamInteractionResponse } from './team-interaction';
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
  parseAskUser,
  parseAsk,
  type RoundtableSettings,
  type DiscussionTerminatedReason,
} from '@codey/core';
import type { AgentRequest, AgentResponse } from '@codey/core';

export type AgentRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface ParallelFinalEvent {
  reason: DiscussionTerminatedReason;
  message: string;
  summary: string;
  perBot: Array<{ name: string; excerpt: string }>;
}

export interface ParallelUserQuestion {
  id: string;
  bot?: string;
  permissionTools?: string[];
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
  settings: RoundtableSettings;
  botRunner: (req: AgentRequest, bot: string) => Promise<AgentResponse>;
  advisorRunner: AgentRunner;
  buildBotPrompt: (bot: string) => string;
  onUserQuestion: (q: ParallelUserQuestion) => void;
  onBotDependency?: (bot: string, target?: string) => void;
  onInteractionResolved?: (id: string, cancelled: boolean, answer?: string) => void;
  onFinal: (e: ParallelFinalEvent) => void;
  /** Called when a bot's run finishes (success or failure). */
  onBotDone?: (bot: string, ok: boolean, error?: string) => void;
}

export class ParallelTeamRunner {
  readonly discussionDir: string;
  private abort = new AbortController();
  private botAborts: AbortController[] = [];
  private done = false;
  private donePromise: Promise<void>;
  private resolveDone!: () => void;
  private failedBots = new Map<string, string>();
  private peerWaits = new Map<string, { target: string; resolve: (output: string | null) => void }>();
  private interactionRevision = 0;
  private resumingBots = new Set<string>();
  private interactions = new Map<string, { bot?: string; question: string; resolve: (answer: string | null) => void }>();
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
    this.spawnBots();
    this.armSupervisors();
    console.log(`[parallel-runner] all bots spawned, advisor loop running, supervisors armed`);
  }

  waitDone(): Promise<void> { return this.donePromise; }

  async stop(reason: DiscussionTerminatedReason, finalMessage = ''): Promise<void> {
    if (this.done) return;
    this.done = true;
    for (const [id, pending] of this.interactions) {
      this.opts.onInteractionResolved?.(id, true);
      pending.resolve(null);
    }
    this.interactions.clear();
    for (const pending of this.peerWaits.values()) pending.resolve(null);
    this.peerWaits.clear();
    console.log(`[parallel-runner] stop() called. reason=${reason} message=${finalMessage.substring(0, 100)}`);
    console.trace('[parallel-runner] stop() call stack');
    try {
      await writeControl(controlPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId),
        prev => ({ ...prev, status: 'terminated', directive: 'discussion ended' })).catch(() => undefined);
    } finally {
      this.abort.abort();
      for (const a of this.botAborts) a.abort();
      await this.emitFinal(reason, finalMessage);
      this.resolveDone();
    }
  }

  /** Replies are scoped to a single live request; stale/double replies are rejected. */
  answerInteraction(id: string, answer: string): void {
    const pending = this.interactions.get(id);
    if (this.done || !pending) throw new Error('This question is no longer waiting for an answer.');
    if (!answer.trim()) throw new Error('An answer is required.');
    this.interactions.delete(id);
    this.interactionRevision++;
    if (pending.bot) this.resumingBots.add(pending.bot);
    this.idleSince = Date.now();
    this.opts.onInteractionResolved?.(id, false, answer);
    pending.resolve(answer);
  }

  private ask(question: string, choices?: string[], bot?: string, permissionTools?: string[]): Promise<string | null> {
    const id = randomUUID();
    return new Promise(resolve => {
      this.interactionRevision++;
      this.interactions.set(id, { bot, question, resolve });
      this.opts.onUserQuestion({ id, bot, question, choices, permissionTools,
        resume: async answer => this.answerInteraction(id, answer) });
    });
  }

  private spawnBots(): void {
    for (const w of this.opts.members) {
      const ac = new AbortController();
      this.botAborts.push(ac);
      void this.runBotLoop(w, ac);
    }
  }

  private async runBotLoop(bot: string, ac: AbortController): Promise<void> {
    const wsRoot = this.opts.workspacesRoot;
    const ws = this.opts.workspace;
    const chat = this.opts.chatId;
    const ctrlPath = controlPath(wsRoot, ws, chat);
    let round = 0;
    let userAnswer: string | undefined;
    let sessionId: string | undefined;
    let finalized = false;

    while (!this.done && !ac.signal.aborted) {
      if ([...this.interactions.values()].some(p => !p.bot)) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      round++;
      console.log(`[parallel-runner] bot "${bot}" starting round ${round}`);
      const prompt = this.opts.buildBotPrompt(bot) + (userAnswer ? `\n\n[User response to your pending question]\n${userAnswer}` : '');
      userAnswer = undefined;
      console.log(`[parallel-runner] bot "${bot}" prompt length: ${prompt.length}`);
      const req: AgentRequest = { prompt, signal: ac.signal, resumeSessionId: sessionId } as AgentRequest;

      try {
        const raw = await this.opts.botRunner(req, bot);
        if (this.done || ac.signal.aborted) break;
        this.resumingBots.delete(bot);
        sessionId = raw.sessionId ?? sessionId;
        const res = teamInteractionResponse(raw);
        const peerAsk = parseAsk(res.output);
        if (peerAsk?.kind === 'team') {
          const target = this.opts.members.find(name => name.toLowerCase() === peerAsk.target.toLowerCase());
          if (!target || target === bot) throw new Error(`Invalid dependency: ${peerAsk.target}`);
          if (this.failedBots.has(target)) {
            userAnswer = `Dependency ${target} failed: ${this.failedBots.get(target)}`;
            continue;
          }
          // A cycle cannot make progress; report it rather than silently waiting forever.
          let cursor: string | undefined = target;
          const seen = new Set([bot]);
          while (cursor) {
            if (seen.has(cursor)) throw new Error('Circular Bot dependency');
            seen.add(cursor);
            cursor = this.peerWaits.get(cursor)?.target;
          }
          const answer = await new Promise<string | null>(resolve => {
            this.peerWaits.set(bot, { target, resolve });
            this.opts.onBotDependency?.(bot, target);
          });
          if (answer === null || this.done) break;
          userAnswer = `Dependency ${target} completed a turn: ${answer}`;
          continue;
        }
        const ask = parseAskUser(res.output);
        if (ask) {
          const answer = await this.ask(ask.question, ask.options, bot,
            raw.permissionDenials?.filter(d => d.toolName !== 'AskUserQuestion').map(d => d.toolName));
          if (answer === null || this.done) break;
          userAnswer = answer;
          continue;
        }
        for (const [waitingBot, pending] of this.peerWaits) {
          if (pending.target !== bot) continue;
          this.peerWaits.delete(waitingBot);
          this.resumingBots.add(waitingBot);
          this.opts.onBotDependency?.(waitingBot);
          pending.resolve(res.success ? res.output : `Bot failed: ${res.error ?? res.output}`);
        }
        console.log(`[parallel-runner] bot "${bot}" round ${round} done. success=${res.success} output=${(res.output || '').substring(0, 100)}`);
        await appendTranscript(wsRoot, ws, chat, {
          actor: bot, kind: res.success ? 'bot_done' : 'bot_failed',
          note: res.error || `round ${round}`,
        });
        if (!res.success) { this.failedBots.set(bot, res.error ?? res.output); this.opts.onBotDone?.(bot, false, res.error); finalized = true; break; }
      } catch (err) {
        this.resumingBots.delete(bot);
        this.failedBots.set(bot, (err as Error).message);
        for (const [waitingBot, pending] of this.peerWaits) {
          if (pending.target !== bot) continue;
          this.peerWaits.delete(waitingBot);
          this.opts.onBotDependency?.(waitingBot);
          pending.resolve(`Bot failed: ${(err as Error).message}`);
        }
        await appendTranscript(wsRoot, ws, chat, {
          actor: bot, kind: 'bot_error', note: (err as Error).message,
        });
        this.opts.onBotDone?.(bot, false, (err as Error).message); finalized = true;
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
        await appendTranscript(wsRoot, ws, chat, { actor: bot, kind: 'bot_done', note: 'finalizing exit' });
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
    // Bot exited the loop via termination, finalizing, or external abort
    // (not due to a bot-level failure/error, which finalized above).
    if (!finalized) this.opts.onBotDone?.(bot, round > 0);
  }
  private async runAdvisorLoop(): Promise<void> {
    const wsRoot = this.opts.workspacesRoot;
    const ws = this.opts.workspace;
    const chat = this.opts.chatId;
    const ctrlPath = controlPath(wsRoot, ws, chat);
    const sumPath = summaryPath(wsRoot, ws, chat);
    const topPath = topicPath(wsRoot, ws, chat);

    let pendingUserAnswer: { question: string; answer: string } | undefined;

    while (!this.done) {
      await new Promise<void>(res => setTimeout(res, this.opts.settings.advisorPollMs));
      if (this.done) break;

      const waitingBots = new Set([...this.interactions.values()].map(p => p.bot).filter(Boolean));
      if (waitingBots.size + this.peerWaits.size >= this.opts.members.length) continue;
      const topic = safeRead(topPath);
      const summary = safeRead(sumPath);
      const opinions = (await listOpinionFiles(wsRoot, ws, chat)).map(name => ({
        name,
        text: safeRead(opinionPath(wsRoot, ws, chat, name)),
      }));
      const pendingAsks = extractPendingAsks(opinions);
      const ctrl = await readControl(ctrlPath);
      this.idleSince = Date.now();

      const interactionRevision = this.interactionRevision;
      const prompt = buildParallelAdvisorPrompt({
        topic, summary, opinions, pendingAsks, idleMs: 0,
        revision: ctrl?.revision ?? 0,
        userAnswer: pendingUserAnswer,
      }) + `\n\nBots waiting for user input: ${JSON.stringify([...this.interactions.values()].map(p => ({ bot: p.bot, question: p.question })))}. Keep independent work moving. Do not finalize while these requests are pending. Use ask_user only for a decision that must pause the entire team.`;
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
      if (this.done) break;
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
        const answer = await this.ask(turn.user_question!, turn.user_question_choices);
        if (answer === null || this.done) break;
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
        if (this.interactions.size || this.peerWaits.size || this.resumingBots.size || interactionRevision !== this.interactionRevision) continue;
        const reason: DiscussionTerminatedReason = turn.action === 'finalize' ? 'consensus' : (turn.reason === 'drift' ? 'drift' : 'consensus');
        await this.stop(reason, turn.final_message || '');
        break;
      }
    }
  }
  private armSupervisors(): void {
    let activeMs = 0;
    let lastCheck = Date.now();
    const checkMs = Math.min(5000, Math.max(500, this.opts.settings.idleTimeoutMs / 4));
    let firstWriteSeen = false;
    const interval = setInterval(async () => {
      if (this.done) { clearInterval(interval); return; }
      const now = Date.now();
      const elapsed = now - lastCheck;
      lastCheck = now;
      if (this.interactions.size) { this.idleSince = now; return; }
      activeMs += elapsed;
      if (activeMs >= this.opts.settings.maxDurationMs) {
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
    const perBot: Array<{ name: string; excerpt: string }> = [];
    for (const w of this.opts.members) {
      const text = safeRead(opinionPath(this.opts.workspacesRoot, this.opts.workspace, this.opts.chatId, w));
      const contentLines = text.split('\n').filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('#') && !t.startsWith('(not started');
      });
      const excerpt = contentLines.slice(0, 3).join(' ').slice(0, 300);
      perBot.push({ name: w, excerpt: excerpt || '(no content)' });
    }
    this.opts.onFinal({ reason, message, summary, perBot });
  }
}

function safeRead(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function extractPendingAsks(opinions: Array<{ name: string; text: string }>): Array<{ bot: string; question: string }> {
  const out: Array<{ bot: string; question: string }> = [];
  for (const o of opinions) {
    const lines = o.text.split('\n');
    for (const line of lines) {
      const m = /^\[ASK_ADVISOR\]:\s*(.+)$/.exec(line.trim());
      if (m) out.push({ bot: o.name, question: m[1] });
    }
  }
  return out;
}
