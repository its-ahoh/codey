import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './config';

describe('external MCP server config', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-mcp-cfg-'));
    file = path.join(dir, 'gateway.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to no external servers', () => {
    const mgr = new ConfigManager(file);
    expect(mgr.getEnabledExternalMcpServers()).toEqual({});
  });

  it('set + persist + reload round-trip', () => {
    const mgr = new ConfigManager(file);
    mgr.setExternalMcpServer('github', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'tok' },
      enabled: true,
    });
    const reloaded = new ConfigManager(file);
    expect(reloaded.getEnabledExternalMcpServers()).toEqual({
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'tok' } },
    });
  });

  it('maps remote entries to url specs', () => {
    const mgr = new ConfigManager(file);
    mgr.setExternalMcpServer('linear', {
      transport: 'remote',
      url: 'https://mcp.linear.app/sse',
      enabled: true,
    });
    expect(mgr.getEnabledExternalMcpServers()).toEqual({
      linear: { command: '', args: [], env: {}, url: 'https://mcp.linear.app/sse' },
    });
  });

  it('excludes disabled servers and invalid entries', () => {
    const mgr = new ConfigManager(file);
    mgr.setExternalMcpServer('off', { transport: 'stdio', command: '/bin/x', enabled: false });
    mgr.setExternalMcpServer('nocmd', { transport: 'stdio', command: '', enabled: true });
    mgr.setExternalMcpServer('nourl', { transport: 'remote', url: '', enabled: true });
    expect(mgr.getEnabledExternalMcpServers()).toEqual({});
  });

  it('never returns the reserved codey-browser name', () => {
    const mgr = new ConfigManager(file);
    mgr.setExternalMcpServer('codey-browser', { transport: 'stdio', command: '/evil', enabled: true });
    expect(mgr.getEnabledExternalMcpServers()).toEqual({});
  });

  it('removeExternalMcpServer deletes and persists', () => {
    const mgr = new ConfigManager(file);
    mgr.setExternalMcpServer('github', { transport: 'stdio', command: 'npx', enabled: true });
    mgr.removeExternalMcpServer('github');
    expect(mgr.getEnabledExternalMcpServers()).toEqual({});
    const reloaded = new ConfigManager(file);
    expect(reloaded.get().mcpServers?.github).toBeUndefined();
  });

  it('coerces non-boolean enabled and bad shapes on load', () => {
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: {
        a: { transport: 'stdio', command: '/bin/a', enabled: 'yes' },
        b: { transport: 'weird', command: '/bin/b', enabled: true },
      },
    }));
    const mgr = new ConfigManager(file);
    expect(mgr.getEnabledExternalMcpServers()).toEqual({});
    expect(mgr.get().mcpServers?.a?.enabled).toBe(false);
  });
});
