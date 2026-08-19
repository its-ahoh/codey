import { CodingAgent, AgentRequest, AgentResponse, McpServerSpec } from '../types';
import { CodingAgentAdapter } from './base';
import { ClaudeCodeAdapter } from './claude-code';
import { OpenCodeAdapter } from './opencode';
import { CodexAdapter } from './codex';
import { PiAdapter } from './pi';
import { syncCodeyGlobalSkills, syncCodeyManagedSkills, syncCodeyProjectSkills } from './codey-skills';
import { installBrowserSkill, removeBrowserSkill } from './browser-skill';

export type { CodingAgentAdapter } from './base';
export { ClaudeCodeAdapter } from './claude-code';
export { OpenCodeAdapter } from './opencode';
export { CodexAdapter } from './codex';
export { PiAdapter } from './pi';
export { applyModelEnv, unwiredAllProtocols } from './env';
export * from './codey-skills';
export * from './browser-skill';

/**
 * Hand the in-app browser's bridge credentials to a task-performing agent
 * turn. Requires the user-enabled Browser plugin AND a live bridge (the Mac
 * app exports CODEY_BROWSER_* on the gateway process). Advisor, housekeeping,
 * and tool-restricted turns are excluded via the same browserTools /
 * allowedTools gating the earlier MCP server used.
 *
 * The agent learns the commands from the managed `browser` skill, and reaches
 * them through its own shell tool — the one capability every coding agent has,
 * MCP or not. That makes this env the real gate: a turn without it gets a CLI
 * that refuses to run, whatever the skill list says.
 */
export function addCodeyBrowserTools(
  request: AgentRequest,
  pluginEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AgentRequest {
  const socket = env.CODEY_BROWSER_SOCKET;
  const token = env.CODEY_BROWSER_TOKEN;
  const runtime = env.CODEY_BROWSER_RUNTIME;
  const cli = env.CODEY_BROWSER_CLI;
  if (!pluginEnabled || !socket || !token || !runtime || !cli) return request;
  if (request.browserTools !== true || !request.context?.workingDir || request.allowedTools) {
    return request;
  }

  return {
    ...request,
    extraEnv: {
      ...(request.extraEnv ?? {}),
      CODEY_BROWSER_SOCKET: socket,
      CODEY_BROWSER_TOKEN: token,
      CODEY_BROWSER_CLI: cli,
      CODEY_BROWSER_RUNTIME: runtime,
      ...(request.browserChatId ? { CODEY_BROWSER_CHAT_ID: request.browserChatId } : {}),
    },
  };
}

/**
 * Merge user-configured external MCP servers into a task-performing agent
 * turn. Uses the same turn gate as the browser plugin — `browserTools` doubles
 * as the "tools-capable turn" marker, so advisor/housekeeping/tool-restricted
 * turns get nothing. Servers already on the request win name conflicts.
 */
export function addExternalMcpServers(
  request: AgentRequest,
  servers: Record<string, McpServerSpec> | undefined,
): AgentRequest {
  if (!servers) return request;
  if (request.browserTools !== true || !request.context?.workingDir || request.allowedTools) {
    return request;
  }
  if (Object.keys(servers).length === 0) return request;
  return {
    ...request,
    mcpServers: { ...servers, ...(request.mcpServers ?? {}) },
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
    this.register('pi', new PiAdapter());
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

    const browserEnabled = this.pluginEnabledProvider?.('browser') === true;
    request = addCodeyBrowserTools(request, browserEnabled);
    request = addExternalMcpServers(request, this.externalMcpProvider?.());

    // The Browser plugin's skill follows its switch: written on the way into a
    // run so an upgrade ships current instructions, removed once the plugin is
    // off so it stops appearing in every agent's skill list.
    try {
      if (browserEnabled) await installBrowserSkill();
      else await removeBrowserSkill();
    } catch {
      // Best-effort, like the linking below.
    }

    // `~/.codey/skills` and `<project>/.codey/skills` are Codey's global and
    // project sources of truth. Refresh the lightweight compatibility links
    // immediately before every CLI launch so skills added by hand are
    // available without restarting Codey.
    try {
      await syncCodeyGlobalSkills();
      await syncCodeyManagedSkills();
    } catch {
      // See below: linking is best-effort.
    }
    if (request.context?.workingDir) {
      try {
        await syncCodeyProjectSkills(request.context.workingDir);
      } catch {
        // Skill-link setup must never prevent the user's actual task from
        // running (read-only projects and restricted filesystems are valid).
      }
    }

    return adapter.run(request);
  }
}
