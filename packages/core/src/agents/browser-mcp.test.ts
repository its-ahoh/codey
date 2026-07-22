import { describe, expect, it } from 'vitest';
import { addCodeyBrowserMcp } from './index';
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
  CODEY_BROWSER_MCP: '/Applications/Codey.app/browser-mcp-server.cjs',
} as NodeJS.ProcessEnv;

describe('addCodeyBrowserMcp', () => {
  it('attaches the codey-browser MCP server when the plugin is enabled', () => {
    const request = addCodeyBrowserMcp({ ...base(), browserChatId: 'chat-1' }, true, env);
    const server = request.mcpServers?.['codey-browser'];
    expect(server).toBeDefined();
    expect(server!.command).toBe(env.CODEY_BROWSER_RUNTIME);
    expect(server!.args).toEqual([env.CODEY_BROWSER_MCP]);
    expect(server!.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      CODEY_BROWSER_SOCKET: env.CODEY_BROWSER_SOCKET,
      CODEY_BROWSER_TOKEN: env.CODEY_BROWSER_TOKEN,
      CODEY_BROWSER_CHAT_ID: 'chat-1',
    });
  });

  it('never touches the prompt', () => {
    const request = addCodeyBrowserMcp(base(), true, env);
    expect(request.prompt).toBe('do the thing');
  });

  it('does nothing when the plugin is disabled', () => {
    const request = addCodeyBrowserMcp(base(), false, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('does nothing when the bridge env is missing', () => {
    const request = addCodeyBrowserMcp(base(), true, {} as NodeJS.ProcessEnv);
    expect(request.mcpServers).toBeUndefined();
  });

  it('excludes coordination turns (browserTools not set)', () => {
    const request = addCodeyBrowserMcp({ ...base(), browserTools: false }, true, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('excludes tool-restricted turns (allowedTools set)', () => {
    const request = addCodeyBrowserMcp({ ...base(), allowedTools: ['Read'] }, true, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('omits chat id env when no browserChatId is present', () => {
    const request = addCodeyBrowserMcp(base(), true, env);
    expect(request.mcpServers?.['codey-browser'].env).not.toHaveProperty('CODEY_BROWSER_CHAT_ID');
  });

  it('excludes turns with no working directory', () => {
    const request = addCodeyBrowserMcp({ ...base(), context: {} as any }, true, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('does nothing when only the MCP server path is missing from env', () => {
    const { CODEY_BROWSER_MCP: _omitted, ...partial } = env as Record<string, string>;
    const request = addCodeyBrowserMcp(base(), true, partial as NodeJS.ProcessEnv);
    expect(request.mcpServers).toBeUndefined();
  });
});
