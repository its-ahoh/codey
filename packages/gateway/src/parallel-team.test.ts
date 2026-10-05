import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ParallelTeamRunner } from './parallel-team';

const stubRunner = vi.fn().mockResolvedValue({ success: true, output: '' });

function makeRunner(overrides: Partial<ConstructorParameters<typeof ParallelTeamRunner>[0]> = {}, settingsOverrides: Partial<{ maxDurationMs: number; idleTimeoutMs: number; advisorPollMs: number }> = {}) {
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  fs.mkdirSync(path.join(workspacesRoot, 'demo', 'chats', 'c1'), { recursive: true });
  return new ParallelTeamRunner({
    workspacesRoot,
    workspace: 'demo',
    chatId: 'c1',
    teamName: 'rt',
    members: ['a', 'b'],
    topic: 'Decide X',
    settings: { maxDurationMs: 1000, idleTimeoutMs: 500, advisorPollMs: 200, ...settingsOverrides },
    botRunner: stubRunner,
    advisorRunner: vi.fn().mockResolvedValue({ success: true, output: '{"action":"terminate","final_message":"end","reason":"drift"}' }),
    buildBotPrompt: () => 'BOT',
    onUserQuestion: vi.fn(),
    onFinal: vi.fn(),
    ...overrides,
  });
}

describe('ParallelTeamRunner', () => {
  it('initializes discussion files on start()', async () => {
    const r = makeRunner();
    await r.start();
    expect(fs.existsSync(path.join(r.discussionDir, 'topic.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.discussionDir, 'control.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.discussionDir, 'opinions', 'a.md'))).toBe(true);
    await r.stop('user_cancel');
  });

  it('dispatches each member exactly once via botRunner with its built prompt', async () => {
    const botRunner = vi.fn().mockResolvedValue({ success: true, output: '' });
    const buildBotPrompt = vi.fn((w: string) => `PROMPT-${w}`);
    const r = makeRunner({ botRunner, buildBotPrompt });
    await r.start();
    await r.stop('user_cancel');
    const calls = botRunner.mock.calls.map(c => c[0].prompt);
    expect(calls.sort()).toEqual(['PROMPT-a', 'PROMPT-b']);
  });

  it('emits onFinal with reason after stop()', async () => {
    const onFinal = vi.fn();
    const r = makeRunner({ onFinal });
    await r.start();
    await r.stop('user_cancel', 'stopped');
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancel', message: 'stopped' }));
  });

  it('terminates when advisorRunner returns action=terminate', async () => {
    const advisorRunner = vi.fn().mockResolvedValue({
      success: true,
      output: '{"action":"terminate","final_message":"off topic","reason":"drift"}',
    });
    const onFinal = vi.fn();
    const r = makeRunner({ advisorRunner, onFinal }, { advisorPollMs: 50 });
    await r.start();
    await r.waitDone();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drift', message: 'off topic' }));
  });

  it('on ask_user, calls onUserQuestion with a resume function', async () => {
    const responses = [
      '{"action":"ask_user","user_question":"Color?","reason":"pending_question"}',
      '{"action":"terminate","final_message":"done","reason":"consensus"}',
    ];
    const advisorRunner = vi.fn().mockImplementation(() => Promise.resolve({ success: true, output: responses.shift()! }));
    const onUserQuestion = vi.fn();
    const r = makeRunner({ advisorRunner, onUserQuestion }, { advisorPollMs: 50 });
    await r.start();
    // Wait for the ask
    await new Promise(res => setTimeout(res, 400));
    expect(onUserQuestion).toHaveBeenCalled();
    const q = onUserQuestion.mock.calls[0][0];
    expect(q.question).toBe('Color?');
    await q.resume('blue');
    await r.waitDone();
  });

  it('writes summary_update to summary.md on continue', async () => {
    let i = 0;
    const advisorRunner = vi.fn().mockImplementation(() => {
      i++;
      if (i === 1) return Promise.resolve({ success: true, output: '{"action":"continue","summary_update":"new sum","directive":"focus","reason":"continuing"}' });
      return Promise.resolve({ success: true, output: '{"action":"terminate","final_message":"end","reason":"consensus"}' });
    });
    const r = makeRunner({ advisorRunner }, { advisorPollMs: 50 });
    await r.start();
    await r.waitDone();
    expect(fs.readFileSync(path.join(r.discussionDir, 'summary.md'), 'utf-8')).toContain('new sum');
  });

  it('terminates on max_duration when settings.maxDurationMs elapses', async () => {
    const advisorRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const botRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const onFinal = vi.fn();
    const r = makeRunner({
      advisorRunner,
      botRunner,
      onFinal,
    }, { maxDurationMs: 200, idleTimeoutMs: 10_000, advisorPollMs: 10_000 });
    await r.start();
    await r.waitDone();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'max_duration' }));
  });

  it('terminates on timeout when idleTimeoutMs elapses with no file mtime change', async () => {
    const advisorRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const botRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const onFinal = vi.fn();
    const r = makeRunner({
      advisorRunner,
      botRunner,
      onFinal,
    }, { maxDurationMs: 10_000, idleTimeoutMs: 250, advisorPollMs: 10_000 });
    await r.start();
    await r.waitDone();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout' }));
  });

  it('smoke: ParallelTeamRunner can be imported and constructed', () => {
    // Verify the class is importable and has expected interface
    expect(ParallelTeamRunner).toBeDefined();
    const r = makeRunner();
    expect(r.discussionDir).toBeDefined();
  });

  it('resume: new message into done discussion preserves opinions and appends Continuation', async () => {
    const { initDiscussionDir, readControl } = await import('@codey/core');
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-resume-'));
    fs.mkdirSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions'), { recursive: true });
    // Seed a prior "done" discussion
    fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'topic.md'), '# Topic\n\nfirst round\n');
    fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'control.md'),
      `---\nstatus: terminated\nrevision: 9\nupdated_at: 2026-05-24T00:00:00.000Z\n---\n\n## Directive\nended\n`);
    fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'summary.md'), '# Summary\nprior\n');
    fs.writeFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'a.md'), 'prior a opinion');

    // Simulate resume invocation: gateway calls initDiscussionDir with the new topic
    await initDiscussionDir(wsRoot, 'demo', 'c1', 'second round', ['a', 'b']);

    const topic = fs.readFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'topic.md'), 'utf-8');
    expect(topic).toContain('first round');
    expect(topic).toMatch(/## Continuation/);
    expect(topic).toContain('second round');
    expect(fs.readFileSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'a.md'), 'utf-8')).toContain('prior a opinion');
    // New bot b gets a fresh opinion file
    expect(fs.existsSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'b.md'))).toBe(true);
    // Control reset to running with bumped revision
    const ctrl = await readControl(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'control.md'));
    expect(ctrl?.status).toBe('running');
  });
});


