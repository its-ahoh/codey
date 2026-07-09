import { CodingAgent, AgentRequest, AgentResponse } from '../types';
import { CodingAgentAdapter } from './base';
import { ClaudeCodeAdapter } from './claude-code';
import { OpenCodeAdapter } from './opencode';
import { CodexAdapter } from './codex';

export type { CodingAgentAdapter } from './base';
export { ClaudeCodeAdapter } from './claude-code';
export { OpenCodeAdapter } from './opencode';
export { CodexAdapter } from './codex';
export { applyModelEnv } from './env';

// Agent factory
export class AgentFactory {
  private agents: Map<CodingAgent, CodingAgentAdapter> = new Map();
  private envProvider?: (agent: CodingAgent) => Record<string, string> | undefined;

  constructor() {
    this.register('claude-code', new ClaudeCodeAdapter());
    this.register('opencode', new OpenCodeAdapter());
    this.register('codex', new CodexAdapter());
  }

  register(agent: CodingAgent, adapter: CodingAgentAdapter): void {
    this.agents.set(agent, adapter);
  }

  get(agent: CodingAgent): CodingAgentAdapter | undefined {
    return this.agents.get(agent);
  }

  /**
   * Inject a callback that returns per-agent extra env vars from the live
   * config. Pulled once per `run()` so edits in the renderer take effect on
   * the next request without restarting the gateway.
   */
  setAgentEnvProvider(provider: (agent: CodingAgent) => Record<string, string> | undefined): void {
    this.envProvider = provider;
  }

  resetSessions(): void {
    for (const adapter of this.agents.values()) {
      adapter.resetSession?.();
    }
  }

  dispose(): void {
    for (const adapter of this.agents.values()) {
      adapter.dispose?.();
    }
  }

  async run(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    const adapter = this.agents.get(agent);
    if (!adapter) {
      return {
        success: false,
        output: '',
        error: `Unknown agent: ${agent}`,
      };
    }

    // Only auto-populate when the caller hasn't already provided extraEnv
    // (e.g. tests can stub it). Merge so the caller's keys win over config.
    if (this.envProvider && !request.extraEnv) {
      const fromCfg = this.envProvider(agent);
      if (fromCfg && Object.keys(fromCfg).length > 0) {
        request = { ...request, extraEnv: fromCfg };
      }
    }

    return adapter.run(request);
  }
}