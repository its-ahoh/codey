/**
 * Persistent Memory System
 *
 * Workspace-scoped persistent memory that survives across sessions.
 * Memories are stored as individual files in the workspace directory
 * and indexed in a manifest. Similar in spirit to CLAUDE.md but
 * agent-agnostic and programmatically managed.
 *
 * Structure per workspace:
 *   workspaces/<name>/memory/
 *     index.json          — manifest of all memories
 *     <id>.md             — individual memory files
 *   workspaces/<name>/memory.md  — human-readable summary (legacy, still updated)
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { estimateTokens } from './utils/tokens';

// ── Types ──────────────────────────────────────────────────────────

export type MemoryType = 'fact' | 'preference' | 'lesson' | 'decision' | 'context';

/**
 * Visibility scope for a memory entry. Controls which agents/workers see this
 * entry when `buildContext({ forWorker })` filters the candidate set.
 *
 *  - `'workspace'` (or undefined) — visible to everyone in the workspace
 *  - `{ worker: 'alice' }` — only visible when alice is the running worker
 *    AND to the main chat (the chat is the orchestrator, it sees everything)
 *  - `{ workers: ['alice', 'bob'] }` — visible when any of those workers run
 */
export type MemoryScope = 'workspace' | { worker: string } | { workers: string[] };

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

// ── Memory Store ───────────────────────────────────────────────────

export class MemoryStore {
  private workspacePath: string;
  private memoryDir: string;
  private indexPath: string;
  private legacyPath: string;
  private index: MemoryIndex = { version: 1, entries: [] };

  /** Serialized write queue — every persist chains onto this promise. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Set when in-memory state has diverged from disk. */
  private indexDirty = false;
  private legacyDirty = false;
  /** Pending debounced flush handle. */
  private flushTimer: NodeJS.Timeout | null = null;
  /** Debounce window for coalescing rapid writes. */
  private static FLUSH_DEBOUNCE_MS = 50;

