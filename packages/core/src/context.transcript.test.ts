import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ContextManager,
  CONTEXT_INLINE_MAX_BYTES,
  CONTEXT_TAIL_INLINE,
  CONTEXT_RETAINED_TURNS,
} from './context';

describe('ContextManager transcript sidecar', () => {
  let dir: string;
  let mgr: ContextManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctx-'));
    mgr = new ContextManager({ ttlMs: 60_000, persistDir: dir });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function file(id: string): string {
    return path.join(dir, 'context-archive', `${id}.jsonl`);
  }

  function rows(id: string): any[] {
    return fs.readFileSync(file(id), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  async function seed(id: string, turns: number): Promise<void> {
    await mgr.getOrCreate(id);
    for (let i = 1; i <= turns; i++) {
      if (i % 2) await mgr.addUserTurn(id, `user ${i}`);
      else await mgr.addAssistantTurn(id, `assistant ${i}`);
    }
  }

  it('writes one line per turn, in order', async () => {
    await seed('c1', 4);
    const out = rows('c1');
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ role: 'user', text: 'user 1' });
    expect(out[3]).toMatchObject({ role: 'assistant', text: 'assistant 4' });
  });

  it('records tool and file metadata without their payloads', async () => {
    await mgr.getOrCreate('c2');
    await mgr.addUserTurn('c2', 'go');
    await mgr.addAssistantTurn('c2', 'done', {
      agent: 'codex',
      toolCalls: [{ tool: 'Read', status: 'success', output: 'x'.repeat(5000) }],
      filesChanged: [{ path: 'a.ts', action: 'edit' }],
    });
    const line = rows('c2')[1];
    expect(line).toMatchObject({ agent: 'codex', tools: ['Read'], files: ['edit:a.ts'] });
    expect(JSON.stringify(line).length).toBeLessThan(300);
  });

  it('keeps line N aligned with the Nth turn even after eviction', async () => {
    await seed('c3', CONTEXT_RETAINED_TURNS + 30);
    const win = mgr.getWindow('c3')!;
    expect(win.turns.length).toBe(CONTEXT_RETAINED_TURNS);
    expect(win.transcriptLines).toBe(CONTEXT_RETAINED_TURNS + 30);
    const out = rows('c3');
    expect(out).toHaveLength(CONTEXT_RETAINED_TURNS + 30);
    expect(out[0].text).toBe('user 1');
    // The evicted head is still on disk, which is what makes eviction lossless.
    expect(win.turns[0].text).not.toBe('user 1');
  });

  it('truncates the sidecar when an expired conversation restarts', async () => {
    const shortLived = new ContextManager({ ttlMs: 1, persistDir: dir });
    await shortLived.getOrCreate('c5');
    await shortLived.addUserTurn('c5', 'old turn');
    await new Promise(r => setTimeout(r, 5));
    // Expiry archives the old window and starts a fresh one under the same id;
    // stale lines would make line N stop meaning turn N.
    await shortLived.getOrCreate('c5');
    await shortLived.addUserTurn('c5', 'new turn');
    const out = rows('c5');
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('new turn');
    expect(shortLived.getWindow('c5')!.transcriptLines).toBe(1);
  });

  it('survives an archive and reload with its cursor intact', async () => {
    await seed('c4', 30);
    mgr.shutdown();
    const revived = new ContextManager({ ttlMs: 60_000, persistDir: dir });
    expect(revived.load()).toBe(1);
    expect(revived.getWindow('c4')!.transcriptLines).toBe(30);
  });
});

