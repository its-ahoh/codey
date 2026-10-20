import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SkillStore, playbookSkillDir } from '@codey/core';
import { Codey } from './gateway';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-playbook-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function setup() {
  const workingDir = repo();
  const store = new SkillStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-playbook-ledger-')));
  await store.load();
  const notices: string[] = [];
  const gateway = Object.assign(Object.create(Codey.prototype), {
    configManager: { getSkillsConfig: () => ({ enabled: true, suggestOnRepeat: 2, autoApply: true, staleDays: 30, weakSkillDays: 7, induction: true }) },
    logger: { info() {}, warn() {}, debug() {} },
    skillRunCounter: 0,
    resolveSkillStore: async () => store,
    resolveWorkspaceWorkingDir: () => workingDir,
  });
  const suggestion = { name: 'notes', description: 'Draft release notes.', whenToUse: 'Before a release.', steps: '1. List the changes.' };
  const pass = (opts: Record<string, unknown>) => gateway.afterRunSkillPass({
    trace: { runId: 'r', promptSummary: 'draft notes', outputPreview: '', timestamp: Date.now(), mode: 'solo',
      steps: [{ tool: 'Read', args: {} }], toolSequence: ['Read'] },
    appliedSkill: null, clean: true, store, workingDir,
    notify: (text: string) => { notices.push(text); }, setPending: () => {},
    ...opts,
  });
  return { gateway, store, workingDir, suggestion, pass, notices };
}

describe('saving a playbook as a skill', () => {
  it('writes playbook-<name>/SKILL.md on yes', async () => {
    const { gateway, store, workingDir, suggestion } = await setup();
    expect(await gateway.savePlaybookSkill('ws', suggestion)).toEqual({ name: 'playbook-notes' });
    expect(store.get('playbook-notes')).toBeDefined();
    expect(fs.existsSync(path.join(playbookSkillDir(workingDir, 'playbook-notes'), 'SKILL.md'))).toBe(true);
  });

  it('refuses a name the user\'s own skill already has', async () => {
    const { gateway, store, workingDir, suggestion } = await setup();
    fs.mkdirSync(path.join(workingDir, '.claude', 'skills', 'playbook-notes'), { recursive: true });
    const result = await gateway.savePlaybookSkill('ws', suggestion);
    expect(result).toMatchObject({ error: expect.stringContaining('already exists') });
    expect(store.get('playbook-notes')).toBeUndefined();
    expect(await gateway.savePlaybookSkill('ws', suggestion, 'notes-two')).toEqual({ name: 'playbook-notes-two' });
  });
});

describe('after a run', () => {
  it('counts a playbook skill the agent used, and nothing for others', async () => {
    const { gateway, store, suggestion, pass } = await setup();
    await gateway.savePlaybookSkill('ws', suggestion);
    await pass({ toolCalls: [{ type: 'tool_start', tool: 'Skill', input: { skill: 'playbook-notes' } }] });
    expect(store.get('playbook-notes')).toMatchObject({ useCount: 1, successSignals: { cleanRuns: 1, corrections: 0 } });
    await pass({ toolCalls: [{ type: 'tool_start', tool: 'Bash', input: { command: 'ls' } }] });
    expect(store.get('playbook-notes')!.useCount).toBe(1);
  });

  it('removes the SKILL.md of a playbook that cleanup archives', async () => {
    const { gateway, store, workingDir, suggestion, pass } = await setup();
    await gateway.savePlaybookSkill('ws', suggestion);
    store.get('playbook-notes')!.lastUsedAt = Date.now() - 31 * 86_400_000;
    await pass({});
    expect(store.get('playbook-notes')!.archived).toBe(true);
    expect(fs.existsSync(playbookSkillDir(workingDir, 'playbook-notes'))).toBe(false);
  });

  it('keeps rarely used playbooks when the agent cannot report uses', async () => {
    const { gateway, store, suggestion, pass } = await setup();
    await gateway.savePlaybookSkill('ws', suggestion);
    const skill = store.get('playbook-notes')!;
    skill.createdAt = skill.lastUsedAt = Date.now() - 8 * 86_400_000;
    await pass({ usageTracked: false });
    expect(store.get('playbook-notes')!.archived).toBe(false);
  });
});
