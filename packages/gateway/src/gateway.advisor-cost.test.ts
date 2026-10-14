import { describe, expect, it, vi } from 'vitest';
import { Codey } from './gateway';

describe('Advisor call budget', () => {
  it('returns capped worker results without a separate summary request', async () => {
    const advisorRunner = vi.fn().mockResolvedValue({ success: true, output: JSON.stringify({
      done: false, next: 'writer', instruction: 'Refine the notes', summary_of_last: 'Notes refined',
    }) });
    const gateway = Object.assign(Object.create(Codey.prototype), {
      logger: { info: vi.fn() },
      workspaceManager: { getBotManager: () => ({
        getDispatchHint: (name: string) => name,
        buildTeamBotPrompt: (_name: string, prompt: string) => prompt,
      }) },
      getAdvisorAgentAndModel: () => ({ agent: 'pi' }), advisorRunner,
      getDefaultAgent: () => 'codex', getDefaultModelConfig: () => undefined,
    });
    const runBot = vi.fn().mockResolvedValue({ success: true, output: 'Draft revised' });
    const result = await gateway.runAdvisorLoop({ members: ['writer'] }, 'Prepare notes',
      undefined, undefined, undefined, () => {}, runBot);
    expect(runBot).toHaveBeenCalledTimes(4);
    expect(advisorRunner).toHaveBeenCalledTimes(4);
    expect(result.parts).toHaveLength(4);
    expect(result.finalSummary).toBe('');
  });
});

describe('automatic first-turn Aide integration', () => {
  function harness(aideOutput = '{"next":"writer","reason":"Explains concepts"}') {
    const aide = vi.fn().mockResolvedValue({ success: true, output: aideOutput });
    const advisor = vi.fn().mockResolvedValue({ success: true, output: '{"done":true,"final_summary":"Finished"}' });
    const gateway = Object.assign(Object.create(Codey.prototype), {
      logger: { info: vi.fn() },
      workspaceManager: { getBotManager: () => ({ getDispatchHint: (name: string) => name,
        buildTeamBotPrompt: (_name: string, prompt: string) => prompt }) },
      getAdvisorAgentAndModel: () => ({ agent: 'pi' }), advisorRunner: advisor,
      getDefaultAgent: () => 'codex', getDefaultModelConfig: () => undefined,
      isAideConfigured: () => true, getAideOptions: () => ({ agent: 'codex', runner: aide }),
    });
    return { gateway, aide, advisor };
  }
  it('uses Aide once to start, then Advisor to assess completion', async () => {
    const { gateway, aide, advisor } = harness();
    const runBot = vi.fn().mockResolvedValue({ success: true, output: 'Explanation complete.' });
    const result = await gateway.runAdvisorLoop({ members: ['writer', 'reviewer'] }, 'Explain closures.',
      undefined, undefined, undefined, () => {}, runBot);
    expect(aide).toHaveBeenCalledTimes(1);
    expect(advisor).toHaveBeenCalledTimes(1);
    expect(runBot).toHaveBeenCalledTimes(1);
    expect(result.parts[0].bot).toBe('writer');
    expect(result.finalSummary).toBe('Finished');
  });
  it('sends complex tasks directly to Advisor', async () => {
    const { gateway, aide, advisor } = harness();
    await gateway.runAdvisorLoop({ members: ['writer', 'reviewer'] }, 'Implement a cache and review it.',
      undefined, undefined, undefined, () => {}, vi.fn());
    expect(aide).not.toHaveBeenCalled();
    expect(advisor).toHaveBeenCalledTimes(1);
  });
  it('uses Advisor when Aide is not configured', async () => {
    const { gateway, aide, advisor } = harness();
    gateway.isAideConfigured = () => false;
    await gateway.runAdvisorLoop({ members: ['writer', 'reviewer'] }, 'Explain closures.',
      undefined, undefined, undefined, () => {}, vi.fn());
    expect(aide).not.toHaveBeenCalled();
    expect(advisor).toHaveBeenCalledTimes(1);
  });
  it('falls back once on uncertain Aide routing', async () => {
    const { gateway, aide, advisor } = harness('{"route":"advisor"}');
    await gateway.runAdvisorLoop({ members: ['writer', 'reviewer'] }, 'Explain closures.',
      undefined, undefined, undefined, () => {}, vi.fn());
    expect(aide).toHaveBeenCalledTimes(1);
    expect(advisor).toHaveBeenCalledTimes(1);
  });
  it('does not call Advisor if cancelled while Aide is running', async () => {
    const { gateway, aide, advisor } = harness();
    const abort = new AbortController();
    aide.mockImplementation(async () => { abort.abort(); return { success: false, output: '' }; });
    await gateway.runAdvisorLoop({ members: ['writer', 'reviewer'] }, 'Explain closures.',
      abort.signal, undefined, undefined, () => {}, vi.fn());
    expect(advisor).not.toHaveBeenCalled();
  });
});
