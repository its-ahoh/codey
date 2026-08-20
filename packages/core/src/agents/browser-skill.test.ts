import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  browserSkillMarkdown,
  browserSkillStatus,
  checkBrowserSkillUpdate,
  CODEY_INSTALL_MARKER,
  codeySkillDownloadUrl,
  codeySkillTreeUrl,
  installBrowserSkill,
  isBrowserSkillActive,
  isCodeyInstalledSkill,
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
description: Published copy, long enough to pass the description check on its own.
---

${'Published body.\n'.repeat(40)}`;

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

/** Install makes two calls: the raw file, then the skill folder's tree hash.
 *  `sha: null` serves a broken tree so the stamp has to fall back. */
const serve = (body: string, status = 200, sha: string | null = SHA) =>
  vi.fn(async (url: string) => (
    url.startsWith('https://api.github.com/')
      ? new Response(
          sha === null ? 'nope' : JSON.stringify({ tree: [{ path: 'skills/browser', type: 'tree', sha }] }),
          { status: sha === null ? 500 : 200 },
        )
      : new Response(body, { status })
  ));

/** Every install stamps the file, so assertions compare the text around it. */
const written = () => fs.readFileSync(skillFile(), 'utf8');
const unstamped = () => written()
  .split('\n').filter(line => !line.startsWith(CODEY_INSTALL_MARKER)).join('\n')
  .replace(/\n{3,}/g, '\n\n');
const marker = () => written().split('\n').find(line => line.startsWith(CODEY_INSTALL_MARKER))!;
const install = async (opts = {}) => {
  const result = await installBrowserSkill(home, { today: '2026-08-19', ...opts });
  if (!result.installed) throw new Error(`install refused: ${result.conflict}`);
  return result;
};

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
    const result = await install();
    expect(result).toEqual({ installed: true, file: skillFile(), source: 'repository', reason: undefined });
    expect(unstamped().trim()).toBe(PUBLISHED.trim());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(codeySkillDownloadUrl('browser'));
  });

  // Which bytes the user actually has is the first question when an agent runs
  // a command the installed CLI does not have. The folder tree hash answers it
  // exactly, and it is what an update compares against.
  it('stamps the file with the skill folder\'s tree hash, after the frontmatter', async () => {
    await install();
    const lines = written().split('\n');
    expect(lines[0]).toBe('---');
    expect(marker()).toContain(`browser ${SHA}`);
    expect(marker()).toContain('its-ahoh/codey-skills');
    expect(marker()).toContain('on 2026-08-19');
    expect(lines.indexOf(marker())).toBeGreaterThan(lines.indexOf('---', 1));
    expect(isCodeyInstalledSkill(written())).toBe(true);
  });

  it('ships a skill with the standard frontmatter — a name and a description, no version', () => {
    expect(browserSkillMarkdown()).toMatch(/^---\nname: browser\n/);
    expect(browserSkillMarkdown()).not.toContain('version:');
  });

  it('ships the command prefix, without which the body teaches nothing', () => {
    expect(browserSkillMarkdown()).toContain('$CODEY_BROWSER_CLI');
  });

  it('reaches every agent through both discovery directories', async () => {
    await installBrowserSkill(home);
    await syncCodeyGlobalSkills(home);
    for (const dir of ['.claude', '.agents']) {
      const link = path.join(home, dir, 'skills', 'browser');
      expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe(written());
    }
  });

  it('refreshes its own stale copy, which is what pressing Update asks for', async () => {
    await install();
    fs.writeFileSync(skillFile(), `---\nname: browser\ndescription: stale\n---\n${CODEY_INSTALL_MARKER} old -->\n`, 'utf8');
    await install();
    expect(unstamped().trim()).toBe(PUBLISHED.trim());
  });

  it('installing an off skill turns it back on, leaving no disabled leftover', async () => {
    await install();
    fs.renameSync(skillFile(), path.join(skillDir(), 'SKILL.md.disabled'));
    await installBrowserSkill(home);
    expect(fs.existsSync(skillFile())).toBe(true);
    expect(fs.existsSync(path.join(skillDir(), 'SKILL.md.disabled'))).toBe(false);
  });
});

describe('uninstalling the browser skill', () => {
  it('removes the skill and, on the next sync, its discovery links', async () => {
    await install();
    await syncCodeyGlobalSkills(home);
    expect(await uninstallBrowserSkill(home)).toEqual({ removed: true });
    await syncCodeyGlobalSkills(home);
    expect(fs.existsSync(skillDir())).toBe(false);
    for (const dir of ['.claude', '.agents']) {
      expect(fs.existsSync(path.join(home, dir, 'skills', 'browser'))).toBe(false);
    }
  });

  it('uninstalling an absent skill is not an error', async () => {
    await expect(uninstallBrowserSkill(home)).resolves.toEqual({ removed: true });
  });

  it('leaves the user\'s other skills alone', async () => {
    const mine = path.join(home, '.codey', 'skills', 'mine');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'mine', 'utf8');
    await install();
    await uninstallBrowserSkill(home);
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toBe('mine');
  });
});

describe('the state the capability gate reads', () => {
  it('is absent before an install, and still names where it would go', () => {
    expect(browserSkillStatus(home)).toMatchObject({ state: 'absent', dir: skillDir() });
    expect(browserSkillStatus(home).origin).toBeUndefined();
    expect(isBrowserSkillActive(home)).toBe(false);
  });

  it('is installed, and Codey\'s, after one, with the hash it was stamped with', async () => {
    await install();
    expect(browserSkillStatus(home)).toMatchObject({
      state: 'installed', dir: skillDir(), origin: 'codey', hash: SHA,
    });
    expect(isBrowserSkillActive(home)).toBe(true);
  });

  it('calls an unstamped copy the user\'s', () => {
    fs.mkdirSync(skillDir(), { recursive: true });
    fs.writeFileSync(skillFile(), '---\nname: browser\ndescription: mine\n---\nMy own notes.\n', 'utf8');
    expect(browserSkillStatus(home).origin).toBe('user');
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
    const result = await install();
    expect(result.source).toBe('bundled');
    expect(result.reason).toContain('ENOTFOUND');
    expect(unstamped().trim()).toBe(browserSkillMarkdown().trim());
  });

  it('falls back on an HTTP error rather than writing the error page', async () => {
    vi.stubGlobal('fetch', serve('<html>404</html>', 404));
    const result = await install();
    expect(result.source).toBe('bundled');
    expect(result.reason).toContain('404');
    expect(unstamped().trim()).toBe(browserSkillMarkdown().trim());
  });

  // A raw URL can answer with a proxy login page or someone else's file, and
  // whatever lands here is read by every agent as instructions.
  it('refuses a 200 that is not this skill', async () => {
    vi.stubGlobal('fetch', serve('<html>Sign in to continue</html>'));
    expect((await install()).source).toBe('bundled');
    expect(unstamped().trim()).toBe(browserSkillMarkdown().trim());
  });

  it('refuses a well-formed skill under another name', async () => {
    vi.stubGlobal('fetch', serve(PUBLISHED.replace('name: browser', 'name: something-else')));
    expect((await install()).source).toBe('bundled');
  });

  it('downloads from the published repository path', () => {
    expect(codeySkillDownloadUrl('browser')).toBe(
      'https://raw.githubusercontent.com/its-ahoh/codey-skills/main/skills/browser/SKILL.md',
    );
  });

  it('reads the version from the skill folder\'s tree on main', () => {
    expect(codeySkillTreeUrl('browser')).toBe(
      'https://api.github.com/repos/its-ahoh/codey-skills/git/trees/main?recursive=1',
    );
  });

  // A stamp that cannot name the hash still names the skill and the date, which
  // is the part a human reads; Update still re-pulls whatever is published.
  it('stamps without a hash when the tree cannot be read', async () => {
    vi.stubGlobal('fetch', serve(PUBLISHED, 200, null));
    await install();
    expect(marker()).toMatch(/Installed by Codey: browser from its-ahoh\/codey-skills on 2026-08-19/);
    expect(marker()).not.toContain(`browser ${SHA}`);
  });

  it('ignores a tree response that is not a tree', async () => {
    vi.stubGlobal('fetch', serve(PUBLISHED, 200, 'not-a-sha'));
    await install();
    expect(marker()).toMatch(/Installed by Codey: browser from its-ahoh\/codey-skills on 2026-08-19/);
  });
});

describe('a skill of the same name that Codey did not write', () => {
  const MINE = '---\nname: browser\ndescription: my own\n---\nMy own notes.\n';

  beforeEach(() => {
    fs.mkdirSync(skillDir(), { recursive: true });
    fs.writeFileSync(skillFile(), MINE, 'utf8');
  });

  it('is not replaced by an install', async () => {
    const result = await installBrowserSkill(home, { today: '2026-08-19' });
    expect(result).toEqual({ installed: false, conflict: 'user-copy', dir: skillDir() });
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(MINE);
  });

  it('is not deleted by an uninstall', async () => {
    expect(await uninstallBrowserSkill(home)).toEqual({ removed: false, conflict: 'user-copy' });
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(MINE);
  });

  it('is replaced once the user confirms', async () => {
    expect((await installBrowserSkill(home, { force: true, today: '2026-08-19' })).installed).toBe(true);
    expect(browserSkillStatus(home).origin).toBe('codey');
  });

  it('is deleted once the user confirms', async () => {
    expect(await uninstallBrowserSkill(home, { force: true })).toEqual({ removed: true });
    expect(browserSkillStatus(home).state).toBe('absent');
  });

  // Disabling in the Skills tab renames the file; the guard has to see it there
  // too, or turning a hand-written skill off would make it overwritable.
  it('is protected while switched off as well', async () => {
    fs.renameSync(skillFile(), path.join(skillDir(), 'SKILL.md.disabled'));
    expect((await installBrowserSkill(home, { today: '2026-08-19' })).installed).toBe(false);
  });
});

describe('checking whether the published skill moved', () => {
  it('reports no update while the installed hash matches the tree', async () => {
    await install();
    await expect(checkBrowserSkillUpdate(home)).resolves.toEqual({
      recorded: SHA, current: SHA, needsUpdate: false,
    });
  });

  it('reports an update when the folder hash moved on main', async () => {
    await install();
    vi.stubGlobal('fetch', serve(PUBLISHED, 200, OTHER_SHA));
    await expect(checkBrowserSkillUpdate(home)).resolves.toEqual({
      recorded: SHA, current: OTHER_SHA, needsUpdate: true,
    });
  });

  // A copy without a stamp is the user's; nothing Codey does compares or
  // replaces it.
  it('treats an unstamped copy as nothing to update', async () => {
    fs.mkdirSync(skillDir(), { recursive: true });
    fs.writeFileSync(skillFile(), '---\nname: browser\ndescription: mine\n---\nMy own notes.\n', 'utf8');
    await expect(checkBrowserSkillUpdate(home)).resolves.toEqual({
      recorded: undefined, current: SHA, needsUpdate: false,
    });
  });

  it('throws when the tree cannot be reached, so the caller can stay quiet', async () => {
    await install();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }));
    await expect(checkBrowserSkillUpdate(home)).rejects.toThrow('ENOTFOUND');
  });
});
