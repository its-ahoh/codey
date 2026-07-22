import { describe, expect, it } from 'vitest';
import { addExternalMcpServers } from './index';
import { AgentRequest, McpServerSpec } from '../types';

const base = (): AgentRequest => ({
  prompt: 'do the thing',
  context: { workingDir: '/tmp/work' },
  browserTools: true,
} as AgentRequest);

const servers: Record<string, McpServerSpec> = {
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'tok' } },
  linear: { command: '', args: [], env: {}, url: 'https://mcp.linear.app/sse' },
};

describe('addExternalMcpServers', () => {
  it('merges enabled external servers into the request', () => {
    const request = addExternalMcpServers(base(), servers);
    expect(request.mcpServers?.github).toEqual(servers.github);
    expect(request.mcpServers?.linear).toEqual(servers.linear);
  });

  it('does nothing when no servers are provided', () => {
    expect(addExternalMcpServers(base(), undefined).mcpServers).toBeUndefined();
    expect(addExternalMcpServers(base(), {}).mcpServers).toBeUndefined();
  });

  it('excludes coordination turns (browserTools not set)', () => {
    const request = addExternalMcpServers({ ...base(), browserTools: false }, servers);
    expect(request.mcpServers).toBeUndefined();
  });

  it('excludes turns with no working directory', () => {
    const request = addExternalMcpServers({ ...base(), context: {} as any }, servers);
    expect(request.mcpServers).toBeUndefined();
  });

  it('excludes tool-restricted turns (allowedTools set)', () => {
    const request = addExternalMcpServers({ ...base(), allowedTools: ['Read'] }, servers);
    expect(request.mcpServers).toBeUndefined();
  });

  it('filters the reserved codey-browser name', () => {
    const request = addExternalMcpServers(base(), {
      'codey-browser': { command: '/evil', args: [], env: {} },
    });
    expect(request.mcpServers).toBeUndefined();
  });

  it('never overwrites servers already on the request', () => {
    const browser: McpServerSpec = { command: '/app/Codey', args: ['/app/server.cjs'], env: {} };
    const withBrowser = { ...base(), mcpServers: { 'codey-browser': browser, github: browser } };
    const request = addExternalMcpServers(withBrowser, servers);
    expect(request.mcpServers?.['codey-browser']).toEqual(browser);
    expect(request.mcpServers?.github).toEqual(browser);
    expect(request.mcpServers?.linear).toEqual(servers.linear);
  });

  it('never touches the prompt', () => {
    expect(addExternalMcpServers(base(), servers).prompt).toBe('do the thing');
  });
});
