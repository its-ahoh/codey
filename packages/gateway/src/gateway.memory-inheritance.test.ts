import { expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { Codey } from './gateway';
import { inheritWorktreeMemory } from './worktree-memory';
import { discoverChatWorktree } from './chat-worktree';
vi.mock('./worktree-memory', () => ({ inheritWorktreeMemory: vi.fn() }));
vi.mock('./chat-worktree', async importOriginal => ({
  ...await importOriginal<typeof import('./chat-worktree')>(),
  discoverChatWorktree: vi.fn(), ensureWorktreeContainer: vi.fn(),
}));
function fixture() {
  const workspace = { workingDir: os.tmpdir(), worktreePath: os.tmpdir(), createdAt: 1, memoryInheritance: 'pending' };
  const chat: any = { id: 'chat', workspaceName: 'project', executionMode: 'isolated-worktree', chatWorkspace: workspace };
  const gateway = Object.assign(Object.create(Codey.prototype), {
    chatManager: { get: () => chat, list: () => [], setChatWorkspace: (_id: string, value: any) => { chat.chatWorkspace = value; return chat; } },
    workspaceManager: { getWorkspacesRoot: () => os.tmpdir() },
    resolveWorkspaceWorkingDir: () => os.tmpdir(), getCoMemo: () => ({}),
    logger: { warn: vi.fn(), info: vi.fn() },
  });
  return { gateway, chat, workspace };
}
it('keeps the checkout usable after a blocked inheritance and completes a later retry', async () => {
  const { gateway, chat } = fixture();
  vi.mocked(inheritWorktreeMemory).mockRejectedValueOnce(new Error('Explicit-only mode')).mockResolvedValueOnce();
  expect(await gateway.ensureChatWorkspace(chat.id)).toBe(chat);
  expect(chat.chatWorkspace.memoryInheritance).toBe('pending');
  expect(gateway.resolveChatWorkingDir(chat)).toBe(os.tmpdir());
  await gateway.ensureChatWorkspace(chat.id);
  expect(chat.chatWorkspace.memoryInheritance).toBe('complete');
});
it('initializes memory when adopting an agent-created worktree', async () => {
  const { gateway, chat, workspace } = fixture();
  delete chat.chatWorkspace;
  vi.mocked(discoverChatWorktree).mockResolvedValueOnce(workspace as any);
  vi.mocked(inheritWorktreeMemory).mockResolvedValueOnce();
  await gateway.adoptAgentCreatedWorktree(chat.id);
  expect(chat.chatWorkspace.memoryInheritance).toBe('complete');
});
