import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forkOpenCodeSession, revertCodexTurns, type ChatMessage } from '@codey/core';
import { Codey } from './gateway';
import { captureCheckpoint, turnRef } from './turn-checkpoints';

vi.mock('@codey/core', async (orig) => ({
  ...await orig<typeof import('@codey/core')>(),
  revertCodexTurns: vi.fn(async () => true),
  forkOpenCodeSession: vi.fn(async () => 'oc-fork'),
  forkPiSession: vi.fn(async () => null),
}));

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const write = (dir: string, rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

let repo: string;

function fixture(executionMode: 'isolated-worktree' | 'shared-checkout' = 'isolated-worktree') {
  const chat: any = { id: 'chat', workspaceName: 'project', executionMode, messages: [] as ChatMessage[] };
  const chatManager = {
    get: () => chat,
    updateMessage: (_id: string, messageId: string, patch: Partial<ChatMessage>) => {
      const m = chat.messages.find((x: ChatMessage) => x.id === messageId);
      Object.assign(m, patch);
      return chat;
    },
    setPendingRewind: (_id: string, rewind: any) => {
      if (rewind) chat.pendingRewind = rewind; else delete chat.pendingRewind;
    },
    setSessionAnchor: (_id: string, anchor: any) => {
      chat.sessionAnchors = (chat.sessionAnchors ?? [])
        .filter((a: any) => a.agent !== anchor.agent || a.scopeKey !== anchor.scopeKey).concat(anchor);
    },
    clearSessionAnchor: (_id: string, agent: string, scopeKey?: string) => {
      chat.sessionAnchors = (chat.sessionAnchors ?? []).filter((a: any) => a.agent !== agent || a.scopeKey !== scopeKey);
    },
  };
  const gateway = Object.assign(Object.create(Codey.prototype), {
    chatManager,
    chatAborts: new Map(),
    logger: { warn: vi.fn(), info: vi.fn() },
  }) as Codey;
  (gateway as any).resolveChatWorkingDir = () => repo;
  return { gateway, chat };
}

/** Simulates one agent turn: snapshot, then the agent's file changes. */
async function turn(chat: any, id: string, change: () => void, agentSession?: ChatMessage['agentSession']) {
  const before = await captureCheckpoint(repo, turnRef(chat.id, id, 'before'));
  chat.messages.push({ id, role: 'user', content: `do ${id}`, timestamp: 0, checkpoint: { before: before!.commit, head: before!.head }, ...(agentSession ? { agentSession } : {}) });
  change();
  chat.messages.push({ id: `${id}-reply`, role: 'assistant', content: 'done', timestamp: 0 });
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codey-undo-')));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'a.txt', 'v0\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('undoTurn / redoTurn', () => {
  it('undoes a turn and every later turn, tells the agent, and redoes', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    await turn(chat, 'u2', () => write(repo, 'b.txt', 'new\n'));

    const preview = await gateway.previewUndoTurn('chat', 'u1');
    expect(preview).toEqual({ ok: true, turns: 2, files: 2 });

    await gateway.undoTurn('chat', 'u1');
    expect(read(repo, 'a.txt')).toBe('v0\n');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false);
    expect(chat.messages[0].checkpoint.undone).toBeTruthy();
    expect(chat.messages[2].checkpoint.undone).toBeTruthy();
    expect(chat.messages.every((m: ChatMessage) => m.undone)).toBe(true);
    expect(chat.pendingRewind).toEqual({ fromMessageId: 'u1' });

    await gateway.redoTurn('chat', 'u1');
    expect(read(repo, 'a.txt')).toBe('v1\n');
    expect(read(repo, 'b.txt')).toBe('new\n');
    expect(chat.messages[0].checkpoint.undone).toBeUndefined();
    expect(chat.messages[2].checkpoint.undone).toBeUndefined();
    expect(chat.messages.some((m: ChatMessage) => m.undone)).toBe(false);
    // Nothing was rewound yet, so there is nothing left to rewind.
    expect(chat.pendingRewind).toBeUndefined();
  });

  it('refuses while a turn is running', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    (gateway as any).chatAborts.set('chat', new AbortController());
    await expect(gateway.undoTurn('chat', 'u1')).rejects.toThrow(/current turn/);
    expect(read(repo, 'a.txt')).toBe('v1\n');
  });

  it('refuses once a commit was made after the turn started', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => {
      write(repo, 'a.txt', 'v1\n');
      git(repo, 'commit', '-qam', 'agent commit');
    });
    const preview = await gateway.previewUndoTurn('chat', 'u1');
    expect(preview.ok).toBe(false);
    expect(preview.reason).toMatch(/commit/);
    await expect(gateway.undoTurn('chat', 'u1')).rejects.toThrow(/commit/);
  });

  it('refuses in a shared checkout', async () => {
    const { gateway, chat } = fixture('shared-checkout');
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    await expect(gateway.undoTurn('chat', 'u1')).rejects.toThrow(/own worktree/);
  });

  it('cannot redo once a new turn ran after the undo', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    await gateway.undoTurn('chat', 'u1');
    await turn(chat, 'u2', () => write(repo, 'c.txt', 'c\n'));
    await expect(gateway.redoTurn('chat', 'u1')).rejects.toThrow(/New turns/);
  });
});

