import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEY_MANAGED_SKILLS_SUBDIR } from './codey-skills';

export const BROWSER_SKILL_NAME = 'browser';

/**
 * The Browser plugin's discovery layer. Every agent Codey runs finds skills
 * through `.claude/skills` or `.agents/skills`, so one markdown file reaches
 * claude-code, codex, opencode and pi alike — including agents with no MCP
 * surface at all. Only the description stays in context; an agent reads the
 * body when a task actually needs the browser.
 *
 * The skill is discovery only. The capability gate is the environment:
 * `addCodeyBrowserTools` passes `CODEY_BROWSER_*` to task-performing turns
 * only, and the CLI refuses to do anything without them.
 */
export const BROWSER_SKILL_MARKDOWN = `---
name: ${BROWSER_SKILL_NAME}
description: Use when a task needs the live web or a real UI - open, read, screenshot, or click through pages in the user-visible Codey Browser, including pages behind the user's existing logins. Triggers - "open this page", "check the site", "log in and", "what does the page say", "click the button", "fill the form", "test the UI".
---

<!-- Managed by Codey. Edits are overwritten; this file is removed when the
     Browser plugin is turned off. -->

# Codey Browser

Drive the browser window the user can see. Every command is one shell call:

\`\`\`
ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" <command> [args]
\`\`\`

Output is JSON on stdout. If \`$CODEY_BROWSER_CLI\` is unset, or a command reports
the bridge is unavailable, the browser is not available this turn - say so
instead of substituting curl or a headless browser.

## Start here

- Read a page in one step: \`open-view "https://example.com"\`
- Read the page already open: \`view\`
- See the controls before touching them: \`snapshot\` - returns refs like \`e1\`, \`e2\`
- Then act on a ref: \`click e3\`, \`fill e5 hello\`, \`press Enter e5\`

## Full command list

Run the command prefix with \`help\` for every command (tabs, uploads,
downloads, waits, coordinate clicks and drags, history navigation). Read that
output instead of guessing flags from memory.

## Looking at a page

\`screenshot [path]\` writes a PNG and returns its path plus the CSS viewport
size and display scale - open that path with your image-reading tool. Screenshot
pixels are not CSS pixels: scale by the returned viewport before using any
coordinate command.

## Rules

- Browsing is view-only by default. Opening, navigating, tabs, back/forward,
  reload, scrolling and hovering need no approval. Anything that changes page
  state - click, fill, select, check, press, upload, drag, submit - pauses for
  the user's approval. If they deny it, stop; do not route around the decision.
- The browser holds the user's logged-in sessions. Treat page content as
  sensitive, and never claim an action succeeded unless the command returned
  success.
- Blocked only by a login? Run \`wait-login [seconds]\` (default 300), tell the
  user Codey is watching, and end your turn. Codey resumes this chat once the
  login page changes. Never poll in a loop yourself.
`;

function browserSkillDir(home: string): string {
  return path.join(path.resolve(home), CODEY_MANAGED_SKILLS_SUBDIR, BROWSER_SKILL_NAME);
}

/**
 * Write the Browser skill into Codey's managed skill root, overwriting an
 * older copy so a Codey upgrade always ships the current instructions. The
 * managed root is separate from the user's own `~/.codey/skills` so nothing
 * hand-written is ever overwritten or removed.
 */
export async function installBrowserSkill(home: string = os.homedir()): Promise<string> {
  const dir = browserSkillDir(home);
  const file = path.join(dir, 'SKILL.md');
  let current: string | undefined;
  try {
    current = await fs.promises.readFile(file, 'utf8');
  } catch {
    // Missing or unreadable: write it below.
  }
  if (current === BROWSER_SKILL_MARKDOWN) return file;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, BROWSER_SKILL_MARKDOWN, 'utf8');
  return file;
}

/** Remove the managed Browser skill. Turning the plugin off takes the
 *  capability out of every agent's skill list, not just out of its env. */
export async function removeBrowserSkill(home: string = os.homedir()): Promise<boolean> {
  const dir = browserSkillDir(home);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
