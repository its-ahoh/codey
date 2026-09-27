import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BotManager, TeamBlackboard, ContextManager, type Chat, type AgentRequest } from '@codey/core';
import { ChatManager } from './chats';
import { Codey } from './gateway';
import { RunSemaphore } from './chat-runner';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-task-run-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'main'));
  fs.writeFileSync(path.join(root, 'main', 'workspace.json'), JSON.stringify({ workingDir: root }));
  const manager = new ChatManager(root);
  const chat = manager.create({ workspaceName: 'main' });
  manager.createTask(chat.id, 'Website');
  manager.createTask(chat.id, 'Icon');
  const calls: AgentRequest[] = [];
  const bots = new BotManager(path.join(root, 'bots'));
  const run = vi.fn(async (_agent: string, request: AgentRequest) => {
    calls.push(request);
    return { success: true, output: `Result ${calls.length}`, sessionId: request.resumeSessionId ?? `session-${calls.length}` };
  });
  const ctx = {
    coMemo: { context: async () => ({ context: '', settings: { paused: false, saveMode: 'auto' } }), instructions: () => '' },
    chatManager: manager,
    workspaceManager: { getWorkspacesRoot: () => root, getBotManager: () => bots },
    parallelResumes: new Map(),
    chatAborts: new Map(), chatSemaphore: new RunSemaphore(),
    workingDir: root, config: {},
    adoptAgentCreatedWorktree: async () => undefined,
    resolveChatWorkingDir: (chat: Chat) => chat.workingDirOverride ?? chat.botChat?.homeDir ?? root,
    resolveWorkspaceWorkingDir: () => root,
    getDefaultAgent: () => 'codex',
    getDefaultModelConfig: () => undefined,
    getModelConfig: (_agent: string, model: string) => ({ model }),
    getSkipPermissions: () => false,
    isAideConfigured: () => false,
    formatAgentResponse: (response: { output: string }) => response.output,
    fanOutToOtherRoutes: async () => {},
    logger: { info: () => {}, warn: () => {} },
    runWithFallback: run,
    historyDelivery: () => ({}),
  };
  const gateway = Object.assign(Object.create(Codey.prototype), ctx) as Codey;
  const send = (text: string, taskId?: string | null) => Codey.prototype.sendToChat.call(
    gateway, chat.id, text, () => {}, undefined, undefined,
    taskId === undefined ? undefined : { taskId },
  );
  return { root, gateway, manager, chat, calls, run, send, bots, a: chat.tasks![0].id, b: chat.tasks![1].id };
}

describe('task execution integration', () => {
  it('runs A, then B, then resumes A without replaying B', async () => {
    const { send, calls, chat, a, b } = setup();
    await send('WEBSITE PRIVATE', a);
    await send('ICON PRIVATE', b);
    await send('Continue the website', a);
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(calls[1].prompt).not.toContain('WEBSITE PRIVATE');
    expect(calls[2].resumeSessionId).toBe('session-1');
    expect(calls[2].prompt).not.toContain('ICON PRIVATE');
    expect(chat.messages.map(m => m.taskId)).toEqual([a, a, b, b, a, a]);
  });
  it('recovers a missing session using only that task history', async () => {
    const { send, calls, run, a, b } = setup();
    await send('WEBSITE PRIVATE', a);
    await send('ICON PRIVATE', b);
    run.mockImplementationOnce(async (_agent, request) => {
      calls.push(request);
      return { success: false, output: '', sessionId: '', error: 'Session session-1 does not exist' };
    });
    await send('Continue', a);
    const recovered = calls[calls.length - 1];
    expect(recovered.resumeSessionId).toBeUndefined();
    expect(recovered.prompt).toContain('WEBSITE PRIVATE');
    expect(recovered.prompt).not.toContain('ICON PRIVATE');
  });
  it('continues the recent task when automatic matching is unavailable', async () => {
    const { send, calls, chat, a } = setup();
    await send('WEBSITE PRIVATE', a);
    await send('Make it blue');
    expect(calls).toHaveLength(2);
    expect(calls[1].resumeSessionId).toBe('session-1');
    expect(chat.messages.every(message => message.taskId === a)).toBe(true);
  });
  it('uses the selected Bot personality with the chat execution settings', async () => {
    const { bots, manager, chat, calls, send, a, gateway } = setup();
    gateway.getDefaultModelConfig = () => ({ provider: 'openai', model: 'default-model' });
    await bots.saveBot('alice', { role: 'Design reviewer', soul: 'Concise and thoughtful', instructions: 'Explain the tradeoffs.' },
      { tools: [] });
    manager.updateSelection(chat.id, { type: 'bot', name: 'alice' });
    await send('Review the homepage', a);
    expect(calls[0].agent).toBe('codex');
    expect(calls[0].model?.model).toBe('default-model');
    expect(calls[0].effort).toBeUndefined();
    expect(calls[0].prompt).toContain('Design reviewer');
    expect(calls[0].prompt).toContain('Explain the tradeoffs.');
    expect(calls).toHaveLength(1);
    chat.agent = 'pi';
    chat.model = 'explicit-model';
    chat.effort = 'high';
    await send('Review again', a);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ agent: 'pi', model: { model: 'explicit-model' }, effort: 'high' });
  });
});