describe('ContextManager.buildPrompt', () => {
  let dir: string;
  let mgr: ContextManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctx-'));
    mgr = new ContextManager({ ttlMs: 60_000, persistDir: dir });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Turns of a realistic size: 100 of these clear the byte budget, which is
   *  what pushes the prompt into pointer mode. */
  async function seed(id: string, turns: number): Promise<void> {
    await mgr.getOrCreate(id);
    for (let i = 1; i <= turns; i++) {
      const body = `turn-${i} ${'.'.repeat(400)}`;
      if (i % 2) await mgr.addUserTurn(id, body);
      else await mgr.addAssistantTurn(id, body);
    }
  }

  it('inlines everything while the replay stays under the byte budget', async () => {
    await seed('s1', 40);
    const prompt = mgr.buildPrompt('s1', 'now what');
    expect(prompt).not.toContain('not inlined');
    expect(prompt).toContain('turn-1 ');
    expect(prompt).toContain('now what');
  });

  it('switches to a pointer on bytes, not on turn count', async () => {
    await mgr.getOrCreate('s1b');
    // Six turns, but well past the byte budget: turn count would have inlined
    // these, and inlining them is exactly what the budget exists to prevent.
    for (let i = 0; i < 6; i++) {
      await mgr.addUserTurn('s1b', 'z'.repeat(CONTEXT_INLINE_MAX_BYTES / 4));
    }
    const win = mgr.getWindow('s1b')!;
    expect(win.turns.length).toBeLessThan(20);
    const prompt = mgr.buildPrompt('s1b', 'now what');
    expect(prompt).toContain('not inlined');
    expect(prompt).toContain('Lines 1-2 hold this history.');
  });

  it('keeps inlining many small turns that a turn cap would have cut off', async () => {
    await mgr.getOrCreate('s1c');
    for (let i = 1; i <= 60; i++) await mgr.addUserTurn('s1c', `tiny ${i}`);
    const prompt = mgr.buildPrompt('s1c', 'now what');
    expect(prompt).not.toContain('not inlined');
    expect(prompt).toContain('tiny 1');
    expect(prompt).toContain('tiny 60');
  });

  it('inlines everything when no persist dir is configured', async () => {
    const memOnly = new ContextManager({ ttlMs: 60_000 });
    await memOnly.getOrCreate('s2');
    for (let i = 1; i <= 100; i++) await memOnly.addUserTurn('s2', `user ${i}`);
    const prompt = memOnly.buildPrompt('s2', 'now what');
    expect(prompt).not.toContain('not inlined');
    expect(prompt).toContain('user 1');
  });

  it('points at the transcript once the history is long', async () => {
    await seed('s3', 100);
    // 100 turns of real text clears the byte budget.
    const prompt = mgr.buildPrompt('s3', 'now what');
    expect(prompt).toContain(path.join(dir, 'context-archive', 's3.jsonl'));
    expect(prompt).toContain(`Lines 1-${100 - CONTEXT_TAIL_INLINE} hold this history.`);
    expect(prompt).toContain(`sed -n '1,${100 - CONTEXT_TAIL_INLINE}p'`);
  });

  it('still inlines the recent tail in pointer mode', async () => {
    await seed('s4', 100);
    const prompt = mgr.buildPrompt('s4', 'now what');
    for (let i = 100 - CONTEXT_TAIL_INLINE + 1; i <= 100; i++) {
      expect(prompt).toContain(`turn-${i} `);
    }
    expect(prompt).not.toContain('turn-1 ');
    expect(prompt).not.toContain(`turn-${100 - CONTEXT_TAIL_INLINE} `);
    expect(prompt.trimEnd().endsWith('## Current Request\nnow what')).toBe(true);
  });

  it('reaches back past evicted turns, not just what memory retained', async () => {
    const total = CONTEXT_RETAINED_TURNS + 50;
    await seed('s5', total);
    // Only CONTEXT_RETAINED_TURNS are still in RAM, but every turn is on disk,
    // so the cursor must still offer line 1.
    expect(mgr.getWindow('s5')!.turns.length).toBe(CONTEXT_RETAINED_TURNS);
    const prompt = mgr.buildPrompt('s5', 'now what');
    expect(prompt).toContain(`Lines 1-${total - CONTEXT_TAIL_INLINE} hold this history.`);
  });

  it('shrinks the prompt substantially versus inlining', async () => {
    await mgr.getOrCreate('s6');
    for (let i = 1; i <= 100; i++) await mgr.addUserTurn('s6', 'y'.repeat(2000));
    const pointed = mgr.buildPrompt('s6', 'now what');
    expect(pointed.length).toBeLessThan(100 * 2000 / 5);
  });

  it('keeps workspace memory at the top', async () => {
    await seed('s7', 100);
    const prompt = mgr.buildPrompt('s7', 'now what', '## Memory\nremember this');
    expect(prompt.startsWith('## Memory\nremember this')).toBe(true);
  });
});
