import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forkOpenCodeSession, revertCodexTurns, type ChatMessage } from '@codey/core';
import { Codey } from './gateway';
import { captureCheckpoint, chatRefPrefix, turnRef } from './turn-checkpoints';

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
  /** Message count of each batched write. */
  const writes: number[] = [];
  const chatManager = {
    get: () => chat,
    updateMessage: (_id: string, messageId: string, patch: Partial<ChatMessage>) => {
      const m = chat.messages.find((x: ChatMessage) => x.id === messageId);
      Object.assign(m, patch);
      return chat;
    },
    updateMessages: (_id: string, patches: Array<{ id: string; patch: Partial<ChatMessage> }>) => {
      writes.push(patches.length);
      for (const { id, patch } of patches) Object.assign(chat.messages.find((x: ChatMessage) => x.id === id), patch);
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
    chatRestores: new Map(),
    pendingChatTurns: new Map(),
    logger: { warn: vi.fn(), info: vi.fn() },
  }) as Codey;
  (gateway as any).resolveChatWorkingDir = () => repo;
  return { gateway, chat, writes };
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

  it('saves the chat once per undo and once per redo, however many messages', async () => {
    const { gateway, chat, writes } = fixture();
    for (let i = 1; i <= 6; i++) await turn(chat, `u${i}`, () => write(repo, 'a.txt', `v${i}\n`));
    await gateway.undoTurn('chat', 'u1');
    expect(writes).toEqual([12]);
    await gateway.redoTurn('chat', 'u1');
    expect(writes).toEqual([12, 12]);
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

  it('refuses to redo a later undo while an earlier turn is still undone', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    await turn(chat, 'u2', () => write(repo, 'b.txt', 'b\n'));
    await turn(chat, 'u3', () => write(repo, 'c.txt', 'c\n'));
    await gateway.undoTurn('chat', 'u3');
    await new Promise(r => setTimeout(r, 5)); // a distinct undo stamp
    await gateway.undoTurn('chat', 'u1');

    await expect(gateway.redoTurn('chat', 'u3')).rejects.toThrow(/earlier turn/);
    expect(read(repo, 'a.txt')).toBe('v0\n');
    expect(chat.pendingRewind).toEqual({ fromMessageId: 'u1' });

    // Earliest first: u1's undo comes back, u3 stays undone and pending.
    await gateway.redoTurn('chat', 'u1');
    expect(read(repo, 'a.txt')).toBe('v1\n');
    expect(read(repo, 'b.txt')).toBe('b\n');
    expect(fs.existsSync(path.join(repo, 'c.txt'))).toBe(false);
    expect(chat.messages.map((m: ChatMessage) => !!m.undone)).toEqual([false, false, false, false, true, true]);
    expect(chat.pendingRewind).toEqual({ fromMessageId: 'u3' });

    await gateway.redoTurn('chat', 'u3');
    expect(read(repo, 'c.txt')).toBe('c\n');
    expect(chat.messages.some((m: ChatMessage) => m.undone)).toBe(false);
    expect(chat.pendingRewind).toBeUndefined();
  });

  it('redoes past an undone turn that has no undo point of its own', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    // Its snapshot ran out of time, so the turn carries no checkpoint.
    chat.messages.push({ id: 'u2', role: 'user', content: 'do u2', timestamp: 0 });
    write(repo, 'b.txt', 'b\n');
    chat.messages.push({ id: 'u2-reply', role: 'assistant', content: 'done', timestamp: 0 });

    await gateway.undoTurn('chat', 'u1');
    expect(chat.messages.every((m: ChatMessage) => m.undone)).toBe(true);
    await gateway.redoTurn('chat', 'u1');
    expect(read(repo, 'b.txt')).toBe('b\n');
    expect(chat.messages.some((m: ChatMessage) => m.undone)).toBe(false);
  });

  it('keeps only the safety snapshots a redo can still use', async () => {
    const undoRefs = () => git(repo, 'for-each-ref', '--format=%(objectname)', `${chatRefPrefix('chat')}undo/`).split('\n').filter(Boolean);
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    for (let i = 0; i < 3; i++) {
      await gateway.undoTurn('chat', 'u1');
      expect(undoRefs()).toEqual([chat.messages[0].checkpoint.undone.safety]);
      await new Promise(r => setTimeout(r, 5));
      await gateway.redoTurn('chat', 'u1');
      expect(undoRefs()).toEqual([]);
      await new Promise(r => setTimeout(r, 5));
    }
    // A new turn after an undo makes that undo final: its snapshot goes too.
    await gateway.undoTurn('chat', 'u1');
    await turn(chat, 'u2', () => write(repo, 'c.txt', 'c\n'));
    await (gateway as any).pruneTurnCheckpoints('chat', repo);
    expect(undoRefs()).toEqual([]);
  });

  it('refuses while a turn is about to start, and makes a new turn wait for a running undo', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', 'v1\n'));
    (gateway as any).pendingChatTurns.set('chat', 1);
    await expect(gateway.undoTurn('chat', 'u1')).rejects.toThrow(/current turn/);
    (gateway as any).pendingChatTurns.clear();

    const undo = gateway.undoTurn('chat', 'u1');
    // Claimed before the first await: a turn arriving now sees it and waits.
    const claimed: Promise<void> | undefined = (gateway as any).chatRestores.get('chat');
    expect(claimed).toBeInstanceOf(Promise);
    await expect(gateway.redoTurn('chat', 'u1')).rejects.toThrow(/still running/);
    await claimed;
    expect(read(repo, 'a.txt')).toBe('v0\n');
    await undo;
    expect((gateway as any).chatRestores.has('chat')).toBe(false);
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

  it('starts fresh instead of counting when the session ran a stopped or failed turn after the kept one', async () => {
    vi.mocked(revertCodexTurns).mockClear();
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), codex);
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), codex);
    chat.messages.forEach((m: ChatMessage, i: number) => { m.timestamp = 100 + i; });
    // A stopped turn ran in the thread after u2 started; no message holds it.
    chat.sessionAnchors = [{ agent: 'codex', sessionId: 'codex-t', strayAt: 500 }];
    await gateway.undoTurn('chat', 'u2');
    await (gateway as any).applyPendingRewind(chat, repo);
    expect(vi.mocked(revertCodexTurns)).not.toHaveBeenCalled();
    expect(chat.sessionAnchors).toEqual([]);
  });

  it('still counts when the unrecorded turn came before the kept one', async () => {
    vi.mocked(revertCodexTurns).mockClear();
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), codex);
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), codex);
    chat.messages.forEach((m: ChatMessage, i: number) => { m.timestamp = 100 + i; });
    chat.sessionAnchors = [{ agent: 'codex', sessionId: 'codex-t', strayAt: 50 }];
    await gateway.undoTurn('chat', 'u2');
    await (gateway as any).applyPendingRewind(chat, repo);
    expect(vi.mocked(revertCodexTurns)).toHaveBeenCalledWith('codex-t', 1, { cwd: repo });
  });

  it('drops the session when its rewind throws, and still finishes', async () => {
    vi.mocked(revertCodexTurns).mockRejectedValueOnce(new Error('boom'));
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'), codex);
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'), codex);
    chat.sessionAnchors = [{ agent: 'codex', sessionId: 'codex-t' }];
    await gateway.undoTurn('chat', 'u2');
    await (gateway as any).applyPendingRewind(chat, repo);
    expect(chat.sessionAnchors).toEqual([]);
    expect(chat.pendingRewind).toBeUndefined();
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

describe('redo after a final undo', () => {
  it('ignores turns whose undo is final and can still redo the newest undo', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'));
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'));
    await gateway.undoTurn('chat', 'u2');
    // A new turn makes the undo of u2 final.
    await turn(chat, 'u3', () => write(repo, 'a.txt', '3\n'));
    await turn(chat, 'u4', () => write(repo, 'a.txt', '4\n'));
    await gateway.undoTurn('chat', 'u4');
    expect(read(repo, 'a.txt')).toBe('3\n');

    await gateway.redoTurn('chat', 'u4');
    expect(read(repo, 'a.txt')).toBe('4\n');
    // u2 stays undone for good.
    expect(chat.messages.find((m: ChatMessage) => m.id === 'u2').undone).toBe(true);
  });

  it('still makes an earlier undo in the same tail go first', async () => {
    const { gateway, chat } = fixture();
    await turn(chat, 'u1', () => write(repo, 'a.txt', '1\n'));
    await turn(chat, 'u2', () => write(repo, 'a.txt', '2\n'));
    await turn(chat, 'u3', () => write(repo, 'a.txt', '3\n'));
    await gateway.undoTurn('chat', 'u3');
    await gateway.undoTurn('chat', 'u2');
    await expect(gateway.redoTurn('chat', 'u3')).rejects.toThrow(/Redo that one first/);
  });
});
