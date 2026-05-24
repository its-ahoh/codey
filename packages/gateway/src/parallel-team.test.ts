import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ParallelTeamRunner } from './parallel-team';

const stubRunner = vi.fn().mockResolvedValue({ success: true, output: '' });

function makeRunner(overrides: Partial<ConstructorParameters<typeof ParallelTeamRunner>[0]> = {}, settingsOverrides: Partial<{ maxDurationMs: number; idleTimeoutMs: number; managerPollMs: number }> = {}) {
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  fs.mkdirSync(path.join(workspacesRoot, 'demo', 'chats', 'c1'), { recursive: true });
  return new ParallelTeamRunner({
    workspacesRoot,
    workspace: 'demo',
    chatId: 'c1',
    teamName: 'rt',
    members: ['a', 'b'],
    topic: 'Decide X',
    settings: { maxDurationMs: 1000, idleTimeoutMs: 500, managerPollMs: 200, ...settingsOverrides },
    workerRunner: stubRunner,
    managerRunner: vi.fn().mockResolvedValue({ success: true, output: '{"action":"terminate","final_message":"end","reason":"drift"}' }),
    buildWorkerPrompt: () => 'WORKER',
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

  it('dispatches each member exactly once via workerRunner with its built prompt', async () => {
    const workerRunner = vi.fn().mockResolvedValue({ success: true, output: '' });
    const buildWorkerPrompt = vi.fn((w: string) => `PROMPT-${w}`);
    const r = makeRunner({ workerRunner, buildWorkerPrompt });
    await r.start();
    await r.stop('user_cancel');
    const calls = workerRunner.mock.calls.map(c => c[0].prompt);
    expect(calls.sort()).toEqual(['PROMPT-a', 'PROMPT-b']);
  });

  it('emits onFinal with reason after stop()', async () => {
    const onFinal = vi.fn();
    const r = makeRunner({ onFinal });
    await r.start();
    await r.stop('user_cancel', 'stopped');
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancel', message: 'stopped' }));
  });

  it('terminates when managerRunner returns action=terminate', async () => {
    const managerRunner = vi.fn().mockResolvedValue({
      success: true,
      output: '{"action":"terminate","final_message":"off topic","reason":"drift"}',
    });
    const onFinal = vi.fn();
    const r = makeRunner({ managerRunner, onFinal }, { managerPollMs: 50 });
    await r.start();
    await r.waitDone();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drift', message: 'off topic' }));
  });

  it('on ask_user, calls onUserQuestion with a resume function', async () => {
    const responses = [
      '{"action":"ask_user","user_question":"Color?","reason":"pending_question"}',
      '{"action":"terminate","final_message":"done","reason":"consensus"}',
    ];
    const managerRunner = vi.fn().mockImplementation(() => Promise.resolve({ success: true, output: responses.shift()! }));
    const onUserQuestion = vi.fn();
    const r = makeRunner({ managerRunner, onUserQuestion }, { managerPollMs: 50 });
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
    const managerRunner = vi.fn().mockImplementation(() => {
      i++;
      if (i === 1) return Promise.resolve({ success: true, output: '{"action":"continue","summary_update":"new sum","directive":"focus","reason":"continuing"}' });
      return Promise.resolve({ success: true, output: '{"action":"terminate","final_message":"end","reason":"consensus"}' });
    });
    const r = makeRunner({ managerRunner }, { managerPollMs: 50 });
    await r.start();
    await r.waitDone();
    expect(fs.readFileSync(path.join(r.discussionDir, 'summary.md'), 'utf-8')).toContain('new sum');
  });

  it('terminates on max_duration when settings.maxDurationMs elapses', async () => {
    const managerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const workerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const onFinal = vi.fn();
    const r = makeRunner({
      managerRunner,
      workerRunner,
      onFinal,
    }, { maxDurationMs: 200, idleTimeoutMs: 10_000, managerPollMs: 10_000 });
    await r.start();
    await r.waitDone();
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ reason: 'max_duration' }));
  });

  it('terminates on timeout when idleTimeoutMs elapses with no file mtime change', async () => {
    const managerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const workerRunner = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}));
    const onFinal = vi.fn();
    const r = makeRunner({
      managerRunner,
      workerRunner,
      onFinal,
    }, { maxDurationMs: 10_000, idleTimeoutMs: 250, managerPollMs: 10_000 });
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
    // New worker b gets a fresh opinion file
    expect(fs.existsSync(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'opinions', 'b.md'))).toBe(true);
    // Control reset to running with bumped revision
    const ctrl = await readControl(path.join(wsRoot, 'demo', 'chats', 'c1', 'discussion', 'control.md'));
    expect(ctrl?.status).toBe('running');
  });
});
