import { describe, expect, it } from 'vitest';
import { Codey } from './gateway';

describe('lightweight team classification', () => {
  function setup(output: string, success = true) {
    const requests: any[] = [];
    const gateway = Object.assign(Object.create(Codey.prototype), {
      workspaceManager: { getWorkerManager: () => ({ getDispatchHint: (name: string) => name }) },
      getAideOptions: (_signal: unknown, allowFallback: boolean) => {
        expect(allowFallback).toBe(false);
        return { agent: 'pi', model: { model: 'aide-model' }, runner: async (request: any) => {
          requests.push(request);
          return { success, output, error: success ? undefined : 'unavailable' };
        } };
      },
    });
    return { gateway, requests };
  }
  it('uses Aide for the existing bounded classification and returns its valid selection', async () => {
    const { gateway, requests } = setup('{"route":"single_worker","worker":"reviewer","reason":"Explanation"}');
    expect(await gateway.decideSequentialFastPath(['reviewer', 'author'], 'Explain this function', '/tmp')).toMatchObject({ route: 'single_worker', worker: 'reviewer' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ agent: 'pi', model: { model: 'aide-model' } });
  });
  it.each([['invalid', true], ['', false]])('keeps the full flow when classification is unavailable or invalid', async (output, success) => {
    const { gateway, requests } = setup(output, success);
    expect(await gateway.decideSequentialFastPath(['reviewer', 'author'], 'Fix a bug', '/tmp')).toMatchObject({ route: 'full_flow' });
    expect(requests).toHaveLength(1);
  });
  it('makes no AI call for a single-member team', async () => {
    const { gateway, requests } = setup('');
    expect(await gateway.decideSequentialFastPath(['reviewer'], 'Explain', '/tmp')).toMatchObject({ route: 'single_worker', worker: 'reviewer' });
    expect(requests).toHaveLength(0);
  });
});
