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
