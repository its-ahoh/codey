import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listPlaybooks, playbookDetail, playbookHistory,
  archivePlaybook, deletePlaybook, restorePlaybook, rollbackPlaybook, promotePlaybook, crossAgentSkillDirs,
} from './playbooks';

describe('playbooks IPC module', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-playbooks-test-'));
    store = new SkillStore(tmp);
    await store.load();
    store.add({ name: 'rel', description: 'Release notes', whenToUse: 'w', steps: 's1' });
    store.bumpVersion('rel', 's2', { runId: 'r1', promptSummary: 'draft notes' });
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** The single-workspace view most assertions here care about. */
  const listed = () => listPlaybooks([{ workspace: 'alpha', store }]);

  it('lists summaries with canRollback derived from the rollback stack', () => {
    const list = listed();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      workspace: 'alpha', name: 'rel', version: 2, archived: false, canRollback: true,
    });
    store.rollback('rel');
    expect(listed()[0]).toMatchObject({ version: 1, canRollback: false });
  });

  it('aggregates across workspaces, tagging each entry with its own', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-playbooks-test-b-'));
    const other = new SkillStore(otherDir);
    await other.load();
    // Same NAME as the alpha playbook: names are unique only within a workspace,
    // so both must survive aggregation as distinct entries.
    other.add({ name: 'rel', description: 'Other release notes', whenToUse: 'w', steps: 's1' });
    other.add({ name: 'deploy', description: 'Deploy', whenToUse: 'w', steps: 's1' });

    const list = listPlaybooks([{ workspace: 'alpha', store }, { workspace: 'beta', store: other }]);
    expect(list.map(p => `${p.workspace}/${p.name}`)).toEqual(['alpha/rel', 'beta/rel', 'beta/deploy']);
    expect(list[0].description).toBe('Release notes');
    expect(list[1].description).toBe('Other release notes');

    await other.flush();
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('lists nothing when no workspace has playbooks', () => {
    expect(listPlaybooks([])).toEqual([]);
  });

  it('returns the evolution trail for a skill', () => {
    const ev = playbookHistory(store, 'rel');
    expect(ev.length).toBe(2);
    expect(ev[0].kind).toBe('created');
    expect(ev[1]).toMatchObject({ kind: 'evolved', toVersion: 2 });
  });

  it('returns the complete current playbook version', () => {
    expect(playbookDetail(store, 'rel')).toEqual({
      name: 'rel',
      description: 'Release notes',
      whenToUse: 'w',
      steps: 's2',
      version: 2,
    });
  });

  it('detail throws for an unknown skill', () => {
    expect(() => playbookDetail(store, 'nope')).toThrow(/not found/i);
  });

  it('history throws for unknown skill', () => {
    expect(() => playbookHistory(store, 'nope')).toThrow(/not found/i);
  });

  it('archive archives, restore unarchives', () => {
    archivePlaybook(store, 'rel');
    expect(listed()[0].archived).toBe(true);
    restorePlaybook(store, 'rel');
    expect(listed()[0].archived).toBe(false);
  });

  it('archive/restore throw for unknown skill', () => {
    expect(() => archivePlaybook(store, 'nope')).toThrow(/not found/i);
    expect(() => restorePlaybook(store, 'nope')).toThrow(/not found/i);
  });

  it('delete permanently removes a playbook', () => {
    deletePlaybook(store, 'rel');
    expect(listed()).toEqual([]);
    expect(() => deletePlaybook(store, 'rel')).toThrow(/not found/i);
  });

  it('rollback restores the prior version and returns it', () => {
    expect(rollbackPlaybook(store, 'rel')).toBe(1);
    expect(listed()[0].version).toBe(1);
  });

  it('rollback throws when there is no prior version', () => {
    store.rollback('rel');
    expect(() => rollbackPlaybook(store, 'rel')).toThrow(/no prior version/i);
  });

  // Promotion targets every skill convention the agents read, so one click
  // yields a coding skill all of them discover.
  const agentRoots = (base: string) => [
    path.join(base, '.agents', 'skills'),
    path.join(base, '.claude', 'skills'),
  ];

  it('promotes a playbook to a durable SKILL.md and pins it', async () => {
    const roots = agentRoots(tmp);
    const result = await promotePlaybook(store, 'rel', roots);
    expect(result.dirs.length).toBe(2);
    for (const dir of result.dirs) {
      const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      expect(md).toContain('name: "rel"');
      expect(md).toContain('description: "Release notes"');
      expect(md).toContain('## When to use\n\nw');
      expect(md).toContain('## Procedure\n\ns2');
    }
    // Every requested convention got its own copy, none skipped.
    expect(result.dirs).toEqual(roots.map(r => path.join(r, 'rel')));
    expect(listed()[0].promotedToSkill).toBe(true);
    expect(store.archive('rel')).toBe(false);
  });

  it('does not overwrite an existing skill during promotion', async () => {
    const roots = agentRoots(tmp);
    fs.mkdirSync(path.join(roots[0], 'rel'), { recursive: true });
    fs.writeFileSync(path.join(roots[0], 'rel', 'SKILL.md'), 'existing');
    await expect(promotePlaybook(store, 'rel', roots)).rejects.toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(roots[0], 'rel', 'SKILL.md'), 'utf-8')).toBe('existing');
    expect(listed()[0].promotedToSkill).toBe(false);
  });

  it('rolls back every copy when a later convention collides', async () => {
    const roots = agentRoots(tmp);
    // First root is clear, second is taken — the write must not leave a skill
    // behind in the first, or some agents would see a half-promoted playbook.
    fs.mkdirSync(path.join(roots[1], 'rel'), { recursive: true });
    fs.writeFileSync(path.join(roots[1], 'rel', 'SKILL.md'), 'existing');
    await expect(promotePlaybook(store, 'rel', roots)).rejects.toThrow(/already exists/i);
    expect(fs.existsSync(path.join(roots[0], 'rel'))).toBe(false);
    expect(fs.readFileSync(path.join(roots[1], 'rel', 'SKILL.md'), 'utf-8')).toBe('existing');
    expect(listed()[0].promotedToSkill).toBe(false);
  });

  it('refuses to promote with no target directories', async () => {
    await expect(promotePlaybook(store, 'rel', [])).rejects.toThrow(/no skill directory/i);
    expect(listed()[0].promotedToSkill).toBe(false);
  });

  describe('crossAgentSkillDirs', () => {
    // Mirrors main.ts's skillPaths. Kept here so the covering-set rule is
    // pinned against the real conventions, not a toy table.
    const REAL = {
      'claude-code': { projectSubdirs: ['.claude/skills'] },
      'codex': { projectSubdirs: ['.codex/skills', '.agents/skills'] },
      'opencode': { projectSubdirs: ['.opencode/skills', '.agents/skills'] },
      'pi': { projectSubdirs: ['.pi/skills', '.agents/skills'] },
    };

    it('covers every agent with the fewest directories', () => {
      // codex/opencode/pi all read .agents/skills, so they collapse to one;
      // claude-code does not, so it needs its own.
      expect(crossAgentSkillDirs(REAL)).toEqual(['.claude/skills', '.agents/skills']);
    });

    it('gives every agent a directory it actually reads', () => {
      const dirs = crossAgentSkillDirs(REAL);
      for (const [agent, paths] of Object.entries(REAL)) {
        expect(
          paths.projectSubdirs.some(sub => dirs.includes(sub)),
          `${agent} cannot discover the promoted skill`,
        ).toBe(true);
      }
    });

    it('falls back to the agent-specific dir when there is no shared one', () => {
      expect(crossAgentSkillDirs({ solo: { projectSubdirs: ['.solo/skills'] } }))
        .toEqual(['.solo/skills']);
      expect(crossAgentSkillDirs({ none: { projectSubdirs: [] } })).toEqual([]);
    });

    it('promotes into every computed directory for a real project tree', async () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-project-'));
      const roots = crossAgentSkillDirs(REAL).map(rel => path.join(projectDir, rel));
      const result = await promotePlaybook(store, 'rel', roots);
      expect(result.dirs.length).toBe(2);
      // Every agent's convention resolves to a readable SKILL.md on disk.
      for (const paths of Object.values(REAL)) {
        const found = paths.projectSubdirs
          .map(sub => path.join(projectDir, sub, 'rel', 'SKILL.md'))
          .filter(p => fs.existsSync(p));
        expect(found.length).toBeGreaterThan(0);
        expect(fs.readFileSync(found[0], 'utf-8')).toContain('name: "rel"');
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
    });
  });
});
