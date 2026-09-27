import { describe, expect, it, vi } from 'vitest';
import { Codey } from './gateway';

function fixture() {
  const coMemo = {
    remember: vi.fn(async (content: string, scope: string) => ({ id: 'note', version: 3, content, scope })),
    list: vi.fn(async () => [{ id: 'note', version: 3, content: 'Project convention' }]),
    change: vi.fn(async () => ({})),
  };
  const sendResponse = vi.fn(async () => {});
  const gateway = Object.assign(Object.create(Codey.prototype), {
    coMemo, sendResponse, resolveChatId: () => 'bound-chat',
    chatManager: { get: () => ({ workspaceName: 'bound-project' }) },
    workspaceManager: { getCurrentWorkspace: () => 'wrong-project' },
    resolveChatWorkingDir: () => '/bound-project/worktree',
    invalidateMemorySessions: vi.fn(),
  });
  const message = { channel: 'telegram', userId: 'user', chatId: 'channel-chat', text: '', id: 'message' };
  return { gateway, coMemo, sendResponse, message };
}
describe('channel commands use Co-memo', () => {
  it('binds project writes to the channel chat and user writes to personal scope', async () => {
    const { gateway, coMemo, message } = fixture();
    await gateway.cmdRemember(['Use', 'pnpm'], message);
    expect(coMemo.remember).toHaveBeenLastCalledWith('Use pnpm', 'project', '/bound-project/worktree');
    await gateway.cmdRemember(['--global', 'Be concise'], message);
    expect(coMemo.remember).toHaveBeenLastCalledWith('Be concise', 'user', undefined);
    await gateway.cmdRemember(['--bot', 'reviewer', 'Private'], message);
    expect(coMemo.remember).toHaveBeenCalledTimes(2);
  });
  it('archives only the selected scope with the versions just listed', async () => {
    const { gateway, coMemo, message } = fixture();
    await gateway.cmdMemory(['clear'], message);
    expect(coMemo.list).toHaveBeenCalledWith('project', '/bound-project/worktree', undefined);
    expect(coMemo.change).toHaveBeenCalledWith('note', 3, 'project', '/bound-project/worktree');
    expect(gateway.invalidateMemorySessions).toHaveBeenCalledOnce();
  });
  it('does not report a failed write as saved', async () => {
    const { gateway, coMemo, message, sendResponse } = fixture();
    coMemo.remember.mockRejectedValueOnce(new Error('Co-memo is paused'));
    await expect(gateway.cmdRemember(['Remember'], message)).rejects.toThrow(/paused/);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
