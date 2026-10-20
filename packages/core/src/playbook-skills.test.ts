import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SkillStore } from './skill-crystallizer';
import { linkPlaybookSkillsIntoWorktree } from './agents/codey-skills';
import {
  absorbPlaybookEdit, ensureLocalExclude, parsePlaybookSkill, playbookNameTaken, playbookSkillDir,
  playbookSkillName, playbookSkillsUsed, reconcilePlaybookSkills, removePlaybookSkill, writePlaybookSkill,
} from './playbook-skills';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' });

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function repo(): string {
  const dir = tmp('playbook-repo-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
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
  it('writes a SKILL.md every agent can discover and keeps it out of git status', async () => {
    const dir = repo();
    const store = await storeWith();
    await writePlaybookSkill(store, store.get('playbook-notes')!, dir);
    const md = fs.readFileSync(skillMd(dir), 'utf-8');
    expect(md).toContain('name: "playbook-notes"');
    expect(md).toContain('description: "Draft release notes. When a release is prepared."');
    expect(md).toContain('## Steps\n\n1. List the changes.');
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'playbook-notes', 'SKILL.md'))).toBe(true);
    expect(store.get('playbook-notes')!.skillHash).toMatch(/^[0-9a-f]{64}$/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('removes the file and the links that pointed at it', async () => {
    const dir = repo();
    const store = await storeWith();
    await writePlaybookSkill(store, store.get('playbook-notes')!, dir);
    await removePlaybookSkill(dir, 'playbook-notes');
    expect(fs.existsSync(playbookSkillDir(dir, 'playbook-notes'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'playbook-notes'))).toBe(false);
  });
});

describe('ensureLocalExclude', () => {
  it('adds the block once and never again after the user removes it', async () => {
    const dir = repo();
    const store = await storeWith();
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    await ensureLocalExclude(store, dir);
    await ensureLocalExclude(store, dir);
    const text = fs.readFileSync(exclude, 'utf-8');
    expect(text.match(/codey learned skills \(local only\)/g)).toHaveLength(1);
    expect(text).toContain('/.codey/skills/playbook-*\n');
    fs.writeFileSync(exclude, '');
    await ensureLocalExclude(store, dir);
    expect(fs.readFileSync(exclude, 'utf-8')).toBe('');
  });

  it('does nothing outside a git repository', async () => {
    const dir = tmp('playbook-plain-');
    const store = await storeWith();
    await ensureLocalExclude(store, dir);
    expect(store.hasLocalExclude(dir)).toBe(false);
  });
});

describe('absorbPlaybookEdit', () => {
  it('keeps a hand edit as the next version', async () => {
    const dir = repo();
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
  it('prefixes and writes older playbooks, leaving legacy promoted ones alone', async () => {
    const dir = repo();
    const store = await storeWith('notes');
    store.add({ name: 'deploy', description: 'd', whenToUse: 'w', steps: 's' });
    store.promoteToSkill('deploy');
    expect(await reconcilePlaybookSkills(store, dir)).toEqual(['playbook-notes']);
    expect(store.get('notes')).toBeUndefined();
    expect(fs.existsSync(skillMd(dir))).toBe(true);
    expect(store.get('deploy')).toBeDefined();
    expect(fs.existsSync(playbookSkillDir(dir, 'playbook-deploy'))).toBe(false);
    // Nothing left to do the second time.
    expect(await reconcilePlaybookSkills(store, dir)).toEqual([]);
  });

  it('does not take a name the user already uses', async () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'playbook-notes'), { recursive: true });
    expect(await playbookNameTaken(dir, 'playbook-notes')).toBe(true);
    const store = await storeWith('notes');
    expect(await reconcilePlaybookSkills(store, dir)).toEqual([]);
    expect(store.get('notes')).toBeDefined();
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

describe('linkPlaybookSkillsIntoWorktree', () => {
  it('exposes the main checkout\'s playbook skills in a linked worktree', async () => {
    const main = repo();
    const store = await storeWith();
    await writePlaybookSkill(store, store.get('playbook-notes')!, main);
    const worktree = path.join(tmp('playbook-wt-'), 'wt');
    git(main, 'worktree', 'add', '-q', worktree);

    await linkPlaybookSkillsIntoWorktree(worktree);
    expect(fs.readFileSync(skillMd(worktree), 'utf-8')).toContain('playbook-notes');
    expect(git(worktree, 'status', '--porcelain')).toBe('');

    await removePlaybookSkill(main, 'playbook-notes');
    await linkPlaybookSkillsIntoWorktree(worktree);
    expect(fs.existsSync(playbookSkillDir(worktree, 'playbook-notes'))).toBe(false);
  });

  it('does nothing in the main checkout', async () => {
    const main = repo();
    await linkPlaybookSkillsIntoWorktree(main);
    expect(fs.existsSync(path.join(main, '.codey'))).toBe(false);
  });
});
