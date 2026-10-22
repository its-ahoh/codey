import type { ToolPolicy } from '../types';

/**
 * CLI-level enforcement of `AgentRequest.toolPolicy`. A prompt that says
 * "never write code" is a request the model may ignore; these flags remove
 * the capability, so a coordination call (Advisor, Judge, distiller) or a
 * read-only turn (Quick Question) cannot change the user's files even when
 * the model tries to.
 *
 * Every adapter that sees a policy also drops its permission-skip flag: a
 * bypass flag would either disable the sandbox the policy relies on (codex)
 * or approve what the policy denies (opencode).
 */

/** Read-only built-ins for claude-code. Shared with Quick Question. */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/** `--tools` replaces the available built-in set (unlike `--allowedTools`,
 *  which only pre-approves and is a no-op under skip-permissions), and
 *  `--strict-mcp-config` drops user/project MCP servers that could write. */
export function claudeToolPolicyArgs(policy: ToolPolicy): string[] {
  const tools = policy === 'none' ? '' : CLAUDE_READ_ONLY_TOOLS.join(',');
  return ['--tools', tools, '--strict-mcp-config'];
}

/** codex has no tool allow-list; its OS sandbox is the hard boundary. Shell
 *  commands still run, but cannot write anywhere. */
export function codexToolPolicyArgs(_policy: ToolPolicy): string[] {
  return ['--sandbox', 'read-only'];
}

/** pi applies the allow-list to built-in and extension tools alike. */
export function piToolPolicyArgs(policy: ToolPolicy): string[] {
  return policy === 'none' ? ['--no-tools'] : ['--tools', 'read,grep,find,ls'];
}

const OPENCODE_WRITE_PERMISSIONS = ['edit', 'bash', 'task', 'external_directory'];
const OPENCODE_READ_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'codesearch', 'lsp', 'skill'];

/** OpenCode merges `OPENCODE_PERMISSION` over every config layer, managed
 *  preferences included, so a user config cannot re-allow a denied tool. */
export function opencodeToolPolicyEnv(policy: ToolPolicy): Record<string, string> {
  const denied = policy === 'none'
    ? [...OPENCODE_WRITE_PERMISSIONS, ...OPENCODE_READ_PERMISSIONS]
    : OPENCODE_WRITE_PERMISSIONS;
  return { OPENCODE_PERMISSION: JSON.stringify(Object.fromEntries(denied.map(k => [k, 'deny']))) };
}
