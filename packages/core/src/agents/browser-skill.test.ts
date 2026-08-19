import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  browserSkillMarkdown,
  browserSkillStatus,
  installBrowserSkill,
  isBrowserSkillActive,
  uninstallBrowserSkill,
} from './browser-skill';
import { syncCodeyGlobalSkills } from './codey-skills';

let home: string;

const skillDir = () => path.join(home, '.codey', 'skills', 'browser');
const skillFile = () => path.join(skillDir(), 'SKILL.md');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-browser-skill-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('installing the browser skill', () => {
  it('writes SKILL.md into the user\'s own skill root', async () => {
    const file = await installBrowserSkill(home);
    expect(file).toBe(skillFile());
    expect(fs.readFileSync(file, 'utf8')).toBe(browserSkillMarkdown());
  });

  it('names itself "browser" in frontmatter so agents can address it', () => {
    expect(browserSkillMarkdown()).toMatch(/^---\nname: browser\ndescription: .+/);
  });

  it('ships the command prefix, without which the body teaches nothing', () => {
    expect(browserSkillMarkdown()).toContain('$CODEY_BROWSER_CLI');
  });

  it('reaches every agent through both discovery directories', async () => {
    await installBrowserSkill(home);
    await syncCodeyGlobalSkills(home);
    for (const dir of ['.claude', '.agents']) {
      const link = path.join(home, dir, 'skills', 'browser');
      expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe(browserSkillMarkdown());
    }
  });

  it('refreshes a stale copy, which is what pressing Update asks for', async () => {
    await installBrowserSkill(home);
    fs.writeFileSync(skillFile(), '---\nname: browser\ndescription: stale\n---\n', 'utf8');
    expect(browserSkillStatus(home).updateAvailable).toBe(true);
    await installBrowserSkill(home);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(browserSkillMarkdown());
    expect(browserSkillStatus(home).updateAvailable).toBe(false);
  });

  it('installing an off skill turns it back on, leaving no disabled leftover', async () => {
    await installBrowserSkill(home);
    fs.renameSync(skillFile(), path.join(skillDir(), 'SKILL.md.disabled'));
    await installBrowserSkill(home);
    expect(fs.existsSync(skillFile())).toBe(true);
    expect(fs.existsSync(path.join(skillDir(), 'SKILL.md.disabled'))).toBe(false);
  });
});

describe('uninstalling the browser skill', () => {
  it('removes the skill and, on the next sync, its discovery links', async () => {
    await installBrowserSkill(home);
    await syncCodeyGlobalSkills(home);
    await uninstallBrowserSkill(home);
    await syncCodeyGlobalSkills(home);
    expect(fs.existsSync(skillDir())).toBe(false);
    for (const dir of ['.claude', '.agents']) {
      expect(fs.existsSync(path.join(home, dir, 'skills', 'browser'))).toBe(false);
    }
  });

  it('uninstalling an absent skill is not an error', async () => {
    await expect(uninstallBrowserSkill(home)).resolves.toBe(true);
  });

  it('leaves the user\'s other skills alone', async () => {
    const mine = path.join(home, '.codey', 'skills', 'mine');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'mine', 'utf8');
    await installBrowserSkill(home);
    await uninstallBrowserSkill(home);
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toBe('mine');
  });
});

describe('the state the capability gate reads', () => {
  it('is absent before an install', () => {
    expect(browserSkillStatus(home)).toEqual({ state: 'absent', updateAvailable: false });
    expect(isBrowserSkillActive(home)).toBe(false);
  });

  it('is installed after one', async () => {
    await installBrowserSkill(home);
    expect(browserSkillStatus(home)).toEqual({ state: 'installed', updateAvailable: false });
    expect(isBrowserSkillActive(home)).toBe(true);
  });

  // Turning the skill off in the Skills tab renames SKILL.md; the browser env
  // has to stop with it, or an agent would hold bridge credentials for a skill
  // it can no longer read.
  it('is disabled — and inactive — once the Skills tab switches it off', async () => {
    await installBrowserSkill(home);
    fs.renameSync(skillFile(), path.join(skillDir(), 'SKILL.md.disabled'));
    expect(browserSkillStatus(home).state).toBe('disabled');
    expect(isBrowserSkillActive(home)).toBe(false);
  });

  it('is absent again after the Skills tab deletes the directory', async () => {
    await installBrowserSkill(home);
    fs.rmSync(skillDir(), { recursive: true, force: true });
    expect(isBrowserSkillActive(home)).toBe(false);
  });
});
