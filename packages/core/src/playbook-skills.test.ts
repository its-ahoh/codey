import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SkillStore } from './skill-crystallizer';
import { WorkspaceManager } from './workspace';
import { BotManager } from './bots';
import {
  absorbPlaybookEdit, parsePlaybookSkill, playbookNameTaken, playbookSkillDir, playbookSkillName,
  playbookSkillsUsed, reconcilePlaybookSkills, removePlaybookSkill, writePlaybookSkill,
} from './playbook-skills';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function storeWith(name = 'playbook-notes'): Promise<SkillStore> {
  const store = new SkillStore(tmp('playbook-ledger-'));
  await store.load();
  store.add({ name, description: 'Draft release notes.', whenToUse: 'When a release is prepared.', steps: '1. List the changes.' });
  return store;
}

const skillMd = (dir: string, name = 'playbook-notes') => path.join(playbookSkillDir(dir, name), 'SKILL.md');

describe('playbookSkillName', () => {
  it('adds the prefix exactly once', () => {
    expect(playbookSkillName('notes')).toBe('playbook-notes');
    expect(playbookSkillName('playbook-notes')).toBe('playbook-notes');
  });
});

describe('writePlaybookSkill', () => {
  it('writes a SKILL.md under home and links it for every agent', async () => {
    const home = tmp('playbook-home-');
    const store = await storeWith();
    await writePlaybookSkill(store, store.get('playbook-notes')!, home);
    const md = fs.readFileSync(path.join(home, '.codey', 'skills', 'playbook-notes', 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: "playbook-notes"');
    expect(md).toContain('description: "Draft release notes. When a release is prepared."');
    expect(md).toContain('## Steps\n\n1. List the changes.');
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'playbook-notes', 'SKILL.md'))).toBe(true);
    expect(store.get('playbook-notes')!.skillHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('removes the file and the links that pointed at it', async () => {
    const home = tmp('playbook-home-');
    const store = await storeWith();
    await writePlaybookSkill(store, store.get('playbook-notes')!, home);
    await removePlaybookSkill(home, 'playbook-notes');
    expect(fs.existsSync(playbookSkillDir(home, 'playbook-notes'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'playbook-notes'))).toBe(false);
  });
});

describe('absorbPlaybookEdit', () => {
  it('keeps a hand edit as the next version', async () => {
    const dir = tmp('playbook-home-');
    const store = await storeWith();
    await writePlaybookSkill(store, store.get('playbook-notes')!, dir);
    expect(await absorbPlaybookEdit(store, 'playbook-notes', dir)).toBe(false);

    const edited = fs.readFileSync(skillMd(dir), 'utf-8')
      .replace('1. List the changes.', '1. List the changes.\n2. Group them by area.')
      .replace('## When to use\n\nWhen a release is prepared.', '## When to use\n\nBefore every release.');
    fs.writeFileSync(skillMd(dir), edited);

    expect(await absorbPlaybookEdit(store, 'playbook-notes', dir)).toBe(true);
    const skill = store.get('playbook-notes')!;
    expect(skill.version).toBe(2);
    expect(skill.steps).toBe('1. List the changes.\n2. Group them by area.');
    expect(skill.whenToUse).toBe('Before every release.');
    expect(skill.editedByUser).toBe(true);
    expect(skill.history.at(-1)!.steps).toBe('1. List the changes.');
    expect(await absorbPlaybookEdit(store, 'playbook-notes', dir)).toBe(false);
  });

  it('reads the description back without the appended when-to-use text', () => {
    const parsed = parsePlaybookSkill('---\nname: "p"\ndescription: "Does a thing. Use it daily."\n---\n\n## When to use\n\nUse it daily.\n\n## Steps\n\n1. a\n');
    expect(parsed).toEqual({ description: 'Does a thing.', whenToUse: 'Use it daily.', steps: '1. a' });
  });
});

describe('reconcilePlaybookSkills', () => {
  it('writes again an active playbook whose file went missing', async () => {
    const home = tmp('playbook-home-');
    const store = await storeWith();
    expect(await reconcilePlaybookSkills(store, home)).toEqual(['playbook-notes']);
    expect(fs.existsSync(skillMd(home))).toBe(true);
    // Nothing left to do the second time.
    expect(await reconcilePlaybookSkills(store, home)).toEqual([]);
  });
});

describe('playbookNameTaken', () => {
  it('sees a skill of that name the user already has', async () => {
    const dir = tmp('playbook-project-');
    expect(await playbookNameTaken(dir, 'playbook-notes')).toBe(false);
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'playbook-notes'), { recursive: true });
    expect(await playbookNameTaken(dir, 'playbook-notes')).toBe(true);
  });
});

describe('playbookSkillsUsed', () => {
  it('sees a Skill tool call or a read of the SKILL.md, by whole name', async () => {
    const store = await storeWith();
    store.add({ name: 'playbook-notes-long', description: 'd', whenToUse: 'w', steps: 's' });
    const skills = store.getActive();
    const names = (calls: { type?: string; input?: unknown }[]) => playbookSkillsUsed(calls, skills).map(s => s.name);
    expect(names([{ type: 'tool_start', input: { skill: 'playbook-notes' } }])).toEqual(['playbook-notes']);
    expect(names([{ input: { file_path: '/p/.claude/skills/playbook-notes-long/SKILL.md' } }])).toEqual(['playbook-notes-long']);
    expect(names([{ type: 'tool_end', input: { skill: 'playbook-notes' } }])).toEqual([]);
    expect(names([])).toEqual([]);
  });
});

describe('WorkspaceManager global ledger', () => {
  it('lives under CODEY_HOME, outside the skills directory agents scan', async () => {
    const before = process.env.CODEY_HOME;
    process.env.CODEY_HOME = tmp('playbook-codey-home-');
    try {
      const manager = new WorkspaceManager(new BotManager(), tmp('playbook-workspaces-'));
      const store = await manager.getGlobalSkillStore();
      expect(await manager.getGlobalSkillStore()).toBe(store);
      store.add({ name: 'playbook-x', description: 'd', whenToUse: 'w', steps: 's' });
      await store.flush();
      expect(fs.existsSync(path.join(process.env.CODEY_HOME, 'skills-ledger', 'skills', 'index.json'))).toBe(true);
    } finally {
      process.env.CODEY_HOME = before;
    }
  });
});
