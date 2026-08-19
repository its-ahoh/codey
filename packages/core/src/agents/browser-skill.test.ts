import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  browserSkillMarkdown,
  browserSkillStatus,
  codeySkillDownloadUrl,
  installBrowserSkill,
  isBrowserSkillActive,
  uninstallBrowserSkill,
} from './browser-skill';
import { syncCodeyGlobalSkills } from './codey-skills';

let home: string;

const skillDir = () => path.join(home, '.codey', 'skills', 'browser');
const skillFile = () => path.join(skillDir(), 'SKILL.md');

/** What the repository serves in these tests: a valid but distinguishable
 *  skill, so "which copy landed" is visible in the file itself. */
const PUBLISHED = `---
name: browser
description: ${'Published copy, long enough to pass the description check on its own.'}
---

${'Published body.\n'.repeat(40)}`;

const serve = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-browser-skill-'));
  vi.stubGlobal('fetch', serve(PUBLISHED));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('installing the browser skill', () => {
  it('writes the published skill into the user\'s own skill root', async () => {
    const result = await installBrowserSkill(home);
    expect(result).toEqual({ file: skillFile(), source: 'repository', reason: undefined });
    expect(fs.readFileSync(result.file, 'utf8')).toBe(PUBLISHED);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(codeySkillDownloadUrl('browser'));
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
      expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe(PUBLISHED);
    }
  });

  it('refreshes a stale copy, which is what pressing Update asks for', async () => {
    await installBrowserSkill(home);
    fs.writeFileSync(skillFile(), '---\nname: browser\ndescription: stale\n---\n', 'utf8');
    await installBrowserSkill(home);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(PUBLISHED);
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
  it('is absent before an install, and still names where it would go', () => {
    expect(browserSkillStatus(home)).toMatchObject({ state: 'absent', dir: skillDir(), differsFromBundled: false });
    expect(isBrowserSkillActive(home)).toBe(false);
  });

  it('is installed after one', async () => {
    await installBrowserSkill(home);
    expect(browserSkillStatus(home)).toMatchObject({ state: 'installed', dir: skillDir() });
    expect(isBrowserSkillActive(home)).toBe(true);
  });

  // The published copy is expected to move ahead of the one in the app; saying
  // so is useful, correcting it is not — the file is the user's.
  it('reports a copy that is not the bundled one, without acting on it', async () => {
    await installBrowserSkill(home);
    expect(browserSkillStatus(home).differsFromBundled).toBe(true);
    fs.writeFileSync(skillFile(), browserSkillMarkdown(), 'utf8');
    expect(browserSkillStatus(home).differsFromBundled).toBe(false);
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

describe('pulling the skill from the repository', () => {
  it('falls back to the bundled copy when the repository cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }));
    const result = await installBrowserSkill(home);
    expect(result.source).toBe('bundled');
    expect(result.reason).toContain('ENOTFOUND');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(browserSkillMarkdown());
  });

  it('falls back on an HTTP error rather than writing the error page', async () => {
    vi.stubGlobal('fetch', serve('<html>404</html>', 404));
    const result = await installBrowserSkill(home);
    expect(result.source).toBe('bundled');
    expect(result.reason).toContain('404');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(browserSkillMarkdown());
  });

  // A raw URL can answer with a proxy login page or someone else's file, and
  // whatever lands here is read by every agent as instructions.
  it('refuses a 200 that is not this skill', async () => {
    vi.stubGlobal('fetch', serve('<html>Sign in to continue</html>'));
    const result = await installBrowserSkill(home);
    expect(result.source).toBe('bundled');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(browserSkillMarkdown());
  });

  it('refuses a well-formed skill under another name', async () => {
    vi.stubGlobal('fetch', serve(PUBLISHED.replace('name: browser', 'name: something-else')));
    expect((await installBrowserSkill(home)).source).toBe('bundled');
  });

  it('downloads from the published repository path', () => {
    expect(codeySkillDownloadUrl('browser')).toBe(
      'https://raw.githubusercontent.com/its-ahoh/codey-skills/main/skills/browser/SKILL.md',
    );
  });
});
