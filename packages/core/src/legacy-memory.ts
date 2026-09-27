/** Read-only compatibility with pre-Co-memo files. No migration writes or background persistence. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export type MemoryType = 'fact' | 'preference' | 'lesson' | 'decision' | 'context';

/** Legacy Bot scopes are retained on disk for inspection, but no longer recalled or shared. */
export type MemoryScope = 'workspace' | { bot: string } | { bots: string[] };

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  /** Short label for display */
  label: string;
  /** When this memory was created */
  createdAt: number;
  /** When the memory content was last modified (not bumped on read) */
  updatedAt: number;
  /** When the memory was last surfaced to a prompt (read-side tracking) */
  lastAccessedAt?: number;
  /** How many times this memory was included in a prompt */
  accessCount: number;
  /** Tags for filtering */
  tags: string[];
  /** Source that created this memory (e.g. "auto", "user", "planner") */
  source: string;
  /** Visibility scope; absent = workspace-wide */
  scope?: MemoryScope;
}

export interface MemoryIndex {
  version: 1;
  entries: MemoryEntry[];
}


export function isSharedMemoryEntry(entry: { scope?: unknown }): boolean {
  return entry.scope === undefined || entry.scope === 'workspace';
}
export async function readLegacyMemory(root: string, includeSharedFile = false): Promise<{ contents: string[]; warnings: string[] }> {
  const contents: string[] = []; const warnings: string[] = [];
  const read = async (file: string) => {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') warnings.push(`Could not read legacy memory ${file}: ${error.message}`);
      return undefined;
    }
  };
  const file = path.join(root, 'memory', 'index.json');
  const index = await read(file);
  if (index !== undefined) {
    try {
      const parsed = JSON.parse(index);
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Unsupported memory index');
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') {
          warnings.push('Skipped an invalid legacy memory entry'); continue;
        }
        if (isSharedMemoryEntry(entry)) contents.push(entry.content);
      }
    } catch (error: any) { warnings.push(`Could not parse legacy memory ${file}: ${error.message}`); }
  } else if (!warnings.length) {
    // An existing index is authoritative, including an intentionally empty one.
    const markdown = await read(path.join(root, 'memory.md'));
    if (markdown?.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#'))) contents.push(markdown);
  }
  if (includeSharedFile) {
    const shared = await read(path.join(root, 'memory', 'MEMORY.md'));
    if (shared) contents.push(shared);
  }
  return { contents: [...new Set(contents.map(text => text.trim()).filter(Boolean))], warnings };
}
