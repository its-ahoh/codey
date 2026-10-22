import { describe, it, expect } from 'vitest';
import {
  claudeToolPolicyArgs,
  codexToolPolicyArgs,
  opencodeToolPolicyEnv,
  piToolPolicyArgs,
} from './tool-policy';
import { piArgs } from './pi';

describe('tool policy flags', () => {
  it('claude: none empties the built-in set and drops ambient MCP servers', () => {
    expect(claudeToolPolicyArgs('none')).toEqual(['--tools', '', '--strict-mcp-config']);
  });

  it('claude: read-only exposes no write or shell tool', () => {
    const [, tools] = claudeToolPolicyArgs('read-only');
    const names = tools.split(',');
    expect(names).toContain('Read');
    for (const w of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']) expect(names).not.toContain(w);
  });

  it('codex: both policies use the read-only OS sandbox', () => {
    expect(codexToolPolicyArgs('none')).toEqual(['--sandbox', 'read-only']);
    expect(codexToolPolicyArgs('read-only')).toEqual(['--sandbox', 'read-only']);
  });

  it('pi: none disables every tool, read-only keeps only readers', () => {
    expect(piToolPolicyArgs('none')).toEqual(['--no-tools']);
    expect(piToolPolicyArgs('read-only')).toEqual(['--tools', 'read,grep,find,ls']);
  });

  it('opencode: write permissions are denied under both policies', () => {
    for (const policy of ['none', 'read-only'] as const) {
      const perms = JSON.parse(opencodeToolPolicyEnv(policy).OPENCODE_PERMISSION);
      for (const k of ['edit', 'bash', 'task']) expect(perms[k]).toBe('deny');
    }
    expect(JSON.parse(opencodeToolPolicyEnv('read-only').OPENCODE_PERMISSION).read).toBeUndefined();
    expect(JSON.parse(opencodeToolPolicyEnv('none').OPENCODE_PERMISSION).read).toBe('deny');
  });

  it('pi: a policy wins over skipPermissions, which would load project extensions', () => {
    const args = piArgs({ prompt: 'hi', skipPermissions: true, toolPolicy: 'none' });
    expect(args).toContain('--no-tools');
    expect(args).not.toContain('-a');
  });
});
