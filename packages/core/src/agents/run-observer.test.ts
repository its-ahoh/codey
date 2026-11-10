import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentFactory } from './index';
import type { AgentRequest, AgentResponse } from '../types';

const stub = (response: AgentResponse) => ({ name: 'stub', run: async () => response }) as any;

describe('AgentFactory run observer', () => {
  // run() refreshes skill links under the home dir; keep that off the real one.
  let home: string;
  const prev = { HOME: process.env.HOME, CODEY_HOME: process.env.CODEY_HOME };
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-observer-'));
    process.env.HOME = home;
    process.env.CODEY_HOME = path.join(home, '.codey');
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sees every run with its request and response', async () => {
    const factory = new AgentFactory();
    const response: AgentResponse = { success: true, output: 'hi', tokens: { total: 3, input: 2, output: 1 } };
    factory.register('codex', stub(response));
    const seen: Array<[string, AgentRequest, AgentResponse]> = [];
    factory.setRunObserver((agent, req, res) => seen.push([agent, req, res]));
    const out = await factory.run('codex', { prompt: 'p', agent: 'codex', extraEnv: {} });
    expect(out).toBe(response);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('codex');
    expect(seen[0][1].prompt).toBe('p');
  });

  it('never lets an observer error fail the run', async () => {
    const factory = new AgentFactory();
    factory.register('codex', stub({ success: true, output: 'ok' }));
    factory.setRunObserver(() => { throw new Error('disk full'); });
    await expect(factory.run('codex', { prompt: 'p', agent: 'codex', extraEnv: {} })).resolves.toMatchObject({ output: 'ok' });
  });
});
