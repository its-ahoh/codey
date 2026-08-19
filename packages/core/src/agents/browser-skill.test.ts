import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BROWSER_SKILL_MARKDOWN, installBrowserSkill, removeBrowserSkill } from './browser-skill';
import { syncCodeyManagedSkills } from './codey-skills';

let home: string;

const skillFile = () => path.join(home, '.codey', 'managed-skills', 'browser', 'SKILL.md');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-browser-skill-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the managed browser skill', () => {
  it('writes SKILL.md under the managed root', async () => {
    const file = await installBrowserSkill(home);
    expect(file).toBe(skillFile());
    expect(fs.readFileSync(file, 'utf8')).toBe(BROWSER_SKILL_MARKDOWN);
  });

  it('names itself "browser" in frontmatter so agents can address it', () => {
    expect(BROWSER_SKILL_MARKDOWN).toMatch(/^---\nname: browser\ndescription: .+/);
  });

  it('overwrites an outdated copy, so an upgrade ships current instructions', async () => {
    await installBrowserSkill(home);
    fs.writeFileSync(skillFile(), '---\nname: browser\ndescription: stale\n---\n', 'utf8');
    await installBrowserSkill(home);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(BROWSER_SKILL_MARKDOWN);
  });

  it('is idempotent', async () => {
    await installBrowserSkill(home);
    const first = fs.statSync(skillFile()).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 10));
    await installBrowserSkill(home);
    expect(fs.statSync(skillFile()).mtimeMs).toBe(first);
  });

  it('removes the skill when the plugin is turned off', async () => {
    await installBrowserSkill(home);
    await removeBrowserSkill(home);
    expect(fs.existsSync(path.dirname(skillFile()))).toBe(false);
  });

  it('removing an absent skill is not an error', async () => {
    await expect(removeBrowserSkill(home)).resolves.toBe(true);
  });

  it('reaches every agent through both discovery directories', async () => {
    await installBrowserSkill(home);
    await syncCodeyManagedSkills(home);
    for (const dir of ['.claude', '.agents']) {
      const link = path.join(home, dir, 'skills', 'browser');
      expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe(BROWSER_SKILL_MARKDOWN);
    }
  });

  it('drops the discovery links once the skill is gone', async () => {
    await installBrowserSkill(home);
    await syncCodeyManagedSkills(home);
    await removeBrowserSkill(home);
    await syncCodeyManagedSkills(home);
    for (const dir of ['.claude', '.agents']) {
      expect(fs.existsSync(path.join(home, dir, 'skills', 'browser'))).toBe(false);
    }
  });

  it('leaves the user-owned skill root alone', async () => {
    const mine = path.join(home, '.codey', 'skills', 'browser');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'mine', 'utf8');
    await installBrowserSkill(home);
    await removeBrowserSkill(home);
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toBe('mine');
  });
});
