/**
 * Structured Context Manager
 *
 * Replaces the primitive text-concatenation approach with a structured
 * conversation history that preserves tool calls, file changes, errors,
 * and summaries. Handles context window limits via compression.
 */
import * as fs from 'fs';
import * as path from 'path';

// ── Structured turn types ──────────────────────────────────────────

export interface ContextTurn {
  id: string;
  role: 'user' | 'assistant';
  timestamp: number;
  /** The user prompt or assistant final text */
  text: string;
  /** Structured metadata only present on assistant turns */
  meta?: TurnMeta;
  /** Compressed summary replacing the full text after compaction */
  summary?: string;
  /** Token estimate for budget tracking */
  tokenEstimate: number;
}

export interface TurnMeta {
  toolCalls?: ToolCallRecord[];
  filesChanged?: FileChangeRecord[];
  errors?: string[];
  tokensUsed?: { input: number; output: number; total: number };
  duration?: number;
  agent?: string;
}

export interface ToolCallRecord {
  tool: string;
  input?: Record<string, unknown>;
  output?: string;        // truncated to 500 chars
  status: 'success' | 'error';
}

export interface FileChangeRecord {
  path: string;
  action: 'create' | 'edit' | 'delete' | 'read';
}

// ── Context Window ─────────────────────────────────────────────────

export interface ContextWindow {
  id: string;
  userId: string;
  channel: string;
  turns: ContextTurn[];
  lastActive: number;
  /** Running estimate of total tokens in the window */
  totalTokens: number;
}

// ── Configuration ──────────────────────────────────────────────────

export interface ContextConfig {
  /** Max estimated tokens before compaction kicks in (default 12000) */
  maxTokenBudget: number;
  /** Max number of turns to keep (default 30) */
  maxTurns: number;
  /** TTL in ms (default 60 minutes) */
  ttlMs: number;
  /** Directory for persisting context snapshots (optional) */
  persistDir?: string;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxTokenBudget: 12000,
  maxTurns: 30,
  ttlMs: 60 * 60 * 1000,
};

// ── Rough token estimator ──────────────────────────────────────────

function estimateTokens(text: string): number {
  // ~4 chars per token is a reasonable approximation
  return Math.ceil(text.length / 4);
}

// ── Context Manager ────────────────────────────────────────────────

export class ContextManager {
  private windows: Map<string, ContextWindow> = new Map();
  private config: ContextConfig;
  private turnCounter = 0;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── CRUD ───────────────────────────────────────────────────────

  getOrCreate(userId: string, channel: string, existingId?: string): ContextWindow {
    if (existingId) {
      const existing = this.windows.get(existingId);
      if (existing && existing.userId === userId && existing.channel === channel) {
        if (Date.now() - existing.lastActive <= this.config.ttlMs) {
          existing.lastActive = Date.now();
          return existing;
        }
        // Expired — archive and create new
        this.archive(existing);
        this.windows.delete(existingId);
      }
    }

    const id = `${userId}-${channel}-${Date.now()}`;
    const window: ContextWindow = {
      id,
      userId,
      channel,
      turns: [],
      lastActive: Date.now(),
      totalTokens: 0,
    };
    this.windows.set(id, window);
    return window;
  }

  clear(id: string): void {
    const window = this.windows.get(id);
    if (window) this.archive(window);
    this.windows.delete(id);
  }

  // ── Add turns ──────────────────────────────────────────────────

  addUserTurn(windowId: string, text: string): void {
    const window = this.windows.get(windowId);
    if (!window) return;

    const tokenEstimate = estimateTokens(text);
    window.turns.push({
      id: `turn-${++this.turnCounter}`,
      role: 'user',
      timestamp: Date.now(),
      text,
      tokenEstimate,
    });
    window.totalTokens += tokenEstimate;
    window.lastActive = Date.now();

    this.compact(window);
  }

  addAssistantTurn(windowId: string, text: string, meta?: TurnMeta): void {
    const window = this.windows.get(windowId);
    if (!window) return;

    const tokenEstimate = estimateTokens(text);
    window.turns.push({
      id: `turn-${++this.turnCounter}`,
      role: 'assistant',
      timestamp: Date.now(),
      text,
      meta,
      tokenEstimate,
    });
    window.totalTokens += tokenEstimate;
    window.lastActive = Date.now();

    this.compact(window);
  }

