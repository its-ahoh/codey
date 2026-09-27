import { describe, expect, it, vi } from 'vitest';
import { ContextManager, TeamBlackboard } from '@codey/core';
import { Codey } from './gateway';

function lifecycle() {
  const contextManager = new ContextManager();
  const chat: any = { id: 'chat' };
  const gateway = Object.assign(Object.create(Codey.prototype), {
    contextManager, workingDir: '/project-a',
    chatManager: { list: () => [chat], get: () => chat, clearSessionAnchor: vi.fn(), setPendingTeam: vi.fn() },
    workspaceManager: { getBotManager: () => ({ buildResumeBotPrompt: () => 'Continue' }) },
    buildMergedMemoryContext: async () => 'Current memory', logger: { warn: vi.fn() },
  }) as any;
  return { gateway, contextManager, chat };
}

describe('memory session lifecycle', () => {
  it('clears persisted paused anchors and rejects a detached snapshot after invalidation', async () => {
    const { gateway, contextManager, chat } = lifecycle();
    const snapshot = { reviewer: { agent: 'codex', sessionId: 'old', botName: 'reviewer', blackboardSeenCount: 0, bootstrappedAt: Date.now() } };
    chat.pendingTeam = { teamName: 'review', botAnchors: snapshot };
    await contextManager.setBotAnchor('team', 'reviewer', snapshot.reviewer);
    await gateway.invalidateMemorySessions();
    expect(chat.pendingTeam.botAnchors).toBeUndefined();
    expect(gateway.chatManager.setPendingTeam).toHaveBeenCalledWith(chat.id, chat.pendingTeam);
    // A pause snapshot racing with invalidation must not persist stale anchors either.
    await contextManager.setBotAnchor('team', 'reviewer', snapshot.reviewer);
    expect(gateway.snapshotBotAnchors('team')).toEqual({});
    await contextManager.clearAllBotAnchorsForWindow('team');
    await gateway.rehydrateBotAnchors('team', snapshot);
    expect(contextManager.getBotAnchor('team', 'reviewer')).toBeUndefined();
  });
  it('rejects an ordinary in-flight result but accepts a new generation', async () => {
    const { gateway, contextManager } = lifecycle();
    const window = await contextManager.getOrCreate('http');
    await gateway.invalidateMemorySessions();
    await gateway.commitSessionAnchor(window, 'codex', { success: true, sessionId: 'old' }, undefined, false, 0);
    expect(window.sessionAnchor).toBeUndefined();
    await gateway.commitSessionAnchor(window, 'codex', { success: true, sessionId: 'new' }, undefined, false, 1);
    expect(window.sessionAnchor?.sessionId).toBe('new');
  });
  it.each([false, true])('does not restore an invalidated Bot session (warm=%s)', async warm => {
    const { gateway, contextManager } = lifecycle();
    if (warm) await contextManager.setBotAnchor('team', 'reviewer', {
      agent: 'codex', sessionId: 'old', botName: 'reviewer', blackboardSeenCount: 0,
      bootstrappedAt: Date.now(), memoryEpoch: 0, workingDir: '/project-a',
    });
    gateway.runWithFallback = vi.fn(async () => {
      await gateway.invalidateMemorySessions();
      return { success: true, output: 'Done', sessionId: 'result' };
    });
    await gateway.runBotStep({ conversationId: 'team', botName: 'reviewer', task: 'Review',
      blackboard: new TeamBlackboard(), codingAgent: 'codex', buildBootstrapPrompt: () => 'Fresh' });
    expect(contextManager.getBotAnchor('team', 'reviewer')).toBeUndefined();
    expect(gateway.runWithFallback.mock.calls[0][1].resumeSessionId).toBe(warm ? 'old' : undefined);
  });
  it('does not resume a Bot session from a different checkout', async () => {
    const { gateway, contextManager } = lifecycle();
    await contextManager.setBotAnchor('team', 'reviewer', {
      agent: 'codex', sessionId: 'project-b', botName: 'reviewer', blackboardSeenCount: 0,
      bootstrappedAt: Date.now(), memoryEpoch: 0, workingDir: '/project-b',
    });
    gateway.runWithFallback = vi.fn(async () => ({ success: true, sessionId: 'project-a' }));
    await gateway.runBotStep({ conversationId: 'team', botName: 'reviewer', task: 'Review',
      blackboard: new TeamBlackboard(), codingAgent: 'codex', buildBootstrapPrompt: () => 'Fresh' });
    expect(gateway.runWithFallback.mock.calls[0][1].resumeSessionId).toBeUndefined();
  });
});