describe('applyPendingRewind', () => {
  const claude = (n: number) => ({ agent: 'claude-code' as const, sessionId: 'claude-s', endId: `end-${n}` });
  const codex = { agent: 'codex' as const, sessionId: 'codex-t' };

  it('resumes Claude at its last kept message, past turns undone', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), claude(1));
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), claude(2));
    await turn(chat, 'u3', () => write(repo, 'a.txt', '3\n'), claude(3));
    chat.sessionAnchors = [{ agent: 'claude-code', sessionId: 'claude-s', syncedThroughMessageId: 'u3-reply' }];
    await gateway.undoTurn('chat', 'u2');

    await (gateway as any).applyPendingRewind(chat, repo);
    expect(chat.sessionAnchors).toEqual([{ agent: 'claude-code', sessionId: 'claude-s', syncedThroughMessageId: 'u1-reply', resumeAt: 'end-1' }]);
    expect(chat.pendingRewind).toBeUndefined();
  });

  it('reverts Codex by the number of undone turns it ran', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), codex);
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), codex);
    await turn(chat, 'u3', () => write(repo, 'a.txt', '3\n'), codex);
    chat.sessionAnchors = [{ agent: 'codex', sessionId: 'codex-t', syncedThroughMessageId: 'u3-reply' }];
    await gateway.undoTurn('chat', 'u2');

    await (gateway as any).applyPendingRewind(chat, repo);
    expect(vi.mocked(revertCodexTurns)).toHaveBeenCalledWith('codex-t', 2, { cwd: repo });
    expect(chat.sessionAnchors).toEqual([{ agent: 'codex', sessionId: 'codex-t', syncedThroughMessageId: 'u1-reply' }]);
  });

  it('starts fresh when Codex cannot revert or the whole session was undone; leaves untouched sessions alone', async () => {
    vi.mocked(revertCodexTurns).mockResolvedValueOnce(false);
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), { agent: 'opencode', sessionId: 'oc' });
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), codex);
    await turn(chat, 'u3', () => write(repo, 'a.txt', '3\n'), codex);
    await turn(chat, 'u4', () => write(repo, 'a.txt', '4\n'), { agent: 'opencode', sessionId: 'oc' });
    await turn(chat, 'u5', () => write(repo, 'a.txt', '5\n'), claude(5));
    chat.sessionAnchors = [
      { agent: 'opencode', sessionId: 'oc' },
      { agent: 'codex', sessionId: 'codex-t' },
      { agent: 'claude-code', sessionId: 'claude-s' },
      { agent: 'pi', sessionId: 'untouched' },
    ];
    await gateway.undoTurn('chat', 'u3');

    await (gateway as any).applyPendingRewind(chat, repo);
    // codex revert failed: dropped. claude ran only undone turns: dropped.
    // pi ran nothing undone: kept. opencode forked before u4.
    expect(chat.sessionAnchors).toEqual([
      { agent: 'pi', sessionId: 'untouched' },
      { agent: 'opencode', sessionId: 'oc-fork', syncedThroughMessageId: 'u1-reply' },
    ]);
  });
});

describe('applyPendingRewind: OpenCode and Pi', () => {
  it('switches OpenCode to its fork and moves kept turns onto it; a failed Pi fork starts fresh', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), { agent: 'opencode', sessionId: 'oc' });
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), { agent: 'pi', sessionId: 'pi-s' });
    await turn(chat, 'u3', () => write(repo, 'a.txt', '3\n'), { agent: 'opencode', sessionId: 'oc' });
    await turn(chat, 'u4', () => write(repo, 'a.txt', '4\n'), { agent: 'pi', sessionId: 'pi-s' });
    chat.sessionAnchors = [{ agent: 'opencode', sessionId: 'oc' }, { agent: 'pi', sessionId: 'pi-s' }];
    await gateway.undoTurn('chat', 'u3');

    await (gateway as any).applyPendingRewind(chat, repo);
    expect(vi.mocked(forkOpenCodeSession)).toHaveBeenCalledWith('oc', 1, { cwd: repo });
    expect(chat.sessionAnchors).toEqual([{ agent: 'opencode', sessionId: 'oc-fork', syncedThroughMessageId: 'u1-reply' }]);
    expect(chat.messages[0].agentSession.sessionId).toBe('oc-fork');
  });
});