  // ── Build the prompt context string ────────────────────────────

  /**
   * Build a structured context string to prepend to the current prompt.
   * This is what gets sent to the CLI agent as part of the -p argument.
   */
  buildPrompt(windowId: string, currentPrompt: string, workspaceMemory?: string): string {
    const window = this.windows.get(windowId);
    if (!window || window.turns.length === 0) {
      if (workspaceMemory) {
        return `${workspaceMemory}\n\n${currentPrompt}`;
      }
      return currentPrompt;
    }

    const sections: string[] = [];

    // Workspace memory at the top if available
    if (workspaceMemory) {
      sections.push(workspaceMemory);
    }

    // Build conversation context
    sections.push('## Conversation History');

    for (const turn of window.turns) {
      const displayText = turn.summary || turn.text;

      if (turn.role === 'user') {
        sections.push(`**User:** ${displayText}`);
      } else {
        const parts: string[] = [`**Assistant:** ${displayText}`];

        // Include structured metadata in a compact format
        if (turn.meta?.toolCalls && turn.meta.toolCalls.length > 0) {
          const tools = turn.meta.toolCalls
            .map(tc => `  - ${tc.tool}: ${tc.status}${tc.output ? ` (${tc.output.substring(0, 100)})` : ''}`)
            .join('\n');
          parts.push(`  _Tools used:_\n${tools}`);
        }

        if (turn.meta?.filesChanged && turn.meta.filesChanged.length > 0) {
          const files = turn.meta.filesChanged
            .map(fc => `  - ${fc.action}: ${fc.path}`)
            .join('\n');
          parts.push(`  _Files:_\n${files}`);
        }

        if (turn.meta?.errors && turn.meta.errors.length > 0) {
          parts.push(`  _Errors:_ ${turn.meta.errors.join('; ')}`);
        }

        sections.push(parts.join('\n'));
      }
    }

    sections.push(`## Current Request\n${currentPrompt}`);
    return sections.join('\n\n');
  }

  // ── Compaction ─────────────────────────────────────────────────

  /**
   * Compress older turns when the context window exceeds budget.
   * Strategy: summarize the oldest half of turns into a single summary turn.
   */
  private compact(window: ContextWindow): void {
    // Enforce turn limit
    while (window.turns.length > this.config.maxTurns) {
      const removed = window.turns.shift();
      if (removed) window.totalTokens -= removed.tokenEstimate;
    }

    // Token budget compaction
    if (window.totalTokens > this.config.maxTokenBudget && window.turns.length > 4) {
      const halfIdx = Math.floor(window.turns.length / 2);
      const oldTurns = window.turns.slice(0, halfIdx);
      const newTurns = window.turns.slice(halfIdx);

      // Create a summary of the old turns
      const summary = this.summarizeTurns(oldTurns);
      const summaryTokens = estimateTokens(summary);

      // Replace old turns with a single summary turn
      const summaryTurn: ContextTurn = {
        id: `summary-${Date.now()}`,
        role: 'assistant',
        timestamp: oldTurns[0].timestamp,
        text: '',
        summary,
        tokenEstimate: summaryTokens,
      };

      const removedTokens = oldTurns.reduce((sum, t) => sum + t.tokenEstimate, 0);
      window.turns = [summaryTurn, ...newTurns];
      window.totalTokens = window.totalTokens - removedTokens + summaryTokens;
    }
  }

