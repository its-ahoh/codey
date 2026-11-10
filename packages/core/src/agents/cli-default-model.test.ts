import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AgentFactory } from './index';
import type { CodingAgentAdapter } from './base';
import { AgentRequest, cliDefaultModelConfig } from '../types';

describe('"default" model choice at launch', () => {
  it('reaches the agent as no model, so the CLI uses its own default', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-cli-default-'));
    let seen: AgentRequest | undefined;
    const adapter: CodingAgentAdapter = {
      name: 'codex',
      run: async (request) => { seen = request; return { success: true, output: 'ok' }; },
    };
    const factory = new AgentFactory();
    factory.register('codex', adapter);
    try {
      await factory.run('codex', { agent: 'codex', prompt: 'work', model: cliDefaultModelConfig() });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    expect(seen).toBeDefined();
    expect(seen!.model).toBeUndefined();
  });
});
