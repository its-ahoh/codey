import { AgentRequest, AgentResponse, CodingAgent } from '../types';

export interface CodingAgentAdapter {
  name: string;
  run(request: AgentRequest): Promise<AgentResponse>;
  resetSession?(): void;
}

// Base class for agent adapters
export abstract class BaseAgentAdapter implements CodingAgentAdapter {
  abstract name: string;

  abstract run(request: AgentRequest): Promise<AgentResponse>;

  protected createResponse(output: string, success: boolean = true, tokens?: AgentResponse['tokens'], duration?: number): AgentResponse {
    return {
      success,
      output,
      error: success ? undefined : output,
      tokens,
      duration,
    };
  }
}
