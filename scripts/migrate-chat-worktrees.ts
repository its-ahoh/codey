/**
 * Move chat worktrees from the old data-root layout into the workspace.
 *
 *   ~/.codey/chat-worktrees/<workspace>/chat-<id>/<name>   (old)
 *   <workspace workingDir>/.worktrees/<name>               (new)
 *
 * Git owns the checkout, so `git worktree move` does the relocation and updates
 * the repository's own registry; this script only adds the two things Git does
 * not know about: the chat records that point at the old absolute path, and the
 * self-ignoring container.
 *
 * Dry run (default):  npx ts-node scripts/migrate-chat-worktrees.ts
 * Apply:              npx ts-node scripts/migrate-chat-worktrees.ts --apply
 * One chat:           ... --apply --chat <chatId>
 * Skip one chat:      ... --apply --skip <chatId>
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKTREE_CONTAINER = '.worktrees';
const dataRoot = process.env.CODEY_HOME ?? path.join(os.homedir(), '.codey');
const workspacesRoot = path.join(dataRoot, 'workspaces');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args[args.indexOf('--chat') + 1];
const onlyChat = args.includes('--chat') ? only : undefined;
const skipChat = args.includes('--skip') ? args[args.indexOf('--skip') + 1] : undefined;

interface ChatFile {
  file: string;
  id: string;
  title?: string;
  workspaceName: string;
  chatWorkspace?: { worktreePath: string; workingDir: string; repositoryRoot: string; name?: string };
  workingDirOverride?: string;
}

function readChats(): ChatFile[] {
  const chats: ChatFile[] = [];
  for (const workspace of fs.readdirSync(workspacesRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const chatsDir = path.join(workspacesRoot, workspace.name, 'chats');
    if (!fs.existsSync(chatsDir)) continue;
    for (const entry of fs.readdirSync(chatsDir)) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(chatsDir, entry);
      try {
        chats.push({ ...JSON.parse(fs.readFileSync(file, 'utf8')), file });
      } catch { /* unreadable chat file — leave it alone */ }
    }
  }
  return chats;
}

function workspaceWorkingDir(workspaceName: string): string | undefined {
  const config = path.join(workspacesRoot, workspaceName, 'workspace.json');
  if (!fs.existsSync(config)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(config, 'utf8')).workingDir || undefined;
  } catch { return undefined; }
}

const git = (cwd: string, gitArgs: string[]) =>
  execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim();

let moved = 0;
let skipped = 0;

for (const chat of readChats()) {
  const workspace = chat.chatWorkspace;
  if (!workspace?.worktreePath) continue;
  const container = path.join(path.resolve(workspaceWorkingDir(chat.workspaceName) ?? ''), WORKTREE_CONTAINER);
  if (path.dirname(workspace.worktreePath) === container) continue; // already migrated

  const label = `${chat.title || 'Untitled'} (${chat.id})`;
  const name = workspace.name || path.basename(workspace.worktreePath);
  const target = path.join(container, name);
  const reasons: string[] = [];
  if (onlyChat && chat.id !== onlyChat) reasons.push('not the requested --chat');
  if (skipChat && chat.id === skipChat) reasons.push('excluded by --skip');
  if (!workspaceWorkingDir(chat.workspaceName)) reasons.push(`workspace "${chat.workspaceName}" has no workingDir`);
  if (!fs.existsSync(workspace.worktreePath)) reasons.push('worktree directory is gone');
  if (fs.existsSync(target)) reasons.push(`target already exists: ${target}`);
  if (workspace.worktreePath === process.cwd() || process.cwd().startsWith(workspace.worktreePath + path.sep)) {
    reasons.push('this script is running inside that worktree');
  }
  if (reasons.length) {
    console.log(`SKIP  ${label}\n      ${reasons.join('; ')}`);
    skipped++;
    continue;
  }

  console.log(`${apply ? 'MOVE' : 'PLAN'}  ${label}\n      ${workspace.worktreePath}\n   -> ${target}`);
  if (!apply) { moved++; continue; }

  // Uncommitted work is fine (the checkout moves intact), but a running agent
  // is not: Git rewrites the admin files while the process holds the old path.
  const dirty = git(workspace.worktreePath, ['status', '--porcelain']);
  if (dirty) console.log('      note: worktree has uncommitted changes; they move with it');

  fs.mkdirSync(container, { recursive: true });
  const ignoreFile = path.join(container, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');

  git(workspace.repositoryRoot, ['worktree', 'move', workspace.worktreePath, target]);

  const record = JSON.parse(fs.readFileSync(chat.file, 'utf8'));
  const relativeWorkingDir = path.relative(workspace.worktreePath, workspace.workingDir);
  record.chatWorkspace.worktreePath = target;
  record.chatWorkspace.workingDir = path.join(target, relativeWorkingDir);
  if (record.workingDirOverride) record.workingDirOverride = record.chatWorkspace.workingDir;
  const temp = `${chat.file}.migrating`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2));
  fs.renameSync(temp, chat.file); // atomic, mirrors ChatManager.persist
  moved++;
}

const oldRoot = path.join(dataRoot, 'chat-worktrees');
if (apply && fs.existsSync(oldRoot)) {
  // Prune whatever is left empty; anything still holding a checkout stays put.
  // Finder litter (.DS_Store) would otherwise keep a drained directory alive —
  // and, being a file rather than a directory, break the walk.
  const prune = (dir: string, depth: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (depth > 0) prune(path.join(dir, entry.name), depth - 1);
      } else if (entry.name === '.DS_Store') {
        fs.rmSync(path.join(dir, entry.name));
      }
    }
    try { fs.rmdirSync(dir); } catch { /* still holds a checkout */ }
  };
  prune(oldRoot, 2);
}

console.log(`\n${apply ? 'Migrated' : 'Would migrate'} ${moved}; skipped ${skipped}.`);
if (!apply) console.log('Re-run with --apply to perform the moves.');