describe('global Bot conversations', () => {
  it('keeps active workspace memory out of global Bot prompts', async () => {
    const { gateway, root } = setup();
    const context = vi.fn(async (_query: string, project?: string) => ({
      context: project ? 'USER PREFERENCE\nPROJECT RULE' : 'USER PREFERENCE',
      settings: { paused: false, saveMode: 'auto' },
    }));
    Object.assign(gateway, { coMemo: { context, instructions: () => '' } });
    const prompt = await (gateway as any).wrapPromptWithMemory('Review', 'Review', 'alice', true);
    expect(prompt).toContain('USER PREFERENCE');
    expect(prompt).not.toContain('PROJECT RULE');
    expect(context).toHaveBeenLastCalledWith('Review', undefined);
    expect(await (gateway as any).wrapPromptWithMemory('Review', 'Review', 'alice', false, 'main')).toContain('PROJECT RULE');
    expect(context).toHaveBeenLastCalledWith('Review', root);
  });
  async function bots() {
    const h = setup();
    for (const name of ['alice', 'ben', 'claire']) {
      await h.bots.saveBot(name, { role: name, soul: 'Helpful', instructions: 'Do the task.' },
        { tools: [] });
    }
    return h;
  }
  it('opens one durable direct chat without a workspace and preserves its title', async () => {
    const { root, gateway, manager, calls } = await bots();
    const [first, again] = await Promise.all([gateway.openBotChat('alice'), gateway.openBotChat('ALICE')]);
    expect(first.id).toBe(again.id);
    expect(fs.existsSync(path.join(root, first.workspaceName, 'workspace.json'))).toBe(false);
    await gateway.sendToChat(first.id, 'Design the homepage', () => {});
    expect(calls[0].context?.workingDir).toBe(first.botChat?.homeDir);
    expect(manager.get(first.id)?.title).toBe('alice');
    expect(new ChatManager(root).get(first.id)?.botChat?.members).toEqual(['alice']);
  });
  it('creates and resumes automatically matched tasks without a client task selection', async () => {
    const { gateway, calls } = await bots();
    const direct = await gateway.openBotChat('alice');
    const classifier = vi.fn(async () => ({ success: true, output: JSON.stringify({ kind: 'new', title: 'Website' }) }));
    Object.assign(gateway, { isAideConfigured: () => true, getAideOptions: () => ({ agent: 'codex', runner: classifier }) });
    const events: any[] = [];
    await gateway.sendToChat(direct.id, 'Build a homepage', event => events.push(event));
    const taskId = direct.tasks![0].id;
    expect(direct.messages.every(message => message.taskId === taskId)).toBe(true);
    expect(events.find(event => event.type === 'done')?.taskId).toBe(taskId);
    classifier.mockResolvedValue({ success: true, output: JSON.stringify({ kind: 'existing', taskId }) });
    await gateway.sendToChat(direct.id, 'Make it blue', () => {});
    expect(calls[1].resumeSessionId).toBe(calls[0].resumeSessionId ?? 'session-1');
    expect(direct.tasks).toHaveLength(1);
  });
  it('renames Bot references without losing direct conversation identity', async () => {
    const { gateway, bots: botManager } = await bots();
    const direct = await gateway.openBotChat('alice');
    const group = await gateway.createBotGroup('Product', ['alice', 'ben']);
    await botManager.renameBot('alice', 'designer');
    gateway.renameBotChats('alice', 'designer');
    expect((await gateway.openBotChat('designer')).id).toBe(direct.id);
    expect(group.botChat?.members).toEqual(['designer', 'ben']);
  });
  it('invites Bots into a linked group sharing only explicitly supplied context', async () => {
    const { gateway, manager, root } = await bots();
    const direct = await gateway.openBotChat('alice');
    manager.appendMessage(direct.id, { id: 'private', role: 'user', content: 'PRIVATE SECRET', timestamp: 1 });
    const group = await gateway.inviteBotsToGroup(direct.id, 'Design review', ['BEN'], 'Review the blue design.');
    expect(group.botChat?.members).toEqual(['alice', 'ben']);
    expect(group.botChat?.sourceChatId).toBe(direct.id);
    expect(group.messages.map(m => m.content).join('\n')).toContain('Review the blue design.');
    expect(JSON.stringify(group)).not.toContain('PRIVATE SECRET');
    expect((await gateway.openBotChat('alice')).id).toBe(direct.id);
    expect(direct.messages).toHaveLength(1);
    expect(new ChatManager(root).get(group.id)?.botChat?.sourceChatId).toBe(direct.id);
    await expect(gateway.inviteBotsToGroup(group.id, 'Invalid', ['claire'], '')).rejects.toThrow('direct chat');
    await expect(gateway.inviteBotsToGroup(direct.id, 'Invalid', ['alice'], '')).rejects.toThrow('two Bots');
  });
  it('persists membership changes and blocks edits during running or paused tasks', async () => {
    const { gateway, manager, root } = await bots();
    const group = await gateway.createBotGroup('Review', ['alice', 'ben']);
    manager.appendMessage(group.id, { id: 'past', role: 'assistant', content: 'Past review', timestamp: 1 });
    await gateway.updateBotGroup(group.id, ['alice', 'claire']);
    expect(group.botChat?.membershipRevision).toBe(1);
    expect(group.messages[0].content).toBe('Past review');
    expect(group.messages[1].content).toContain('Removed: ben');
    expect(new ChatManager(root).get(group.id)?.botChat?.members).toEqual(['alice', 'claire']);
    await gateway.updateBotGroup(group.id, ['alice', 'claire']);
    expect(group.messages).toHaveLength(2);
    await expect(gateway.updateBotGroup(group.id, ['alice', 'missing'])).rejects.toThrow('not found');
    (gateway as any).chatAborts.set(group.id, new AbortController());
    await expect(gateway.updateBotGroup(group.id, ['alice', 'ben'])).rejects.toThrow('current group turn');
    (gateway as any).chatAborts.delete(group.id);
    group.pendingTeam = { mode: 'auto' } as any;
    await expect(gateway.updateBotGroup(group.id, ['alice', 'ben'])).rejects.toThrow('paused group task');
    expect(group.botChat?.members).toEqual(['alice', 'claire']);
  });
  it('validates group members and keeps unrelated direct histories private', async () => {
    const { gateway, manager } = await bots();
    const direct = await gateway.openBotChat('alice');
    manager.appendMessage(direct.id, { id: 'private', role: 'user', content: 'PRIVATE', timestamp: 1 });
    const group = await gateway.createBotGroup('Product', ['alice', 'ben']);
    expect(group.messages).toEqual([]);
    expect(group.botChat?.kind).toBe('group');
    await expect(gateway.createBotGroup('Wrong', ['alice', 'ALICE'])).rejects.toThrow('two Bots');
    await expect(gateway.createBotGroup('Wrong', ['alice', 'missing'])).rejects.toThrow('not found');
    expect(() => manager.createTask(group.id, 'Wrong')).toThrow('direct chats');
  });
  it('uses Advisor configuration for group coordination', async () => {
    const { gateway, root } = await bots();
    const group = await gateway.createBotGroup('Product', ['alice', 'ben']);
    const coordinator = { agent: 'pi', model: { model: 'advisor-model' } };
    const loop = vi.fn(async () => ({ fallback: false, parts: [], finalSummary: 'Done', blackboard: new TeamBlackboard() }));
    Object.assign(gateway, { runAdvisorLoop: loop, getAdvisorAgentAndModel: () => coordinator });
    await (gateway as any).runTeamForChat('Product', { members: ['alice', 'ben'], dispatch: 'auto' },
      'Review', root, () => {}, group.id, group);
    expect(loop).toHaveBeenCalled();
    expect((loop.mock.calls[0] as unknown[])[8]).toEqual(coordinator);
  });
  it('routes group messages automatically and honors mentions of members', async () => {
    const { gateway, manager } = await bots();
    const group = await gateway.createBotGroup('Product', ['alice', 'ben']);
    const dispatch = vi.fn(async (_name, _team, _prompt, _dir, _sink, _id) => {
      // Leave completion to the ordinary chat finalization path.
      return { response: 'Reviewed' };
    });
    Object.assign(gateway, { runTeamForChat: dispatch });
    await gateway.sendToChat(group.id, 'Review the design', () => {});
    expect(dispatch.mock.calls[0][1]).toEqual({ members: ['alice', 'ben'], dispatch: 'auto' });
    await gateway.sendToChat(group.id, '@ben Check the implementation', () => {});
    expect(dispatch.mock.calls[1][1].members).toEqual(['ben']);
    await expect(gateway.sendToChat(group.id, '@claire Read this', () => {})).rejects.toThrow('Only members');
    expect(manager.get(group.id)?.title).toBe('Product');
  });
});

