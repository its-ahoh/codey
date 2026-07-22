import { CodingAgent, AgentRequest, AgentResponse, McpServerSpec } from '../types';
import { CodingAgentAdapter } from './base';
import { ClaudeCodeAdapter } from './claude-code';
import { OpenCodeAdapter } from './opencode';
import { CodexAdapter } from './codex';

export type { CodingAgentAdapter } from './base';
export { ClaudeCodeAdapter } from './claude-code';
export { OpenCodeAdapter } from './opencode';
export { CodexAdapter } from './codex';
export { applyModelEnv } from './env';

/**
 * Attach the in-app browser MCP server to a task-performing agent turn.
 * Requires the user-enabled Browser plugin AND a live bridge (the Mac app
 * exports CODEY_BROWSER_* on the gateway process). Advisor, housekeeping,
 * and tool-restricted turns are excluded via the same browserTools /
 * allowedTools gating the old prompt injection used.
 */
export function addCodeyBrowserMcp(
  request: AgentRequest,
  pluginEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AgentRequest {
  const socket = env.CODEY_BROWSER_SOCKET;
  const token = env.CODEY_BROWSER_TOKEN;
  const runtime = env.CODEY_BROWSER_RUNTIME;
  const server = env.CODEY_BROWSER_MCP;
  if (!pluginEnabled || !socket || !token || !runtime || !server) return request;
  if (request.browserTools !== true || !request.context?.workingDir || request.allowedTools) {
    return request;
  }

  const spec: McpServerSpec = {
    command: runtime,
    args: [server],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CODEY_BROWSER_SOCKET: socket,
      CODEY_BROWSER_TOKEN: token,
      ...(request.browserChatId ? { CODEY_BROWSER_CHAT_ID: request.browserChatId } : {}),
    },
  };
  return {
    ...request,
    mcpServers: { ...(request.mcpServers ?? {}), 'codey-browser': spec },
  };
}

/**
 * Merge user-configured external MCP servers into a task-performing agent
 * turn. Uses the same turn gate as the browser plugin — `browserTools` doubles
 * as the "tools-capable turn" marker, so advisor/housekeeping/tool-restricted
 * turns get nothing. The reserved `codey-browser` name is filtered, and
 * servers already on the request always win name conflicts.
 */
export function addExternalMcpServers(
  request: AgentRequest,
  servers: Record<string, McpServerSpec> | undefined,
): AgentRequest {
  if (!servers) return request;
  if (request.browserTools !== true || !request.context?.workingDir || request.allowedTools) {
    return request;
  }
  const entries = Object.entries(servers).filter(([name]) => name !== 'codey-browser');
  if (entries.length === 0) return request;
  return {
    ...request,
    mcpServers: { ...Object.fromEntries(entries), ...(request.mcpServers ?? {}) },
  };
}

// Agent factory
export class AgentFactory {
  private agents: Map<CodingAgent, CodingAgentAdapter> = new Map();
  private envProvider?: (agent: CodingAgent) => Record<string, string> | undefined;
  private pluginEnabledProvider?: (plugin: string) => boolean;
  private externalMcpProvider?: () => Record<string, McpServerSpec> | undefined;

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

  /**
   * Inject a callback that answers "is this plugin enabled?" from the live
   * config, so toggles in the renderer take effect on the next request.
   */
  setPluginEnabledProvider(provider: (plugin: string) => boolean): void {
    this.pluginEnabledProvider = provider;
  }

  /**
   * Inject a callback that returns the user's enabled external MCP servers
   * from the live config, so edits in the renderer apply on the next request.
   */
  setExternalMcpProvider(provider: () => Record<string, McpServerSpec> | undefined): void {
    this.externalMcpProvider = provider;
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

    request = addCodeyBrowserMcp(request, this.pluginEnabledProvider?.('browser') === true);
    request = addExternalMcpServers(request, this.externalMcpProvider?.());

    return adapter.run(request);
  }
}
