import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SkillStore } from './skill-crystallizer';
import { PLAYBOOK_INDEX_MAX, playbooksRead, preparePlaybookIndex, withPlaybookIndex } from './playbook-index';
import type { ToolCallEntry } from './types';

function storeWith(names: string[]): SkillStore {
  const store = new SkillStore(fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-index-')));
  for (const name of names) {
    store.add({ name, description: `${name} description`, whenToUse: `${name} when`, steps: `1. ${name} step` });
  }
  return store;
}

describe('preparePlaybookIndex', () => {
  it('writes a readable file for each unpromoted, unarchived playbook', async () => {
    const store = storeWith(['notes', 'deploy', 'old']);
    store.promoteToSkill('deploy');
    store.archive('old');
    const offered = await preparePlaybookIndex(store);
    expect(offered.map(o => o.skill.name)).toEqual(['notes']);
    const body = fs.readFileSync(offered[0].file, 'utf-8');
    expect(body).toContain('notes description');
    expect(body).toContain('1. notes step');
  });

  it('lists the most recently used first and caps the list', async () => {
    const names = Array.from({ length: PLAYBOOK_INDEX_MAX + 2 }, (_, i) => `pb-${i}`);
    const store = storeWith(names);
    store.recordUse('pb-3');
    store.get('pb-3')!.lastUsedAt = Date.now() + 1000;
    const offered = await preparePlaybookIndex(store);
    expect(offered).toHaveLength(PLAYBOOK_INDEX_MAX);
    expect(offered[0].skill.name).toBe('pb-3');
  });
});

describe('withPlaybookIndex', () => {
  it('lists name, description and file, and leaves the task intact', async () => {
    const offered = await preparePlaybookIndex(storeWith(['notes']));
    const prompt = withPlaybookIndex('Prepare the weekly update', offered);
    expect(prompt).toContain(`- notes: notes description → ${offered[0].file}`);
    expect(prompt).toContain('Otherwise ignore this list');
    expect(prompt.endsWith('Prepare the weekly update')).toBe(true);
    // The full steps stay in the file, not the prompt.
    expect(prompt).not.toContain('1. notes step');
  });

  it('returns the task unchanged when nothing is offered', () => {
    expect(withPlaybookIndex('task', [])).toBe('task');
  });
});

describe('playbooksRead', () => {
  it('detects a playbook file opened by a read or shell tool call', async () => {
    const offered = await preparePlaybookIndex(storeWith(['notes', 'deploy']));
    const [notes, deploy] = offered;
    const calls: ToolCallEntry[] = [
      { id: '1', type: 'tool_start', tool: 'Read', message: 'Read', input: { file_path: notes.file } },
      { id: '2', type: 'tool_end', tool: 'Bash', message: 'done', input: { command: `cat ${deploy.file}` } },
      { id: '3', type: 'tool_start', tool: 'Bash', message: 'Bash', input: { command: 'ls' } },
    ];
    expect(playbooksRead(calls, offered).map(s => s.name)).toEqual(['notes']);
    calls.push({ id: '4', type: 'tool_start', tool: 'Bash', message: 'Bash', input: { command: `cat ${deploy.file}` } });
    expect(playbooksRead(calls, offered).map(s => s.name)).toEqual(['notes', 'deploy']);
  });

  it('finds nothing without tool events', async () => {
    const offered = await preparePlaybookIndex(storeWith(['notes']));
    expect(playbooksRead(undefined, offered)).toEqual([]);
  });
});
