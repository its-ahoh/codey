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
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────

export type MemoryType = 'fact' | 'preference' | 'lesson' | 'decision' | 'context';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  /** Short label for display */
  label: string;
  /** When this memory was created */
  createdAt: number;
  /** When this memory was last accessed or updated */
  updatedAt: number;
  /** How many times this memory was included in a prompt */
  accessCount: number;
  /** Tags for filtering */
  tags: string[];
  /** Source that created this memory (e.g. "auto", "user", "planner") */
  source: string;
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

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.memoryDir = path.join(workspacePath, 'memory');
    this.indexPath = path.join(this.memoryDir, 'index.json');
    this.legacyPath = path.join(workspacePath, 'memory.md');
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async load(): Promise<void> {
    // Ensure directory exists
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }

    // Load index
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        this.index = JSON.parse(data);
      } catch {
        this.index = { version: 1, entries: [] };
      }
    }

    // Migrate from legacy memory.md if index is empty
    if (this.index.entries.length === 0 && fs.existsSync(this.legacyPath)) {
      this.migrateFromLegacy();
    }
  }

  private migrateFromLegacy(): void {
    const content = fs.readFileSync(this.legacyPath, 'utf-8').trim();
    if (!content || content.startsWith('# ') && content.split('\n').length <= 1) {
      return; // Empty or just a header
    }

    // Import the whole legacy file as a single "context" memory
    this.add({
      type: 'context',
      content,
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
  }): MemoryEntry {
    const id = `mem-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const entry: MemoryEntry = {
      id,
      type: params.type,
      content: params.content,
      label: params.label,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      tags: params.tags || [],
      source: params.source || 'auto',
    };

    this.index.entries.push(entry);
    this.persist();
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

    this.persist();
    return true;
  }

  remove(id: string): boolean {
    const idx = this.index.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;

    this.index.entries.splice(idx, 1);
    this.persist();
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
   * Find memories matching a query string (simple keyword search).
   */
  search(query: string, limit: number = 10): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return this.index.entries.slice(0, limit);

    const scored = this.index.entries.map(entry => {
      const text = `${entry.label} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score++;
      }
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
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
   * Get the N most recently updated memories.
   */
  getRecent(limit: number = 10): MemoryEntry[] {
    return [...this.index.entries]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  // ── Build context string for prompts ───────────────────────────

  /**
   * Build a memory context block to include in agent prompts.
   * Selects the most relevant memories within a token budget.
   */
  buildContext(query?: string, maxTokens: number = 2000): string {
    let selected: MemoryEntry[];

    if (query) {
      // Use query-relevant memories + recent important ones
      const relevant = this.search(query, 8);
      const recent = this.getRecent(4);
      const ids = new Set(relevant.map(e => e.id));
      selected = [...relevant, ...recent.filter(e => !ids.has(e.id))];
    } else {
      // Use most recent memories
      selected = this.getRecent(12);
    }

    if (selected.length === 0) return '';

    // Track access
    for (const entry of selected) {
      entry.accessCount++;
      entry.updatedAt = Date.now();
    }
    this.persist();

    // Build context block within token budget
    const lines: string[] = ['## Project Memory'];
    let tokenCount = estimateTokens(lines[0]);

    for (const entry of selected) {
      const line = `- [${entry.type}] ${entry.label}: ${entry.content}`;
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

    // Remember significant file changes
    if (params.filesChanged && params.filesChanged.length > 0) {
      const nonReadChanges = params.filesChanged.filter(f => f.action !== 'read');
      if (nonReadChanges.length > 0) {
        const fileList = nonReadChanges.map(f => `${f.action}: ${f.path}`).join(', ');
        created.push(this.add({
          type: 'fact',
          content: `Files modified: ${fileList}`,
          label: `Changes from: "${params.userPrompt.substring(0, 60)}"`,
          tags: ['auto', 'file-change'],
          source: 'auto',
        }));
      }
    }

    // Remember if an error was resolved (user asked about error, agent succeeded)
    const errorKeywords = ['error', 'bug', 'fix', 'broken', 'fail', 'crash', 'issue'];
    const promptLower = params.userPrompt.toLowerCase();
    if (errorKeywords.some(kw => promptLower.includes(kw)) && params.agentOutput.length > 50) {
      // Extract a short lesson from the fix
      const outputPreview = params.agentOutput.substring(0, 200);
      created.push(this.add({
        type: 'lesson',
        content: `Fixed: "${params.userPrompt.substring(0, 80)}" -> ${outputPreview}`,
        label: 'Bug fix',
        tags: ['auto', 'bugfix'],
        source: 'auto',
      }));
    }

    // Prune auto-memories if we have too many (keep last 50)
    const autoMemories = this.index.entries.filter(e => e.source === 'auto');
    if (autoMemories.length > 50) {
      const toRemove = autoMemories
        .sort((a, b) => a.accessCount - b.accessCount || a.updatedAt - b.updatedAt)
        .slice(0, autoMemories.length - 50);
      for (const entry of toRemove) {
        this.remove(entry.id);
      }
    }

    return created;
  }

  // ── Persistence ────────────────────────────────────────────────

  private persist(): void {
    try {
      if (!fs.existsSync(this.memoryDir)) {
        fs.mkdirSync(this.memoryDir, { recursive: true });
      }

      // Write index
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));

      // Also update legacy memory.md for human readability
      this.updateLegacyFile();
    } catch {
      // Best-effort persistence
    }
  }

  private updateLegacyFile(): void {
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

    for (const [type, entries] of byType) {
      lines.push(`## ${typeLabels[type]}\n`);
      for (const entry of entries.slice(-10)) { // Last 10 per type
        lines.push(`- ${entry.label}: ${entry.content}`);
      }
      lines.push('');
    }

    fs.writeFileSync(this.legacyPath, lines.join('\n'));
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
