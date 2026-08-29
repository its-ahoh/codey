import { CodingAgent, AgentRequest, AgentResponse, McpServerSpec } from '../types';
import { CodingAgentAdapter } from './base';
import { ClaudeCodeAdapter } from './claude-code';
import { OpenCodeAdapter } from './opencode';
import { CodexAdapter } from './codex';
import { PiAdapter } from './pi';
import { syncCodeyGlobalSkills, syncCodeyProjectSkills } from './codey-skills';
import { isBrowserSkillActive } from './browser-skill';
import { isChromeCompanionSkillActive } from './chrome-companion-skill';

export type { CodingAgentAdapter } from './base';
export { ClaudeCodeAdapter } from './claude-code';
export { OpenCodeAdapter } from './opencode';
export { CodexAdapter } from './codex';
export { PiAdapter } from './pi';
export { applyModelEnv, unwiredAllProtocols } from './env';
export * from './codey-skills';
export * from './browser-skill';
export * from './chrome-companion-skill';

/**
 * Hand the shared local browser bridge credentials to a task-performing agent
 * turn. Requires the installed and enabled `browser` and/or `chrome-companion`
 * skill plus a live bridge (the Mac app exports CODEY_BROWSER_*). Separate env
 * flags tell the CLI which command family this turn may use. Advisor,
 * housekeeping, and tool-restricted turns are excluded via the same
 * browserTools / allowedTools gating the earlier MCP server used.
 *
 * Each skill teaches only its own commands. Both reach the shared CLI through
 * the agent's shell tool, while the command-family flags remain the real gate.
 */
export function addCodeyBrowserTools(
  request: AgentRequest,
  skillActive: boolean,
  env: NodeJS.ProcessEnv = process.env,
  chromeCompanionActive = false,
): AgentRequest {
  const socket = env.CODEY_BROWSER_SOCKET;
  const token = env.CODEY_BROWSER_TOKEN;
  const chromeToken = env.CODEY_CHROME_COMPANION_TOKEN;
  const runtime = env.CODEY_BROWSER_RUNTIME;
  const cli = env.CODEY_BROWSER_CLI;
  // A turn typed in Chrome's Side Panel has an unambiguous browser target.
  // Do not hand that turn the embedded Browser token as a competing option.
  const browserReady = request.browserSurface !== 'chrome-companion' && skillActive && !!token;
  const chromeReady = chromeCompanionActive && !!chromeToken;
  if ((!browserReady && !chromeReady) || !socket || !runtime || !cli) return request;
  if (request.browserTools !== true || !request.context?.workingDir || request.allowedTools) {
    return request;
  }

  return {
    ...request,
    extraEnv: {
      ...(request.extraEnv ?? {}),
      CODEY_BROWSER_SOCKET: socket,
      ...(browserReady ? { CODEY_BROWSER_TOKEN: token } : {}),
      ...(chromeReady ? { CODEY_CHROME_COMPANION_TOKEN: chromeToken } : {}),
      CODEY_BROWSER_CLI: cli,
      CODEY_BROWSER_RUNTIME: runtime,
      ...(browserReady ? { CODEY_BROWSER_PLUGIN_ENABLED: '1' } : {}),
      ...(chromeReady ? { CODEY_CHROME_COMPANION_PLUGIN_ENABLED: '1' } : {}),
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

    // Read the skill's state from disk on every run: installing from the
    // Plugins tab, disabling from the Skills tab and deleting the directory by
    // hand are the same fact, and the agent must see whichever the user did
    // last without a restart.
    let browserActive = false;
    let chromeCompanionActive = false;
    try {
      browserActive = isBrowserSkillActive();
      chromeCompanionActive = isChromeCompanionSkillActive();
    } catch {
      // Unreadable home: no skill, so no capability.
    }
    request = addCodeyBrowserTools(request, browserActive, process.env, chromeCompanionActive);
    request = addExternalMcpServers(request, this.externalMcpProvider?.());

    // `~/.codey/skills` and `<project>/.codey/skills` are Codey's global and
    // project sources of truth. Refresh the lightweight compatibility links
    // immediately before every CLI launch so skills added by hand are
    // available without restarting Codey.
    try {
      await syncCodeyGlobalSkills();
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
