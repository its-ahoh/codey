// packages/gateway/src/automations/parked.test.ts
import { describe, it, expect } from 'vitest';
import { detectParked } from './parked';
import { formatRunSummary } from './report';
import type { Chat, Automation, AutomationRun } from '@codey/core';

const teamTarget: Automation['target'] = { kind: 'team', teamName: 't', workspaceName: 'w' };
const promptTarget: Automation['target'] = { kind: 'prompt', workspaceName: 'w' };

describe('detectParked', () => {
  it('reports a paused team via chat.pendingTeam', () => {
    const chat = { pendingTeam: { question: 'Deploy now?', options: ['yes', 'no'] } } as unknown as Chat;
    expect(detectParked(chat, teamTarget, 'irrelevant'))
      .toEqual({ question: 'Deploy now?', options: ['yes', 'no'] });
  });
  it('reports an [ASK_USER] marker in a prompt-target response', () => {
    const parked = detectParked(undefined, promptTarget, 'work...\n[ASK_USER]: Which repo?');
    expect(parked?.question).toBe('Which repo?');
  });
  it('ignores [ASK_USER] markers for team targets (pendingTeam is authoritative)', () => {
    expect(detectParked({ } as Chat, teamTarget, '[ASK_USER]: q?')).toBeNull();
  });
  it('returns null when nothing is pending', () => {
    expect(detectParked({} as Chat, promptTarget, 'all done')).toBeNull();
  });
  it('propagates options from an [ASK_USER:choice] marker in a prompt-target response', () => {
    const parked = detectParked(undefined, promptTarget, 'thinking...\n[ASK_USER:choice]: Which env? | staging | prod');
    expect(parked).toEqual({ question: 'Which env?', options: ['staging', 'prod'] });
  });
});

describe('formatRunSummary', () => {
  const auto = { name: 'Morning news' } as Automation;
  it('summarizes success with a body preview', () => {
    const s = formatRunSummary(auto, { status: 'success', output: 'Posted 5 items.' } as AutomationRun);
    expect(s).toContain('Morning news');
    expect(s).toContain('✅');
    expect(s).toContain('Posted 5 items.');
  });
  it('summarizes parked runs with the question', () => {
    const s = formatRunSummary(auto, { status: 'parked', question: 'Which account?' } as AutomationRun);
    expect(s).toContain('⏸');
    expect(s).toContain('Which account?');
  });
  it('summarizes failure with the error', () => {
    const s = formatRunSummary(auto, { status: 'failed', error: 'boom' } as AutomationRun);
    expect(s).toContain('❌');
    expect(s).toContain('boom');
  });
  it('summarizes resumed runs with a success head', () => {
    const s = formatRunSummary(auto, { status: 'resumed', output: 'done after answer' } as AutomationRun);
    expect(s).toContain('✅');
    expect(s).toContain('resumed');
    expect(s).toContain('done after answer');
  });
  it('returns head only (no trailing newlines) when the body is empty', () => {
    const s = formatRunSummary(auto, { status: 'success', output: '   ' } as AutomationRun);
    expect(s).toBe('✅ Automation "Morning news" succeeded');
  });
  it('truncates long output with an ellipsis without splitting a surrogate pair', () => {
    // Place an astral emoji so its high surrogate sits exactly at the cut
    // index (399): 398 'x' chars, then '😀' spans indices 398-399.
    const output = 'x'.repeat(398) + '😀' + 'y'.repeat(50);
    const s = formatRunSummary(auto, { status: 'success', output } as AutomationRun);
    expect(s.endsWith('…')).toBe(true);
    // The char right before the ellipsis must not be a lone high surrogate.
    expect(/[\uD800-\uDBFF]$/.test(s.slice(0, -1))).toBe(false);
    expect(s).not.toContain('�');
  });
});
