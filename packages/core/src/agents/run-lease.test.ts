import { describe, it, expect, vi } from 'vitest';
vi.mock('./codey-skills', () => ({ syncCodeyGlobalSkills: vi.fn(), syncCodeyProjectSkills: vi.fn() }));
vi.mock('./browser-skill', () => ({ isBrowserSkillActive: () => false }));
vi.mock('./chrome-companion-skill', () => ({ isChromeCompanionSkillActive: () => false }));
import { AgentFactory } from './index';
import type { AgentRequest } from '../types';
const request: AgentRequest = { agent: 'codex', prompt: 'Inspect a sample document' };

describe('desktop capability leases', () => {
  it('passes leased tools and signal to the adapter, then releases on success', async () => {
    const factory = new AgentFactory();
    const run = vi.fn(async () => ({ success: true, output: 'done' }));
    factory.register('codex', { name: 'codex', run });
    const dispose = vi.fn(async () => {});
    const signal = new AbortController().signal;
    const leased = { ...request, signal, mcpServers: { computer: { command: '/fixture', args: [], env: {} } } };
    factory.setRunLeaseProvider(async () => ({ request: leased, dispose }));
    await expect(factory.run('codex', request)).resolves.toMatchObject({ success: true });
    expect(run).toHaveBeenCalledWith(leased);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('releases the desktop after an adapter exception', async () => {
    const factory = new AgentFactory();
    factory.register('codex', { name: 'codex', run: async () => { throw new Error('fixture failure'); } });
    const dispose = vi.fn(async () => {});
    factory.setRunLeaseProvider(async () => ({ request, dispose }));
    await expect(factory.run('codex', request)).resolves.toMatchObject({ success: false, error: 'fixture failure' });
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('preserves a completed agent response when desktop teardown fails', async () => {
    const factory = new AgentFactory();
    factory.register('codex', { name: 'codex', run: async () => ({ success: true, output: 'finished' }) });
    factory.setRunLeaseProvider(async () => ({
      request,
      dispose: async () => { throw new Error('fixture teardown failure'); },
    }));
    await expect(factory.run('codex', request)).resolves.toEqual({ success: true, output: 'finished' });
  });
  it('never starts an agent when authorization is denied', async () => {
    const factory = new AgentFactory();
    const run = vi.fn(async () => ({ success: true, output: '' }));
    factory.register('codex', { name: 'codex', run });
    factory.setRunLeaseProvider(async () => { throw new Error('Access declined'); });
    await expect(factory.run('codex', request)).resolves.toMatchObject({ success: false, error: 'Access declined' });
    expect(run).not.toHaveBeenCalled();
  });
});