describe('channel command memory scope', () => {
  function fixture(global = false) {
    const chat = { id: 'bound', workspaceName: 'A', ...(global ? { botChat: {} } : {}) };
    const gateway = Object.assign(Object.create(Codey.prototype), {
      workingDir: '/wrong-project', handlers: new Map(),
      resolveChatId: () => chat.id, chatManager: { get: () => chat },
      resolveChatWorkingDir: () => '/project-a/worktree',
      workspaceManager: { getTeam: () => ({ members: ['reviewer'], dispatch: 'sequential' }),
        getBotManager: () => ({ getBot: () => ({ name: 'reviewer', personality: { role: 'Review' } }), buildBotPrompt: () => 'Review' }) },
      getDefaultAgent: () => 'codex', getDefaultModelName: () => 'model', getDefaultModelConfig: () => undefined,
      getSkipPermissions: () => false, sendResponse: vi.fn(async () => {}),
      wrapPromptWithMemory: vi.fn(async () => 'Scoped'),
      runBotStep: vi.fn(async (opts: any) => { await opts.buildBootstrapPrompt(); return { response: { success: true, output: 'Done' } }; }),
      runAllMembersInOrder: vi.fn(async (_e: any, _chat: any, _base: any, _team: any, _members: any, _task: any, run: any) => {
        await run('reviewer', 'Review', 'codex', undefined, new TeamBlackboard());
      }),
    }) as any;
    return { gateway, message: { channel: 'telegram', userId: 'user', chatId: 'external' }, chat };
  }
  it.each([false, true])('scopes /bot by the bound chat (global=%s)', async global => {
    const { gateway, message, chat } = fixture(global);
    await gateway.cmdBot(['reviewer', 'Task'], message, '');
    expect(gateway.wrapPromptWithMemory).toHaveBeenCalledWith('Review', 'Task', 'reviewer', global, 'A', '/project-a/worktree');
    expect(gateway.runBotStep.mock.calls[0][0]).toMatchObject({ workingDir: '/project-a/worktree', browserChatId: chat.id });
  });
  it('scopes /team memory and persisted pauses by the bound chat', async () => {
    const { gateway, message, chat } = fixture();
    await gateway.runTeamTask(message, 'review', 'Task', { forceAll: true });
    expect(gateway.wrapPromptWithMemory).toHaveBeenCalledWith('Review', 'Task', 'reviewer', false, 'A', '/project-a/worktree');
    expect(gateway.runAllMembersInOrder.mock.calls[0].slice(1, 3)).toEqual([chat.id, `chat-${chat.id}`]);
    expect(gateway.runBotStep.mock.calls[0][0]).toMatchObject({ workingDir: '/project-a/worktree', browserChatId: chat.id });
  });
});

it('resumes a channel pause using the internal chat ID while replying to the external channel', async () => {
  const pending = { teamName: 'review', mode: 'sequential', question: 'Proceed?' };
  const gateway = Object.assign(Object.create(Codey.prototype), {
    processingMessages: new Set(), pendingSkillSuggestions: new Map(), messagesProcessed: 0, errors: 0,
    resolveChatId: () => 'internal',
    chatManager: { get: (id: string) => id === 'internal' ? { id, pendingTeam: pending } : undefined, setPendingTeam: vi.fn() },
    handlers: new Map(), logger: { info: vi.fn(), error: vi.fn() }, sendResponse: vi.fn(async () => {}),
    resumeTeamFromAnswer: vi.fn(async (_id: string, _base: string, _pending: any, _answer: string, emitter: any) => {
      await emitter.notify('Resumed');
    }),
  }) as any;
  await gateway.handleMessage({ id: 'reply', channel: 'telegram', userId: 'user', chatId: 'external', text: 'Yes' });
  expect(gateway.chatManager.setPendingTeam).toHaveBeenCalledWith('internal', null);
  expect(gateway.resumeTeamFromAnswer.mock.calls[0].slice(0, 4)).toEqual(['internal', 'chat-internal', pending, 'Yes']);
  expect(gateway.sendResponse).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'external', text: 'Resumed' }));
  expect(gateway.errors).toBe(0);
});

it('keeps a channel graph pause in the bound chat conversation', async () => {
  const gateway = Object.assign(Object.create(Codey.prototype), {
    handlers: new Map(), sendResponse: vi.fn(async () => {}), continueGraphRun: vi.fn(async (emitter: any) => { await emitter.notify('Paused'); }),
  }) as any;
  const graph = { entry: 'start', maxHops: 5,
    nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'review', type: 'bot', bot: 'reviewer', x: 1, y: 0 }, { id: 'end', type: 'end', x: 2, y: 0 }],
    edges: [{ id: '1', from: 'start', to: 'review' }, { id: '2', from: 'review', to: 'end', isDefault: true }] };
  await gateway.runSequentialGraphForChat({ channel: 'telegram', chatId: 'external' }, 'review', graph, 'Task', vi.fn(), 'turn', { chatId: 'internal', baseConv: 'chat-internal' });
  expect(gateway.continueGraphRun.mock.calls[0].slice(1, 3)).toEqual(['internal', 'chat-internal']);
  expect(gateway.sendResponse).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'external' }));
});
