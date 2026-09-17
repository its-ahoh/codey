import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateWorker, type GenerateDeps } from './worker-generator';
import { WorkerManager } from './workers';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const valid = { name: 'helper', role: 'Help users', soul: 'Thoughtful', instructions: 'Explain clearly', codingAgent: 'codex', model: 'test-model', tools: [] };
function setup(outputs: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-generator-'));
  roots.push(root);
  const run = vi.fn(async (_agent: string, _request: { prompt: string }) => ({ success: true, output: JSON.stringify(outputs.shift()) }));
  const deps: GenerateDeps = { agentFactory: { run } as unknown as GenerateDeps['agentFactory'], workerManager: new WorkerManager(root), workersDir: root,
    activeAgent: 'codex', activeModel: { provider: 'openai', model: 'test' }, workingDir: root };
  return { deps, run, root };
}
describe('Bot definition generation', () => {
  it('accepts the supplied account-growth description unchanged even when generated instructions are a list', async () => {
    const prompt = 'I want it to keep posting different things about AI news, AI-related information, and software development, as that is part of my interest. I want the tone to be professional for personal marketing.&#x20;\n\nI also need it to help me grow my account, get more fans, get more subscribers, and give me ideas on how I should work on my account.';
    const { deps, run } = setup([{ ...valid, instructions: ['Research AI news', 'Suggest professional posts', 'Recommend account growth ideas'] }]);
    const result = await generateWorker(deps, prompt);
    expect(result.ok).toBe(true);
    expect(run.mock.calls[0][1].prompt).toContain(`User description:\n${prompt}`);
    if (result.ok) expect(typeof result.worker.instructions).toBe('string');
  });
  it('accepts instruction arrays and persists readable markdown', async () => {
    const { deps, root, run } = setup([{ ...valid, instructions: [' Read the request ', 'Explain clearly'] }]);
    const result = await generateWorker(deps, 'A helpful Bot');
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, 'helper', 'personality.md'), 'utf8')).toContain('- Read the request\n- Explain clearly');
    expect(deps.workerManager.hasWorker('helper')).toBe(true);
  });
  it('retries invalid structured fields before writing anything', async () => {
    const { deps, root, run } = setup([{ ...valid, instructions: { step: 'Read' } }, valid]);
    expect((await generateWorker(deps, 'A helpful Bot')).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(root, 'helper', 'personality.md'), 'utf8')).not.toContain('[object Object]');
  });
  it.each([
    { instructions: 4 }, { instructions: ['Read', {}] }, { instructions: [] },
    { role: {} }, { soul: ['Friendly'] }, { model: '  ' }, { tools: [4] },
  ])('returns a validation error without leaving a partial Bot for %j', async patch => {
    const bad = { ...valid, ...patch };
    const { deps, root } = setup([bad, bad]);
    const result = await generateWorker(deps, 'A helpful Bot');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('after 2 attempts');
    expect(fs.existsSync(path.join(root, 'helper'))).toBe(false);
  });
});