  /**
   * Create a compact summary of turns. This is a local heuristic —
   * not an LLM call — to keep it fast and free.
   */
  private summarizeTurns(turns: ContextTurn[]): string {
    const parts: string[] = ['[Earlier conversation summary]'];

    // Extract key topics discussed
    const userMessages = turns.filter(t => t.role === 'user').map(t => t.summary || t.text);
    if (userMessages.length > 0) {
      parts.push(`User asked about: ${userMessages.map(m => m.substring(0, 80)).join('; ')}`);
    }

    // Extract all tools used
    const allTools = new Set<string>();
    const allFiles = new Set<string>();
    const allErrors: string[] = [];

    for (const turn of turns) {
      if (turn.meta?.toolCalls) {
        for (const tc of turn.meta.toolCalls) allTools.add(tc.tool);
      }
      if (turn.meta?.filesChanged) {
        for (const fc of turn.meta.filesChanged) allFiles.add(`${fc.action}:${fc.path}`);
      }
      if (turn.meta?.errors) {
        allErrors.push(...turn.meta.errors);
      }
    }

    if (allTools.size > 0) {
      parts.push(`Tools used: ${Array.from(allTools).join(', ')}`);
    }
    if (allFiles.size > 0) {
      parts.push(`Files touched: ${Array.from(allFiles).join(', ')}`);
    }
    if (allErrors.length > 0) {
      parts.push(`Errors encountered: ${allErrors.slice(0, 3).join('; ')}`);
    }

    return parts.join('\n');
  }

  // ── Persistence ────────────────────────────────────────────────

  private archive(window: ContextWindow): void {
    if (!this.config.persistDir) return;

    try {
      const archiveDir = path.join(this.config.persistDir, 'context-archive');
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }

      const filename = `${window.id}.json`;
      const data = {
        id: window.id,
        userId: window.userId,
        channel: window.channel,
        turns: window.turns,
        archivedAt: Date.now(),
      };
      fs.writeFileSync(path.join(archiveDir, filename), JSON.stringify(data, null, 2));
    } catch {
      // Silently fail — archiving is best-effort
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────

  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, window] of this.windows) {
      if (now - window.lastActive > this.config.ttlMs) {
        this.archive(window);
        this.windows.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  // ── Extract metadata from AgentResponse ────────────────────────

  /**
   * Parse an AgentResponse into structured TurnMeta.
   * Works uniformly across all agents.
   */
  static extractMeta(response: {
    states?: Array<{ source: string; status?: string; input?: Record<string, unknown>; output?: unknown }>;
    tokens?: { input: number; output: number; total: number };
    duration?: number;
  }, agent?: string): TurnMeta {
    const meta: TurnMeta = { agent };

    // Extract tool calls from states
    if (response.states && response.states.length > 0) {
      const toolCalls: ToolCallRecord[] = [];
      const filesChanged: FileChangeRecord[] = [];

      // Group by tool call pairs (running -> done)
      const seen = new Map<string, ToolCallRecord>();
      for (const state of response.states) {
        if (state.status === 'running') {
          seen.set(state.source, {
            tool: state.source,
            input: state.input,
            status: 'success',
          });
        } else if (state.status === 'done') {
          const record = seen.get(state.source) || { tool: state.source, status: 'success' as const };
          if (state.output) {
            record.output = typeof state.output === 'string'
              ? state.output.substring(0, 500)
              : JSON.stringify(state.output).substring(0, 500);
          }
          toolCalls.push(record);
          seen.delete(state.source);

          // Detect file changes from tool names
          const fileTools = ['Write', 'Edit', 'Create', 'Delete', 'Read', 'write', 'edit', 'create', 'delete', 'read'];
          if (fileTools.some(ft => state.source.toLowerCase().includes(ft.toLowerCase()))) {
            const filePath = state.input?.file_path || state.input?.path || state.input?.file;
            if (filePath && typeof filePath === 'string') {
              const action = state.source.toLowerCase().includes('read') ? 'read'
                : state.source.toLowerCase().includes('delete') ? 'delete'
                : state.source.toLowerCase().includes('create') || state.source.toLowerCase().includes('write') ? 'create'
                : 'edit';
              filesChanged.push({ path: filePath, action });
            }
          }
        }
      }

      // Add any still-pending (no done event)
      for (const record of seen.values()) {
        record.status = 'error';
        toolCalls.push(record);
      }

      if (toolCalls.length > 0) meta.toolCalls = toolCalls;
      if (filesChanged.length > 0) meta.filesChanged = filesChanged;
    }

    if (response.tokens) {
      meta.tokensUsed = response.tokens;
    }
    if (response.duration) {
      meta.duration = response.duration;
    }

    return meta;
  }
}