  /** Read-side persistence is throttled — counts and timestamp are mutated
   *  in memory eagerly but only flushed periodically to avoid one disk
   *  write per chat message. */
  private pendingAccessFlush = false;
  private lastAccessFlush = 0;
  private static ACCESS_FLUSH_INTERVAL_MS = 60_000;
  private static ACCESS_FLUSH_EVERY_N_READS = 20;
  private readsSinceFlush = 0;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.memoryDir = path.join(workspacePath, 'memory');
    this.indexPath = path.join(this.memoryDir, 'index.json');
    this.legacyPath = path.join(workspacePath, 'memory.md');
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }

    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        const parsed = JSON.parse(data) as MemoryIndex;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
          this.index = parsed;
        }
      } catch {
        this.index = { version: 1, entries: [] };
      }
    }

    if (this.index.entries.length === 0 && fs.existsSync(this.legacyPath)) {
      this.migrateFromLegacy();
      // Force the migrated entry to disk synchronously-ish — otherwise a
      // short-lived process (CLI one-shot) would exit before the debounced
      // unref'd flush timer fires and the migration would be lost.
      if (this.indexDirty || this.legacyDirty) {
        await this.flush();
      }
    }
  }

  /** Wait for all pending writes to drain. Use on shutdown or in tests. */
  async flush(): Promise<void> {
    // Fold throttled access updates into the next persist.
    if (this.pendingAccessFlush) {
      this.pendingAccessFlush = false;
      this.lastAccessFlush = Date.now();
      this.readsSinceFlush = 0;
      this.markDirty({ index: true, legacy: false });
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.enqueuePersist();
    }
    await this.writeChain;
  }

  private migrateFromLegacy(): void {
    const raw = fs.readFileSync(this.legacyPath, 'utf-8').trim();
    if (!raw) return;

    // Skip files that are only a header line (no real content)
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const hasBodyBeyondHeader = lines.some(l => !l.startsWith('#'));
    if (!hasBodyBeyondHeader) return;

    this.add({
      type: 'context',
      content: raw,
      label: 'Migrated project notes',
      tags: ['migrated'],
      source: 'migration',
    });
  }

  // ── CRUD ───────────────────────────────────────────────────────

  add(params: {
    type: MemoryType;
    content: string;
    label: string;
    tags?: string[];
    source?: string;
    scope?: MemoryScope;
  }): MemoryEntry {
    const now = Date.now();

    // Content-hash dedup: if an entry with the same (type, normalized content)
    // already exists, treat this as a touch instead of inserting a duplicate.
    const dedupKey = dedupHash(params.type, params.content);
    const existing = this.index.entries.find(e => dedupHash(e.type, e.content) === dedupKey);
    if (existing) {
      existing.updatedAt = now;
      // Merge tags (set union, stable order).
      if (params.tags && params.tags.length > 0) {
        const seen = new Set(existing.tags);
        for (const t of params.tags) if (!seen.has(t)) { existing.tags.push(t); seen.add(t); }
      }
      this.markDirty({ index: true, legacy: true });
      return existing;
    }

    const entry: MemoryEntry = {
      id: `mem-${crypto.randomUUID()}`,
      type: params.type,
      content: params.content,
      label: params.label,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      tags: params.tags || [],
      source: params.source || 'auto',
      ...(params.scope ? { scope: params.scope } : {}),
    };

    this.index.entries.push(entry);
    this.markDirty({ index: true, legacy: true });
    return entry;
  }

  update(id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'label' | 'tags' | 'type'>>): boolean {
    const entry = this.index.entries.find(e => e.id === id);
    if (!entry) return false;

    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.label !== undefined) entry.label = updates.label;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.type !== undefined) entry.type = updates.type;
    entry.updatedAt = Date.now();

    this.markDirty({ index: true, legacy: true });
    return true;
  }

  remove(id: string): boolean {
    const idx = this.index.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;

    this.index.entries.splice(idx, 1);
    this.markDirty({ index: true, legacy: true });
    return true;
  }

  get(id: string): MemoryEntry | undefined {
    return this.index.entries.find(e => e.id === id);
  }

  getAll(): MemoryEntry[] {
    return [...this.index.entries];
  }

  // ── Query ──────────────────────────────────────────────────────

  /**
   * Find memories matching a query string.
   *
   * Uses a lightweight BM25 ranking over three fields (label, tags, content)
   * with field weights — label and tag matches outrank content matches.
   * IDF is computed across all entries so common tokens stop dominating once
   * the store has any meaningful size.
   */
  search(query: string, limit: number = 10, forWorker?: string): MemoryEntry[] {
    const queryTerms = tokenize(query);
    const visible = this.index.entries.filter(e => isVisibleTo(e, forWorker));
    if (queryTerms.length === 0) return visible.slice(0, limit);

    const entries = visible;
    if (entries.length === 0) return [];

    // Per-field term frequencies + lengths.
    const docs = entries.map(e => {
      const labelTerms = tokenize(e.label);
      const contentTerms = tokenize(e.content);
      const tagTerms = tokenize(e.tags.join(' '));
      return {
        entry: e,
        fields: {
          label: { terms: termFreq(labelTerms), len: labelTerms.length },
          content: { terms: termFreq(contentTerms), len: contentTerms.length },
          tags: { terms: termFreq(tagTerms), len: tagTerms.length },
        },
      };
    });

    const avgLen = {
      label: avg(docs.map(d => d.fields.label.len)),
      content: avg(docs.map(d => d.fields.content.len)),
      tags: avg(docs.map(d => d.fields.tags.len)),
    };

    // Field weights: label and tag hits matter more than content hits.
    const weights = { label: 3, tags: 2, content: 1 };
    const k1 = 1.2;
    const b = 0.75;
    const N = docs.length;

    // Document frequencies per term across all fields combined.
    const df = new Map<string, number>();
    for (const d of docs) {
      const seen = new Set<string>();
      for (const f of ['label', 'content', 'tags'] as const) {
        for (const t of d.fields[f].terms.keys()) seen.add(t);
      }
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const scored = docs.map(d => {
      let score = 0;
      let anyHit = false;
      for (const term of queryTerms) {
        const dfT = df.get(term);
        if (!dfT) continue;
        const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
        for (const f of ['label', 'content', 'tags'] as const) {
          const tf = d.fields[f].terms.get(term);
          if (!tf) continue;
          anyHit = true;
          const len = d.fields[f].len;
          const avgFieldLen = avgLen[f] || 1;
          const norm = 1 - b + b * (len / avgFieldLen);
          const fieldScore = (tf * (k1 + 1)) / (tf + k1 * norm);
          score += weights[f] * idf * fieldScore;
        }
      }
      // Source-aware multiplier: user-curated entries outrank auto-extracted
      // ones at the same textual relevance.
      score *= sourceWeight(d.entry.source);
      return { entry: d.entry, score, anyHit };
    });

    return scored
      .filter(s => s.anyHit)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  /**
   * Get memories by type.
   */
  getByType(type: MemoryType): MemoryEntry[] {
    return this.index.entries.filter(e => e.type === type);
  }

  /**
   * Get the N most recently updated memories. Optionally restrict to
   * entries visible to the given worker (chat/null sees everything).
   */
  getRecent(limit: number = 10, forWorker?: string): MemoryEntry[] {
    return this.index.entries
      .filter(e => isVisibleTo(e, forWorker))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  // ── Build context string for prompts ───────────────────────────

  /**
   * Build a memory context block to include in agent prompts.
   * Selects the most relevant memories within a token budget.
   *
   * Pass `forWorker` when building for a specific worker run — entries scoped
   * to other workers will be filtered out. Omit for main chat or single-worker
   * paths (main chat sees everything).
   */
  buildContext(
    query?: string,
    maxTokens: number = 2000,
    maxTokensPerEntry: number = 200,
    forWorker?: string,
  ): string {
    let selected: MemoryEntry[];

    if (query) {
      const relevant = this.search(query, 8, forWorker);
      const recent = this.getRecent(4, forWorker);
      const ids = new Set(relevant.map(e => e.id));
      selected = [...relevant, ...recent.filter(e => !ids.has(e.id))];
    } else {
      selected = this.getRecent(12, forWorker);
    }

    if (selected.length === 0) return '';

    // Read-side tracking — does NOT bump updatedAt (which would corrupt
    // `getRecent` ordering and the prune heuristic). Throttle persistence:
    // counters mutate in memory immediately, disk flush happens at most
    // once per ACCESS_FLUSH_INTERVAL_MS or every N reads, whichever first.
    const now = Date.now();
    for (const entry of selected) {
      entry.accessCount++;
      entry.lastAccessedAt = now;
    }
    this.pendingAccessFlush = true;
    this.readsSinceFlush++;
    const due = now - this.lastAccessFlush >= MemoryStore.ACCESS_FLUSH_INTERVAL_MS
      || this.readsSinceFlush >= MemoryStore.ACCESS_FLUSH_EVERY_N_READS;
    if (due) {
      this.pendingAccessFlush = false;
      this.lastAccessFlush = now;
      this.readsSinceFlush = 0;
      this.markDirty({ index: true, legacy: false });
    }

    const lines: string[] = ['## Project Memory'];
    let tokenCount = estimateTokens(lines[0]);

    for (const entry of selected) {
      const content = truncateToTokens(entry.content, maxTokensPerEntry);
      const line = `- [${entry.type}] ${entry.label}: ${content}`;
      const lineTokens = estimateTokens(line);
      if (tokenCount + lineTokens > maxTokens) break;
      lines.push(line);
      tokenCount += lineTokens;
    }

    return lines.join('\n');
  }

  // ── Auto-extraction ────────────────────────────────────────────

  /**
   * Automatically extract memories from a completed agent interaction.
   * Looks for patterns like decisions made, files created, errors resolved.
   */
  extractFromInteraction(params: {
    userPrompt: string;
    agentOutput: string;
    toolCalls?: Array<{ tool: string; input?: Record<string, unknown>; output?: string; status: string }>;
    filesChanged?: Array<{ path: string; action: string }>;
  }): MemoryEntry[] {
    const created: MemoryEntry[] = [];

    // Heuristic: only record a "lesson" when the interaction looks like a
    // genuine fix — i.e. the user described a problem AND the agent
    // actually mutated code AND nothing errored. File-change lists alone
    // are not stored (git history already covers that, and storing them
    // floods the context with noise).
    const promptLower = params.userPrompt.toLowerCase();
    const errorKeywords = ['error', 'bug', 'fix', 'broken', 'fail', 'crash', 'issue', 'regression'];
    const promptLooksLikeFix = errorKeywords.some(kw =>
      // Word-boundary match avoids matching "fixture", "issuer", etc.
      new RegExp(`\\b${kw}\\b`).test(promptLower),
    );

    const mutatingActions = new Set(['create', 'edit', 'delete']);
    const editedFiles = (params.filesChanged ?? [])
      .filter(f => mutatingActions.has(f.action))
      .map(f => f.path);
    const hadFailedTools = (params.toolCalls ?? []).some(tc => tc.status === 'error');

    if (
      promptLooksLikeFix &&
      editedFiles.length > 0 &&
      !hadFailedTools &&
      params.agentOutput.trim().length > 0
    ) {
      // Capture the prompt + the touched files. Skip the agent's prose —
      // the first 200 chars rarely contains the actual insight and tends
      // to be filler like "I've fixed the issue by...".
      const filesPart = editedFiles.slice(0, 5).join(', ')
        + (editedFiles.length > 5 ? `, +${editedFiles.length - 5} more` : '');
      const promptOneLine = params.userPrompt.replace(/\s+/g, ' ').trim();
      created.push(this.add({
        type: 'lesson',
        content: `Reported: "${truncate(promptOneLine, 160)}". Touched: ${filesPart}.`,
        label: `Fix: ${truncate(promptOneLine, 60)}`,
        tags: ['auto', 'bugfix'],
        source: 'auto',
      }));
    }

    // Prune auto-memories if we have too many (keep last 50).
    // Order by accessCount (low first) then createdAt (old first) — using
    // createdAt avoids the feedback loop where reading a memory would
    // protect it from prune.
    const autoMemories = this.index.entries.filter(e => e.source === 'auto');
    if (autoMemories.length > 50) {
      const toRemove = autoMemories
        .sort((a, b) => a.accessCount - b.accessCount || a.createdAt - b.createdAt)
        .slice(0, autoMemories.length - 50);
      for (const entry of toRemove) {
        this.remove(entry.id);
      }
    }

    return created;
  }

  // ── Persistence ────────────────────────────────────────────────

  private markDirty(which: { index?: boolean; legacy?: boolean }): void {
    if (which.index) this.indexDirty = true;
    if (which.legacy) this.legacyDirty = true;
    this.scheduleFlush();
  }

  /** Chain a persist onto the write queue so writes serialize. */
  private enqueuePersist(): void {
    this.writeChain = this.writeChain.then(() => this.doPersist()).catch(() => {
      // Best-effort: swallow so one failure doesn't break the chain.
    });
  }

  private async doPersist(): Promise<void> {
    if (!this.indexDirty && !this.legacyDirty) return;

    const writeIndex = this.indexDirty;
    const writeLegacy = this.legacyDirty;
    // Snapshot serialized payloads under the synchronous tick so concurrent
    // mutations between now and the await don't see a partially-written state.
    const indexPayload = writeIndex ? JSON.stringify(this.index, null, 2) : null;
    const legacyPayload = writeLegacy ? this.renderLegacy() : null;
    this.indexDirty = false;
    this.legacyDirty = false;

    try {
      await fsp.mkdir(this.memoryDir, { recursive: true });
      if (indexPayload !== null) {
        await atomicWrite(this.indexPath, indexPayload);
      }
      if (legacyPayload !== null) {
        await atomicWrite(this.legacyPath, legacyPayload);
      }
    } catch {
      // Best-effort persistence; re-mark dirty AND reschedule so retry
      // doesn't depend on a future mutation to fire.
      if (writeIndex) this.indexDirty = true;
      if (writeLegacy) this.legacyDirty = true;
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueuePersist();
    }, MemoryStore.FLUSH_DEBOUNCE_MS);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  private renderLegacy(): string {
    const workspaceName = path.basename(this.workspacePath);
    const lines: string[] = [`# ${workspaceName} -- Project Memory\n`];

    const byType = new Map<MemoryType, MemoryEntry[]>();
    for (const entry of this.index.entries) {
      const list = byType.get(entry.type) || [];
      list.push(entry);
      byType.set(entry.type, list);
    }

    const typeLabels: Record<MemoryType, string> = {
      fact: 'Facts',
      preference: 'Preferences',
      lesson: 'Lessons Learned',
      decision: 'Decisions',
      context: 'Context',
    };

    // Iterate in fixed type order so section ordering is stable across
    // writes (otherwise diff churn whenever a new type appears first).
    for (const type of Object.keys(typeLabels) as MemoryType[]) {
      const entries = byType.get(type);
      if (!entries || entries.length === 0) continue;
      lines.push(`## ${typeLabels[type]}\n`);
      const recent = [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
      for (const entry of recent) {
        lines.push(`- ${entry.label}: ${entry.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, target);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function truncateToTokens(text: string, maxTokens: number): string {
  // ~4 chars per token; leave room for the ellipsis.
  const maxChars = maxTokens * 4;
  return truncate(text, maxChars);
}

// ── Search helpers ─────────────────────────────────────────────────

// Minimal English stop-word list — enough to keep BM25 IDF honest without
// pulling in a full NLP dep.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to',
  'was', 'were', 'will', 'with',
]);

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    // Split on anything that isn't a word/identifier char; keep `_` and `-`
    // so file paths and kebab/snake identifiers survive as single tokens.
    .split(/[^a-z0-9_\-]+/i)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function termFreq(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  let sum = 0;
  for (const n of nums) sum += n;
  return sum / nums.length;
}

/**
 * Multiplier applied to BM25 scores during search. Higher = more likely to
 * be selected for prompt injection.
 *
 *  - `user` (explicit /memory add) and `team` (team decisions) are the most
 *    intentional signals, so they outrank auto-extracted entries.
 *  - `auto` heuristic extractions are deliberately under-weighted; they're
 *    cheap to produce and noisy.
 */
/**
 * Visibility predicate. `forWorker === undefined` means main-chat context —
 * the chat is the orchestrator and is allowed to see every entry. When a
 * specific worker is running we hide entries scoped to other workers.
 */
function isVisibleTo(entry: MemoryEntry, forWorker: string | undefined): boolean {
  if (forWorker === undefined) return true;
  const scope = entry.scope;
  if (!scope || scope === 'workspace') return true;
  if (typeof scope === 'object') {
    if ('worker' in scope) return scope.worker === forWorker;
    if ('workers' in scope) return scope.workers.includes(forWorker);
  }
  return true;
}

function sourceWeight(source: string): number {
  switch (source) {
    case 'user-global': return 1.6;
    case 'user': return 1.5;
    case 'team': return 1.3;
    case 'planner': return 1.2;
    case 'migration': return 1.0;
    case 'auto': return 0.7;
    default: return 1.0;
  }
}

function dedupHash(type: MemoryType, content: string): string {
  // Normalize: lowercase + collapse whitespace. Catches near-duplicates
  // like the same auto-extracted lesson with slightly different spacing.
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${type}:${normalized}`).digest('hex');
}
