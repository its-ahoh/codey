import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ParallelTeamRunner } from './parallel-team';

const stubRunner = vi.fn().mockResolvedValue({ success: true, output: '' });

function makeRunner(overrides: Partial<ConstructorParameters<typeof ParallelTeamRunner>[0]> = {}) {
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  fs.mkdirSync(path.join(workspacesRoot, 'demo', 'chats', 'c1'), { recursive: true });
  return new ParallelTeamRunner({
    workspacesRoot,
    workspace: 'demo',
    chatId: 'c1',
    teamName: 'rt',
    members: ['a', 'b'],
    topic: 'Decide X',
    settings: { maxDurationMs: 1000, idleTimeoutMs: 500, managerPollMs: 200 },
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
});