describe('shared memory for Bot execution', () => {
  it('reads Co-memo for the bound chat across Bots/backends and records the actual injected snapshot', async () => {
    const { root, gateway, bots, chat, manager, send, a, calls } = setup();
    for (const name of ['alice', 'bob']) {
      await bots.saveBot(name, { role: 'Reviewer', soul: 'Careful', instructions: 'Review changes.' }, { tools: [] });
    }
    const context = vi.fn(async (_query: string, project: string) => ({
      context: project === root ? 'Prefer concise reviews. Run project checks.' : 'WRONG PROJECT',
      settings: { paused: false, saveMode: 'auto' },
    }));
    Object.assign(gateway, { coMemo: { context, instructions: () => 'Co-memo CLI access' } });
    manager.updateSelection(chat.id, { type: 'bot', name: 'alice' });
    await send('Review this', a);
    manager.updateSelection(chat.id, { type: 'bot', name: 'bob' });
    chat.agent = 'pi';
    await send('Review again', a);
    for (const call of calls) {
      expect(call.prompt).toContain('Prefer concise reviews. Run project checks.');
      expect(call.prompt).toContain('Co-memo CLI access');
      expect(call.prompt).not.toContain('WRONG PROJECT');
      expect(call.prompt).not.toContain('<codey-memory>');
    }
    expect(calls[1].agent).toBe('pi');
    const trace = manager.get(chat.id)!.messages.filter(m => m.role === 'assistant').at(-1)!.memoryUsed!;
    expect(trace).toHaveLength(1);
    expect(trace[0].id).toMatch(/^co-memo:/);
    expect(calls[1].prompt).toContain(trace[0].content);
    (gateway as any).config.memory = { enabled: false };
    await send('Review once more', a);
    expect(context).toHaveBeenCalledTimes(2);
    expect(calls[2].prompt).not.toContain('Prefer concise reviews');
    expect(manager.get(chat.id)!.messages.filter(m => m.role === 'assistant').at(-1)!.memoryUsed).toEqual([]);
  });
  it('continues a task without injecting unavailable or paused shared context', async () => {
    const { gateway, send, calls, a } = setup();
    Object.assign(gateway, { coMemo: { context: async () => { throw new Error('offline'); }, instructions: () => '' } });
    await send('Continue', a);
    expect(calls[0].prompt).toContain('Continue');
    Object.assign(gateway, { coMemo: { context: async () => ({ context: 'HIDDEN', settings: { paused: true } }), instructions: () => '' } });
    await send('Next', a);
    expect(calls[1].prompt).not.toContain('HIDDEN');
  });
});


it('does not reattach a chat session when memory changes during its turn', async () => {
  const { gateway, run, send, chat, calls, a } = setup();
  Object.assign(gateway, { contextManager: new ContextManager() });
  run.mockImplementationOnce(async (_agent, request) => {
    calls.push(request);
    await gateway.invalidateMemorySessions();
    return { success: true, output: 'Done', sessionId: 'stale-result' };
  });
  await send('Start the task', a);
  expect(chat.sessionAnchor).toBeUndefined();
  expect(chat.sessionAnchors).toBeUndefined();
  await send('Continue', a);
  expect(calls[1].resumeSessionId).toBeUndefined();
});
