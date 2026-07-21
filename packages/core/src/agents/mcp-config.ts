import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerSpec } from '../types';

/**
 * Write a Claude Code MCP config file and return the CLI args referencing it.
 * The temp dir is per-spawn; callers invoke cleanup() after the CLI exits.
 */
export function writeClaudeMcpConfig(
  servers: Record<string, McpServerSpec>,
): { args: string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-mcp-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return {
    args: ['--mcp-config', file],
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}

/**
 * Codex takes MCP servers as `-c` TOML overrides. JSON string/array encoding
 * is valid TOML for these value shapes; server names are quoted because they
 * may contain dashes.
 */
export function codexMcpArgs(servers: Record<string, McpServerSpec>): string[] {
  const args: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const key = `mcp_servers."${name}"`;
    args.push('-c', `${key}.command=${JSON.stringify(spec.command)}`);
    args.push('-c', `${key}.args=${JSON.stringify(spec.args)}`);
    const envBody = Object.entries(spec.env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(',');
    args.push('-c', `${key}.env={${envBody}}`);
  }
  return args;
}

/**
 * OpenCode reads extra config from the file named by OPENCODE_CONFIG. The
 * fragment only declares mcp servers; opencode merges it with its own config.
 */
export function writeOpenCodeMcpConfig(
  servers: Record<string, McpServerSpec>,
): { env: Record<string, string>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-mcp-'));
  const file = path.join(dir, 'opencode.json');
  const mcp: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mcp[name] = {
      type: 'local',
      command: [spec.command, ...spec.args],
      enabled: true,
      environment: spec.env,
    };
  }
  fs.writeFileSync(file, JSON.stringify({ mcp }));
  return {
    env: { OPENCODE_CONFIG: file },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}
