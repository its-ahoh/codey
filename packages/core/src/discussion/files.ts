import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

export function discussionDir(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(workspacesRoot, workspace, 'chats', chatId, 'discussion');
}

export function opinionsDir(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'opinions');
}

export function opinionPath(workspacesRoot: string, workspace: string, chatId: string, worker: string): string {
  return path.join(opinionsDir(workspacesRoot, workspace, chatId), `${worker}.md`);
}

export function controlPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'control.md');
}

export function summaryPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'summary.md');
}

export function topicPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'topic.md');
}

export function transcriptPath(workspacesRoot: string, workspace: string, chatId: string): string {
  return path.join(discussionDir(workspacesRoot, workspace, chatId), 'transcript.log');
}

function controlBlock(): string {
  return `---\nstatus: running\nrevision: 1\nupdated_at: ${new Date().toISOString()}\n---\n\n## Directive\nStart the discussion. Read the topic, share your initial perspective in your opinion file.\n`;
}

export async function initDiscussionDir(
  workspacesRoot: string,
  workspace: string,
  chatId: string,
  topic: string,
  workers: string[]
): Promise<void> {
  const dir = discussionDir(workspacesRoot, workspace, chatId);
  const opDir = opinionsDir(workspacesRoot, workspace, chatId);
  const exists = fs.existsSync(dir);

  await fsp.mkdir(opDir, { recursive: true });

  if (!exists) {
    await fsp.writeFile(topicPath(workspacesRoot, workspace, chatId), `# Topic\n\n${topic}\n`);
    await fsp.writeFile(controlPath(workspacesRoot, workspace, chatId), controlBlock());
    await fsp.writeFile(summaryPath(workspacesRoot, workspace, chatId), '# Summary\n\n(pending)\n');
    await fsp.writeFile(transcriptPath(workspacesRoot, workspace, chatId), '');
    for (const w of workers) {
      await fsp.writeFile(opinionPath(workspacesRoot, workspace, chatId, w), `# ${w}'s opinion\n\n(not started)\n`);
    }
  } else {
    await fsp.appendFile(
      topicPath(workspacesRoot, workspace, chatId),
      `\n\n## Continuation (${new Date().toISOString()})\n\n${topic}\n`
    );
    await fsp.writeFile(controlPath(workspacesRoot, workspace, chatId), controlBlock());
    for (const w of workers) {
      const p = opinionPath(workspacesRoot, workspace, chatId, w);
      if (!fs.existsSync(p)) {
        await fsp.writeFile(p, `# ${w}'s opinion\n\n(not started)\n`);
      }
    }
  }
}

export async function destroyDiscussionDir(workspacesRoot: string, workspace: string, chatId: string): Promise<void> {
  const dir = discussionDir(workspacesRoot, workspace, chatId);
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function listOpinionFiles(workspacesRoot: string, workspace: string, chatId: string): Promise<string[]> {
  const dir = opinionsDir(workspacesRoot, workspace, chatId);
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir);
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

export async function appendTranscript(
  workspacesRoot: string,
  workspace: string,
  chatId: string,
  event: { actor: string; kind: string; note?: string }
): Promise<void> {
  const ts = new Date().toISOString();
  const note = event.note ? ` ${event.note.replace(/\r?\n/g, ' ')}` : '';
  const line = `${ts} ${event.actor} ${event.kind}${note}\n`;
  await fsp.appendFile(transcriptPath(workspacesRoot, workspace, chatId), line);
}
