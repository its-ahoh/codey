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

describe('memory refresh across resumed sessions', () => {
  it('injects the latest retrieval while resuming the existing agent session', () => {
    const gateway = Object.create(Codey.prototype) as any;
    const result = gateway.prepareAgentTurn({ sessionAnchor: { agent: 'codex', sessionId: 'warm' } }, 'codex', 'Question', 'Current memory');
    expect(result).toEqual({ prompt: 'Current memory\n\nQuestion', resumeSessionId: 'warm' });
  });
  it('waits for ordinary and Bot anchors to be cleared', async () => {
    const clearSessionAnchor = vi.fn(async () => {});
    const clearAllBotAnchorsForWindow = vi.fn(async () => {});
    const clearChat = vi.fn();
    const gateway = Object.assign(Object.create(Codey.prototype), {
      contextManager: { listConversationIds: () => ['http', 'channel'], clearSessionAnchor, clearAllBotAnchorsForWindow },
      chatManager: { list: () => [{ id: 'desktop' }], clearSessionAnchor: clearChat },
    });
    await gateway.invalidateMemorySessions();
    expect(clearSessionAnchor.mock.calls).toEqual([['http'], ['channel']]);
    expect(clearAllBotAnchorsForWindow.mock.calls).toEqual([['http'], ['channel']]);
    expect(clearChat).toHaveBeenCalledWith('desktop');
  });
});

it('resumes a project team with the chat checkout for both execution and memory', async () => {
  const chat = { id: 'chat', workspaceName: 'project', messages: [], agent: 'codex' };
  let captured: any;
  const gateway = Object.assign(Object.create(Codey.prototype), {
    chatManager: { get: () => chat },
    workspaceManager: {
      getTeam: () => ({ members: ['reviewer'], dispatch: 'sequential' }),
      getBotManager: () => ({ getDispatchHint: () => '', buildSequentialBotPrompt: () => 'Resume prompt' }),
    },
    getDefaultModelConfig: () => undefined,
    botConversationId: () => 'team-conversation',
    rehydrateBotAnchors: async () => {},
    resolveChatWorkingDir: () => '/project/worktrees/chat',
    getSkipPermissions: () => false,
    wrapPromptWithMemory: vi.fn(async () => 'Memory and prompt'),
    runBotStep: async (opts: any) => { captured = opts; return { response: { success: false, error: 'stop fixture' } }; },
  });
  await gateway.resumeTeamFromAnswer('chat', 'base', {
    mode: 'sequential', teamName: 'team', memberIndex: 0, teamTurnId: 'turn', task: 'Review', question: 'Which?', carry: '',
  }, 'This checkout', { status: async () => {}, notify: async () => {}, transcript: '' });
  expect(captured.workingDir).toBe('/project/worktrees/chat');
  await captured.buildBootstrapPrompt();
  expect(gateway.wrapPromptWithMemory).toHaveBeenCalledWith('Resume prompt', 'Review', 'reviewer', false, 'project', '/project/worktrees/chat');
});

it('invalidates sessions even when a bulk archive partially fails', async () => {
  const { gateway, coMemo, message } = fixture();
  coMemo.list.mockResolvedValueOnce([{ id: 'first', version: 1, content: 'First' }, { id: 'second', version: 1, content: 'Second' }]);
  coMemo.change.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('sync failed'));
  await expect(gateway.cmdMemory(['clear'], message)).rejects.toThrow('sync failed');
  expect(gateway.invalidateMemorySessions).toHaveBeenCalledOnce();
});

it('invalidates warm sessions when remember fails after a possible central write', async () => {
  const { gateway, coMemo, message } = fixture();
  coMemo.remember.mockRejectedValueOnce(new Error('Synchronization failed after saving'));
  await expect(gateway.cmdRemember(['Correction'], message)).rejects.toThrow(/Synchronization/);
  expect(gateway.invalidateMemorySessions).toHaveBeenCalledOnce();
});
