import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { Codey, failedTurnText, folderMissingResponse } from './gateway';

function gatewayWith(fallbackEnabled: boolean) {
  const runAgentWithNetworkRetry = vi.fn(async () => ({ success: true, output: 'ok' }));
  const gateway = Object.assign(Object.create(Codey.prototype), {
    getDefaultEffort: () => undefined,
    runAgentWithNetworkRetry,
    configManager: { getFallback: () => ({ enabled: fallbackEnabled, order: [{ agent: 'codex' }] }) },
    resolveFallbackModel: () => ({ model: 'auto' }),
    agentFactory: { checkAuth: vi.fn(async () => 'unknown') },
    logger: { error: () => {}, warn: () => {}, info: () => {} },
  }) as Codey;
  return { gateway, runAgentWithNetworkRetry };
}

const run = (gateway: Codey, workingDir: string) =>
  (gateway as any).runWithFallback('claude-code', { prompt: 'hi', agent: 'claude-code', context: { workingDir } });

describe('folderMissingResponse', () => {
  it('is nothing for an existing folder or no folder', () => {
    expect(folderMissingResponse(os.tmpdir())).toBeUndefined();
    expect(folderMissingResponse(undefined)).toBeUndefined();
  });

  it('names the missing folder instead of a spawn ENOENT', () => {
    const dir = path.join(os.tmpdir(), `codey-gone-${Date.now()}`);
    const res = folderMissingResponse(dir)!;
    expect(res.success).toBe(false);
    expect(res.folderMissing).toEqual({ workingDir: dir });
    expect(failedTurnText(res, '')).toContain(`Project folder not found: ${dir}`);
    expect(failedTurnText(res, '')).not.toContain('Fallbacks also failed');
  });
});

describe('runWithFallback with a missing working folder', () => {
  it('starts no agent and no fallback', async () => {
    const { gateway, runAgentWithNetworkRetry } = gatewayWith(true);
    const dir = path.join(os.tmpdir(), `codey-gone-${Date.now()}`);
    const res = await run(gateway, dir);
    expect(runAgentWithNetworkRetry).not.toHaveBeenCalled();
    expect(res.folderMissing).toEqual({ workingDir: dir });
    expect(res.fallbackFailures).toBeUndefined();
  });

  it('runs normally when the folder exists', async () => {
    const { gateway, runAgentWithNetworkRetry } = gatewayWith(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-here-'));
    const res = await run(gateway, dir);
    expect(runAgentWithNetworkRetry).toHaveBeenCalledOnce();
    expect(res.success).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
