import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import { writeClaudeMcpConfig, codexMcpArgs, writeOpenCodeMcpConfig } from './mcp-config';
import { McpServerSpec } from '../types';

const servers: Record<string, McpServerSpec> = {
  'codey-browser': {
    command: '/app/Codey',
    args: ['/app/browser-mcp-server.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', CODEY_BROWSER_TOKEN: 'tok' },
  },
};

const remote: McpServerSpec = { command: '', args: [], env: {}, url: 'https://mcp.linear.app/sse' };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('writeClaudeMcpConfig', () => {
  it('writes a claude --mcp-config file', () => {
    const { args, cleanup } = writeClaudeMcpConfig(servers);
    cleanups.push(cleanup);
    expect(args[0]).toBe('--mcp-config');
    const parsed = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
    expect(parsed.mcpServers['codey-browser']).toEqual(servers['codey-browser']);
  });

  it('cleanup removes the temp file', () => {
    const { args, cleanup } = writeClaudeMcpConfig(servers);
    cleanup();
    expect(fs.existsSync(args[1])).toBe(false);
  });

  it('serializes remote servers as http url entries', () => {
    const { args, cleanup } = writeClaudeMcpConfig({ linear: remote });
    cleanups.push(cleanup);
    const parsed = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
    expect(parsed.mcpServers.linear).toEqual({ type: 'http', url: remote.url });
  });
});

describe('codexMcpArgs', () => {
  it('emits -c overrides with TOML-safe values', () => {
    const args = codexMcpArgs(servers);
    expect(args).toEqual([
      '-c', 'mcp_servers."codey-browser".command="/app/Codey"',
      '-c', 'mcp_servers."codey-browser".args=["/app/browser-mcp-server.cjs"]',
      '-c', 'mcp_servers."codey-browser".env={ELECTRON_RUN_AS_NODE="1",CODEY_BROWSER_TOKEN="tok"}',
      '-c', 'mcp_servers."codey-browser".startup_timeout_sec=60',
      '-c', 'mcp_servers."codey-browser".tool_timeout_sec=600',
    ]);
  });

  it('emits an empty inline table for servers with no env', () => {
    const args = codexMcpArgs({ bare: { command: '/bin/x', args: [], env: {} } });
    expect(args).toContain('mcp_servers."bare".env={}');
    expect(args).toContain('mcp_servers."bare".args=[]');
    expect(args).toContain('mcp_servers."bare".tool_timeout_sec=600');
  });

  it('skips remote servers (codex has no remote MCP config)', () => {
    const args = codexMcpArgs({ linear: remote, ...servers });
    expect(args.join(' ')).not.toContain('linear');
    expect(args.join(' ')).toContain('codey-browser');
  });
});

describe('writeOpenCodeMcpConfig', () => {
  it('writes an OPENCODE_CONFIG json with local mcp servers', () => {
    const { env, cleanup } = writeOpenCodeMcpConfig(servers);
    cleanups.push(cleanup);
    const parsed = JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf-8'));
    expect(parsed.mcp['codey-browser']).toEqual({
      type: 'local',
      command: ['/app/Codey', '/app/browser-mcp-server.cjs'],
      enabled: true,
      environment: servers['codey-browser'].env,
    });
  });

  it('serializes remote servers as remote url entries', () => {
    const { env, cleanup } = writeOpenCodeMcpConfig({ linear: remote });
    cleanups.push(cleanup);
    const parsed = JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf-8'));
    expect(parsed.mcp.linear).toEqual({ type: 'remote', url: remote.url, enabled: true });
  });
});
