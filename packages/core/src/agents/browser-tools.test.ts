import { describe, expect, it } from 'vitest';
import { addCodeyBrowserTools } from './index';
import { AgentRequest } from '../types';

const base = (): AgentRequest => ({
  prompt: 'do the thing',
  context: { workingDir: '/tmp/work' },
  browserTools: true,
} as AgentRequest);

const env = {
  CODEY_BROWSER_SOCKET: '/tmp/codey-browser.sock',
  CODEY_BROWSER_TOKEN: 'secret-token',
  CODEY_BROWSER_RUNTIME: '/Applications/Codey.app/Contents/MacOS/Codey',
  CODEY_BROWSER_CLI: '/Applications/Codey.app/browser-agent-cli.cjs',
} as NodeJS.ProcessEnv;

describe('addCodeyBrowserTools', () => {
  it('passes the bridge credentials through when the plugin is enabled', () => {
    const request = addCodeyBrowserTools({ ...base(), browserChatId: 'chat-1' }, true, env);
    expect(request.extraEnv).toEqual({
      CODEY_BROWSER_SOCKET: env.CODEY_BROWSER_SOCKET,
      CODEY_BROWSER_TOKEN: env.CODEY_BROWSER_TOKEN,
      CODEY_BROWSER_CLI: env.CODEY_BROWSER_CLI,
      CODEY_BROWSER_RUNTIME: env.CODEY_BROWSER_RUNTIME,
      CODEY_BROWSER_CHAT_ID: 'chat-1',
    });
  });

  it('keeps env the caller already set', () => {
    const request = addCodeyBrowserTools({ ...base(), extraEnv: { ANTHROPIC_API_KEY: 'k' } }, true, env);
    expect(request.extraEnv?.ANTHROPIC_API_KEY).toBe('k');
    expect(request.extraEnv?.CODEY_BROWSER_SOCKET).toBe(env.CODEY_BROWSER_SOCKET);
  });

  it('never touches the prompt', () => {
    const request = addCodeyBrowserTools(base(), true, env);
    expect(request.prompt).toBe('do the thing');
  });

  it('never attaches an MCP server', () => {
    const request = addCodeyBrowserTools(base(), true, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('does nothing when the plugin is disabled', () => {
    expect(addCodeyBrowserTools(base(), false, env).extraEnv).toBeUndefined();
  });

  it('does nothing when the bridge env is missing', () => {
    expect(addCodeyBrowserTools(base(), true, {} as NodeJS.ProcessEnv).extraEnv).toBeUndefined();
  });

  it('does nothing when only the CLI path is missing from env', () => {
    const { CODEY_BROWSER_CLI: _omitted, ...partial } = env as Record<string, string>;
    expect(addCodeyBrowserTools(base(), true, partial as NodeJS.ProcessEnv).extraEnv).toBeUndefined();
  });

  it('excludes coordination turns (browserTools not set)', () => {
    expect(addCodeyBrowserTools({ ...base(), browserTools: false }, true, env).extraEnv).toBeUndefined();
  });

  it('excludes tool-restricted turns (allowedTools set)', () => {
    expect(addCodeyBrowserTools({ ...base(), allowedTools: ['Read'] }, true, env).extraEnv).toBeUndefined();
  });

  it('excludes turns with no working directory', () => {
    expect(addCodeyBrowserTools({ ...base(), context: {} as any }, true, env).extraEnv).toBeUndefined();
  });

  it('omits chat id env when no browserChatId is present', () => {
    const request = addCodeyBrowserTools(base(), true, env);
    expect(request.extraEnv).not.toHaveProperty('CODEY_BROWSER_CHAT_ID');
  });
});
