import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEY_SKILL_DISCOVERY_SUBDIRS,
  CODEY_SKILLS_SUBDIR,
  syncCodeyProjectSkills,
} from './codey-skills';
import { AgentFactory } from './index';
import type { CodingAgentAdapter } from './base';

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-shared-skills-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codey project skills', () => {
  it('links one source skill into every agent discovery convention', async () => {
    const root = project();
    const skill = path.join(root, CODEY_SKILLS_SUBDIR, 'release');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: release\n---\n');

    const result = await syncCodeyProjectSkills(root);

    expect(result.linked).toHaveLength(CODEY_SKILL_DISCOVERY_SUBDIRS.length);
    for (const subdir of CODEY_SKILL_DISCOVERY_SUBDIRS) {
      const linked = path.join(root, subdir, 'release');
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linked)).toBe(fs.realpathSync(skill));
      expect(fs.readFileSync(path.join(linked, 'SKILL.md'), 'utf-8')).toContain('name: release');
    }
  });

  it('is idempotent', async () => {
    const root = project();
    fs.mkdirSync(path.join(root, CODEY_SKILLS_SUBDIR, 'one'), { recursive: true });

    await syncCodeyProjectSkills(root);
    const second = await syncCodeyProjectSkills(root);

    expect(second.linked).toEqual([]);
    expect(second.existing).toHaveLength(CODEY_SKILL_DISCOVERY_SUBDIRS.length);
    expect(second.conflicts).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('does not overwrite an agent-native skill with the same name', async () => {
    const root = project();
    fs.mkdirSync(path.join(root, CODEY_SKILLS_SUBDIR, 'one'), { recursive: true });
    const native = path.join(root, CODEY_SKILL_DISCOVERY_SUBDIRS[0], 'one');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'SKILL.md'), 'native');

    const result = await syncCodeyProjectSkills(root);

    expect(result.conflicts).toEqual([native]);
    expect(fs.lstatSync(native).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(native, 'SKILL.md'), 'utf-8')).toBe('native');
  });

  it('cleans up its broken links after a Codey skill is removed', async () => {
    const root = project();
    const skill = path.join(root, CODEY_SKILLS_SUBDIR, 'one');
    fs.mkdirSync(skill, { recursive: true });
    await syncCodeyProjectSkills(root);
    fs.rmSync(skill, { recursive: true });

    const result = await syncCodeyProjectSkills(root);

    expect(result.removed).toHaveLength(CODEY_SKILL_DISCOVERY_SUBDIRS.length);
    for (const subdir of CODEY_SKILL_DISCOVERY_SUBDIRS) {
      expect(() => fs.lstatSync(path.join(root, subdir, 'one'))).toThrow();
    }
  });

  it('does nothing when the project has no Codey skills directory', async () => {
    const root = project();
    const result = await syncCodeyProjectSkills(root);
    expect(result.linked).toEqual([]);
    for (const subdir of CODEY_SKILL_DISCOVERY_SUBDIRS) {
      expect(fs.existsSync(path.join(root, subdir))).toBe(false);
    }
  });

  it('is synchronized by AgentFactory before the coding agent starts', async () => {
    const root = project();
    fs.mkdirSync(path.join(root, CODEY_SKILLS_SUBDIR, 'one'), { recursive: true });
    const expected = path.join(root, CODEY_SKILL_DISCOVERY_SUBDIRS[0], 'one');
    let visibleAtRun = false;
    const adapter: CodingAgentAdapter = {
      name: 'codex',
      run: async () => {
        visibleAtRun = fs.existsSync(expected);
        return { success: true, output: 'ok' };
      },
    };
    const factory = new AgentFactory();
    factory.register('codex', adapter);

    await factory.run('codex', {
      agent: 'codex',
      prompt: 'work',
      context: { workingDir: root },
    });

    expect(visibleAtRun).toBe(true);
  });
});
