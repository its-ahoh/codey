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
  try {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  } catch (error) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
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
 *
 * Note: env values (including the bridge token) land in argv, which is
 * visible to same-user processes via ps. This is deliberate: the token only
 * authenticates a same-user 0600 unix socket, so argv adds no access an
 * observer would not already have; Codex has no file-based per-spawn
 * MCP config to use instead.
 *
 * Also sets generous startup/tool timeouts per server: MCP tool calls can
 * legitimately block for minutes (e.g. the browser permission gate waits
 * for the user), well past codex's default tool timeout.
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
    args.push('-c', `${key}.startup_timeout_sec=60`);
    args.push('-c', `${key}.tool_timeout_sec=600`);
  }
  return args;
}

/**
 * OpenCode reads extra config from the file named by OPENCODE_CONFIG. The
 * fragment only declares mcp servers; opencode merges it with its own config.
 * Note: opencode exposes no per-tool MCP timeout knob in its config fragment;
 * long permission-gated calls rely on its default.
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
  try {
    fs.writeFileSync(file, JSON.stringify({ mcp }));
  } catch (error) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
  return {
    env: { OPENCODE_CONFIG: file },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}
