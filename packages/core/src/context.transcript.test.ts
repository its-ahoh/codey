import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ContextManager,
  CONTEXT_INLINE_LIMIT,
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

  async function seed(id: string, turns: number): Promise<void> {
    await mgr.getOrCreate(id);
    for (let i = 1; i <= turns; i++) {
      if (i % 2) await mgr.addUserTurn(id, `user ${i}`);
      else await mgr.addAssistantTurn(id, `assistant ${i}`);
    }
  }

  it('inlines everything when the history is short', async () => {
    await seed('s1', CONTEXT_INLINE_LIMIT);
    const prompt = mgr.buildPrompt('s1', 'now what');
    expect(prompt).not.toContain('not inlined');
    expect(prompt).toContain('user 1');
    expect(prompt).toContain('now what');
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
    const prompt = mgr.buildPrompt('s3', 'now what');
    expect(prompt).toContain(path.join(dir, 'context-archive', 's3.jsonl'));
    expect(prompt).toContain(`Lines 1-${100 - CONTEXT_TAIL_INLINE} hold this history.`);
    expect(prompt).toContain(`sed -n '1,${100 - CONTEXT_TAIL_INLINE}p'`);
  });

  it('still inlines the recent tail in pointer mode', async () => {
    await seed('s4', 100);
    const prompt = mgr.buildPrompt('s4', 'now what');
    for (let i = 100 - CONTEXT_TAIL_INLINE + 1; i <= 100; i++) {
      expect(prompt).toContain(`${i}`);
    }
    expect(prompt).not.toContain('user 1\n');
    expect(prompt.trimEnd().endsWith('## Current Request\nnow what')).toBe(true);
  });

  it('starts the pointer after evicted turns rather than claiming line 1', async () => {
    await seed('s5', CONTEXT_RETAINED_TURNS + 50);
    const prompt = mgr.buildPrompt('s5', 'now what');
    const first = CONTEXT_RETAINED_TURNS + 50 - CONTEXT_RETAINED_TURNS + 1;
    expect(prompt).toContain(`Lines ${first}-${CONTEXT_RETAINED_TURNS + 50 - CONTEXT_TAIL_INLINE}`);
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
