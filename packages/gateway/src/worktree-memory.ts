import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoMemoClient, CoMemoNote } from '@codey/core';

export interface MemoryInheritance {
  version: 1;
  sourcePath: string;
  targetPath: string;
  createdAt: number;
  complete: boolean;
  /** Identifier of this actual inheritance operation, used as copy provenance. */
  operationId?: string;
  entries: Array<{ source: CoMemoNote; localId?: string; localVersion?: number; skipped?: boolean }>;
}
const pending = new Map<string, Promise<void>>();

/** Freeze the source once, checkpoint each independent copy, and never resync a completed snapshot. */
export function inheritWorktreeMemory(client: CoMemoClient, sourcePath: string, targetPath: string, manifestPath: string): Promise<void> {
  const current = pending.get(manifestPath);
  if (current) return current;
  const task = inherit(client, sourcePath, targetPath, manifestPath).finally(() => pending.delete(manifestPath));
  pending.set(manifestPath, task);
  return task;
}
async function inherit(client: CoMemoClient, sourcePath: string, targetPath: string, file: string) {
  if (await fs.realpath(sourcePath) === await fs.realpath(targetPath)) throw new Error('Memory inheritance requires a separate worktree');
  let snapshot: MemoryInheritance;
  try { snapshot = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    snapshot = { version: 1, sourcePath, targetPath, createdAt: Date.now(), complete: false,
      entries: (await client.list('project', sourcePath)).map(source => ({ source })) };
  }
  if (snapshot.version !== 1 || snapshot.sourcePath !== sourcePath || snapshot.targetPath !== targetPath) throw new Error('Memory inheritance identity mismatch');
  if (snapshot.complete) return;
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  };
  snapshot.operationId ??= randomUUID();
  await save();
  const target = await client.list('project', targetPath, undefined, true);
  if (target.some(note => snapshot.entries.some(entry => entry.source.id === note.id))) {
    throw new Error('This worktree shares its parent memory project. Independent inheritance requires an unlinked project.');
  }
  for (const entry of snapshot.entries) {
    if (entry.localId || entry.skipped) continue;
    // After a crash, dedup against the destination without reviving an archive.
    const existing = target.find(note => note.content.trim() === entry.source.content.trim());
    if (existing) {
      entry.localId = existing.id; entry.localVersion = existing.version; entry.skipped = existing.deleted;
    } else {
      const metadata = entry.source.metadata;
      let copy: CoMemoNote;
      if (metadata && (metadata.source || metadata.kind && metadata.kind !== 'note' || metadata.module || metadata.pinned)) {
        const source = metadata.source;
        const result = await client.call<{ results: Array<{ verified: boolean; receipt?: { id: string } }> }>('memory_submit', {
          requestId: randomUUID(), intent: 'automatic', candidates: [{
            action: 'add', scope: 'project', content: entry.source.content,
            kind: metadata.kind ?? 'note', module: metadata.module ?? null, pinned: metadata.pinned ?? false,
            source: source?.agent && source.sessionId && source.messageId && source.excerpt ? source : {
              agent: 'codey-worktree-inheritance', sessionId: snapshot.operationId,
              messageId: `${entry.source.id}:${entry.source.version}`, excerpt: entry.source.content.slice(0, 2000),
            },
          }],
        }, targetPath);
        const receipt = result.results[0];
        if (!receipt?.verified || !receipt.receipt) throw new Error('Inherited memory could not be verified');
        copy = (await client.details(receipt.receipt.id, 'project', targetPath)).memory;
      } else {
        copy = await client.remember(entry.source.content, 'project', targetPath, 'automatic');
      }
      entry.localId = copy.id; entry.localVersion = copy.version;
      target.push(copy);
    }
    await save();
  }
  snapshot.complete = true;
  await save();
}
