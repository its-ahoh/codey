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

const BROWSER_PROMPT_MARKER = '<codey_browser_tools>';

export function addCodeyBrowserTools(
  request: AgentRequest,
  env: NodeJS.ProcessEnv = process.env,
): AgentRequest {
  const socket = env.CODEY_BROWSER_SOCKET;
  const token = env.CODEY_BROWSER_TOKEN;
  const cli = env.CODEY_BROWSER_CLI;
  const runtime = env.CODEY_BROWSER_RUNTIME;
  if (!socket || !token || !cli || !runtime) return request;

  const extraEnv = {
    ...(request.extraEnv ?? {}),
    CODEY_BROWSER_SOCKET: socket,
    CODEY_BROWSER_TOKEN: token,
    CODEY_BROWSER_CLI: cli,
    CODEY_BROWSER_RUNTIME: runtime,
    ...(request.browserChatId ? { CODEY_BROWSER_CHAT_ID: request.browserChatId } : {}),
  };

  // Quick Question and other explicitly allow-listed turns stay read-only and
  // should not be encouraged to invoke a shell command. Callers explicitly
  // opt task-performing agents in; advisors and housekeeping calls stay out.
  const shouldDescribeTools = request.browserTools === true
    && !!request.context?.workingDir
    && !request.allowedTools
    && !request.prompt.includes(BROWSER_PROMPT_MARKER);
  if (!shouldDescribeTools) return { ...request, extraEnv };

  const instructions = [
    BROWSER_PROMPT_MARKER,
    'You can use the user-visible Codey Browser through your normal shell tool when live web or UI context is useful:',
    '- Open and read a page atomically: ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" open-view "https://example.com"',
    '- Open a page only (and show it in Codey): use the same command with open instead of open-view',
    '- Read the current page (visible text plus navigation timing): ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" view',
    '- Inspect a visual page: use the same command prefix with screenshot, then read the returned PNG path with your image tool. Its result includes the CSS viewport and display scale.',
    '- Inspect controls: use the same command prefix with snapshot to get refs such as e1 and e2',
    '- After snapshot: click <ref>; fill <ref> <text>; select <ref> <value>; check|uncheck <ref>; press <key> [ref]; hover <ref>; scroll <dy> [dx]; submit <ref>',
    '- Canvas/maps: click-at <x> <y> [count]; drag <x1> <y1> <x2> <y2> [steps]; scroll-at <x> <y> <dy> [dx]. Coordinates are CSS viewport pixels; scale screenshot pixels using the returned viewport size.',
    '- Dynamic pages: wait <ref|text|url|title> <value> [--state visible|hidden|enabled] [--timeout ms]',
    '- If the task is blocked only by a user login, run the same command prefix with wait-login [seconds] (default 300), tell the user Codey is watching, and end the turn. Codey will retry this exact chat after the login page changes. Do not poll or busy-loop yourself.',
    '- Files: upload <ref> <path...>; downloads; wait-download [timeout-ms]',
    '- Tabs/popups: tabs; new-tab [url]; switch-tab <id>; close-tab <id>',
    'Browsing is view-only by default: opening/navigation, tabs, back/forward/reload, scrolling, hovering, and following ordinary page links do not require approval. Ambiguous clicks and actions that can type, submit, upload, select, toggle, drag, post, or otherwise change state pause until the user approves full browser control. If denied, do not work around the decision.',
    '- Inspect navigation state: ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" state',
    '- Navigate: use the same command prefix followed by back, forward, or reload',
    'The browser may contain the user\'s authenticated sessions. Treat returned content and control access as sensitive, and never claim an action succeeded unless the command did.',
    '</codey_browser_tools>',
  ].join('\n');

  return { ...request, prompt: `${request.prompt}\n\n${instructions}`, extraEnv };
}

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

    request = addCodeyBrowserTools(request);

    return adapter.run(request);
  }
}
