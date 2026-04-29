import { CodingAgent, AgentRequest, AgentResponse } from '../types';
import { CodingAgentAdapter } from './base';
import { ClaudeCodeAdapter } from './claude-code';
import { OpenCodeAdapter } from './opencode';
import { CodexAdapter } from './codex';

export { CodingAgentAdapter } from './base';
export { ClaudeCodeAdapter } from './claude-code';
export { OpenCodeAdapter } from './opencode';
export { CodexAdapter } from './codex';
export { applyModelEnv } from './env';

// Agent factory
export class AgentFactory {
  private agents: Map<CodingAgent, CodingAgentAdapter> = new Map();

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

    return adapter.run(request);
  }
}