it('pauses only the asking Bot, keeps peers running, and routes each reply once', async () => {
  const questions: any[] = [];
  const calls: Array<{ bot: string; prompt: string; resume?: string }> = [];
  const onFinal = vi.fn();
  const runner = makeRunner({
    onUserQuestion: q => questions.push(q), onFinal,
    botRunner: async (req, bot) => {
      calls.push({ bot, prompt: req.prompt, resume: req.resumeSessionId });
      await new Promise(resolve => setTimeout(resolve, 5));
      if (bot === 'a' && !req.resumeSessionId) return { success: true, output: '[ASK_USER:choice]: Database? | SQLite | Postgres', sessionId: 'session-a' } as any;
      return { success: true, output: 'progress', sessionId: `session-${bot}` } as any;
    },
    advisorRunner: async () => ({ success: true, output: '{"action":"finalize","reason":"consensus","final_message":"done"}' } as any),
  }, { advisorPollMs: 10, maxDurationMs: 10000 });
  try {
    await runner.start();
    await vi.waitFor(() => expect(questions).toHaveLength(1));
    await vi.waitFor(() => expect(calls.filter(c => c.bot === 'b').length).toBeGreaterThan(2));
    expect(calls.filter(c => c.bot === 'a')).toHaveLength(1);
    expect(onFinal).not.toHaveBeenCalled();
    await questions[0].resume('SQLite');
    await expect(questions[0].resume('Postgres')).rejects.toThrow('no longer');
    await vi.waitFor(() => expect(calls.some(c => c.bot === 'a' && c.resume === 'session-a' && c.prompt.includes('SQLite'))).toBe(true));
    expect(calls.filter(c => c.bot === 'b').every(c => !c.prompt.includes('SQLite'))).toBe(true);
  } finally { await runner.stop('user_cancel'); }
});

it('keeps simultaneous permission and choice requests distinct and cancels them on stop', async () => {
  const questions: any[] = [];
  const resolved = vi.fn();
  const runner = makeRunner({
    onUserQuestion: q => questions.push(q), onInteractionResolved: resolved,
    botRunner: async (_req, bot) => bot === 'a'
      ? { success: false, output: 'blocked', permissionDenials: [{ toolName: 'Read' }] } as any
      : { success: true, output: '[ASK_USER:choice]: Choose? | One | Two' } as any,
    advisorRunner: async () => ({ success: true, output: '{"action":"finalize","reason":"consensus"}' } as any),
  }, { advisorPollMs: 10, maxDurationMs: 10000 });
  await runner.start();
  await vi.waitFor(() => expect(questions).toHaveLength(2));
  expect(new Set(questions.map(q => q.id)).size).toBe(2);
  expect(questions.find(q => q.bot === 'a').permissionTools).toEqual(['Read']);
  await runner.stop('user_cancel');
  expect(resolved).toHaveBeenCalledTimes(2);
  await expect(questions[0].resume('late')).rejects.toThrow('no longer');
});

it('holds a dependent Bot until the blocked peer returns a result', async () => {
  const questions: any[] = [];
  const calls: string[] = [];
  const dependency = vi.fn();
  const runner = makeRunner({
    onUserQuestion: q => questions.push(q), onBotDependency: dependency,
    botRunner: async (req, bot) => {
      calls.push(bot);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (bot === 'a' && !req.resumeSessionId) return { success: true, output: '[ASK_USER]: Input?', sessionId: 'a-session' } as any;
      if (bot === 'b' && !req.resumeSessionId) return { success: true, output: '[ASK: a]: Need the result', sessionId: 'b-session' } as any;
      return { success: true, output: 'result ready', sessionId: `${bot}-session` } as any;
    },
    advisorRunner: async () => ({ success: true, output: '{"action":"continue","reason":"continuing"}' } as any),
  }, { advisorPollMs: 10, maxDurationMs: 10000 });
  try {
    await runner.start();
    await vi.waitFor(() => expect(dependency).toHaveBeenCalledWith('b', 'a'));
    expect(calls).toEqual(['a', 'b']);
    await questions[0].resume('Proceed');
    await vi.waitFor(() => expect(dependency).toHaveBeenCalledWith('b'));
    await vi.waitFor(() => expect(calls.filter(bot => bot === 'b').length).toBeGreaterThan(1));
  } finally { await runner.stop('user_cancel'); }
});
