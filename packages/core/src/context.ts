/**
 * Structured Context Manager
 *
 * Replaces the primitive text-concatenation approach with a structured
 * conversation history that preserves tool calls, file changes, errors,
 * and summaries. Handles context window limits via compression.
 */
import * as fs from 'fs';
import * as path from 'path';
import { estimateTokens } from './utils/tokens';
import { toolPhaseOf } from './agents/tool-events';

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

/**
 * Tracks which agent CLI session is currently warm for this conversation.
 * When the gateway runs the same agent again it can `--resume <sessionId>`
 * and skip re-sending conversation history. Cleared on agent switch, on
 * `/clear`/`/reset`, or when a resume attempt fails.
 */
export interface SessionAnchor {
  agent: string;
  sessionId: string;
}

/**
 * Per-worker warm CLI session. Lets team / worker steps `--resume` an
 * existing session instead of re-sending personality + memory + blackboard
 * every turn. Keyed by worker name within a ContextWindow.
 */
export interface WorkerAnchor extends SessionAnchor {
  workerName: string;
  /** Index up to which this session has already seen blackboard entries.
   *  Next resume only sends the delta. */
  blackboardSeenCount: number;
  /** Wall-clock timestamp of when the session was bootstrapped — used by
   *  the gateway to TTL-invalidate stale sessions whose injected memory
   *  snapshot has likely drifted. */
  bootstrappedAt: number;
}

export interface ContextWindow {
  id: string;
  turns: ContextTurn[];
  lastActive: number;
  /** Running estimate of total tokens in the window */
  totalTokens: number;
  /** Warm CLI session for the main chat, if any. */
  sessionAnchor?: SessionAnchor;
  /** Warm CLI sessions for workers running in this conversation, by name. */
  workerAnchors?: Record<string, WorkerAnchor>;
  /** Lines written to the transcript sidecar so far. Line N holds the Nth turn
   *  this window ever saw — including turns already evicted from `turns`. */
  transcriptLines: number;
}

// ── Configuration ──────────────────────────────────────────────────

export interface ContextConfig {
  /** TTL in ms (default 60 minutes) */
  ttlMs: number;
  /** Directory for persisting context snapshots (optional) */
  persistDir?: string;
}

const DEFAULT_CONFIG: ContextConfig = {
  ttlMs: 60 * 60 * 1000,
};

/**
 * Above this many turns a prompt stops inlining history and hands over a
 * transcript cursor instead. Below it, inlining beats making the agent spend
 * a tool call on a handful of short turns.
 */
export const CONTEXT_INLINE_LIMIT = 20;

/** Recent turns kept inline even in pointer mode, so a self-contained
 *  follow-up can be answered without reading the transcript at all. */
export const CONTEXT_TAIL_INLINE = 4;

/**
 * Turns retained in memory per window. The sidecar holds every turn, so
 * evicting the head is lossless — it bounds RAM for a long-running
 * conversation without bounding what the agent can reach.
 */
export const CONTEXT_RETAINED_TURNS = 200;

// ── Context Manager ────────────────────────────────────────────────

export class ContextManager {
  private windows: Map<string, ContextWindow> = new Map();
  private config: ContextConfig;
  private turnCounter = 0;
  /** Per-window locks to serialize concurrent mutations */
  private locks: Map<string, Promise<void>> = new Map();

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Serialize access to a given window. Concurrent calls with the same
   * windowId are queued; calls with different IDs proceed in parallel.
   */
  private async withLock<T>(windowId: string, fn: () => T): Promise<T> {
    // Wait for the previous lock to release
    const prev = this.locks.get(windowId) || Promise.resolve();
    let release: () => void;
    const lock = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(windowId, lock);

    try {
      await prev;
      return fn();
    } finally {
      // Only delete our own entry: a later caller may have already queued a
      // new lock, and deleting it would let a fresh caller bypass the queue.
      if (this.locks.get(windowId) === lock) this.locks.delete(windowId);
      release!();
    }
  }

  /**
   * Start a window from zero. The sidecar is truncated with it: a window is
   * only ever recreated after the previous one expired or was cleared, and
   * leaving the old lines in place would silently desynchronise the cursor —
   * line N would no longer be turn N. The archived JSON snapshot keeps the
   * history that is being dropped here.
   */
  private createWindow(id: string): ContextWindow {
    const file = this.transcriptFile(id);
    if (file) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    }
    return { id, turns: [], lastActive: Date.now(), totalTokens: 0, transcriptLines: 0 };
  }

  // ── CRUD ───────────────────────────────────────────────────────

  async getOrCreate(conversationId: string): Promise<ContextWindow> {
    return this.withLock(conversationId, () => {
      const existing = this.windows.get(conversationId);
      if (existing) {
        if (Date.now() - existing.lastActive <= this.config.ttlMs) {
          existing.lastActive = Date.now();
          return existing;
        }
        // Expired — archive and create new
        this.archive(existing);
        this.windows.delete(conversationId);
      }

      const window = this.createWindow(conversationId);
      this.windows.set(conversationId, window);
      return window;
    });
  }

  getWindow(conversationId: string): ContextWindow | undefined {
    return this.windows.get(conversationId);
  }

  listConversationIds(): string[] {
    return Array.from(this.windows.keys());
  }

  async clear(id: string): Promise<void> {
    return this.withLock(id, () => {
      const window = this.windows.get(id);
      if (window) this.archive(window);
      this.windows.delete(id);
    });
  }

  // ── Session anchors ────────────────────────────────────────────

  async setSessionAnchor(windowId: string, anchor: SessionAnchor): Promise<void> {
    return this.withLock(windowId, () => {
      const window = this.windows.get(windowId);
      if (!window) return;
      window.sessionAnchor = anchor;
      window.lastActive = Date.now();
    });
  }

  async clearSessionAnchor(windowId: string): Promise<void> {
    return this.withLock(windowId, () => {
      const window = this.windows.get(windowId);
      if (!window) return;
      window.sessionAnchor = undefined;
    });
  }

  /**
   * Drop session anchors from every window. Called on global resets
   * (workspace switch, `/reset`, default-agent change) so the next turn
   * bootstraps a fresh CLI session with full history.
   */
  clearAllSessionAnchors(): void {
    for (const window of this.windows.values()) {
      window.sessionAnchor = undefined;
      window.workerAnchors = undefined;
    }
  }

  // ── Worker session anchors ─────────────────────────────────────

  getWorkerAnchor(windowId: string, workerName: string): WorkerAnchor | undefined {
    return this.windows.get(windowId)?.workerAnchors?.[workerName];
  }

  async setWorkerAnchor(windowId: string, workerName: string, anchor: WorkerAnchor): Promise<void> {
    return this.withLock(windowId, () => {
      let window = this.windows.get(windowId);
      if (!window) {
        window = this.createWindow(windowId);
        this.windows.set(windowId, window);
      }
      if (!window.workerAnchors) window.workerAnchors = {};
      window.workerAnchors[workerName] = anchor;
      window.lastActive = Date.now();
    });
  }

  async clearWorkerAnchor(windowId: string, workerName: string): Promise<void> {
    return this.withLock(windowId, () => {
      const window = this.windows.get(windowId);
      if (!window?.workerAnchors) return;
      delete window.workerAnchors[workerName];
    });
  }

  async clearAllWorkerAnchorsForWindow(windowId: string): Promise<void> {
    return this.withLock(windowId, () => {
      const window = this.windows.get(windowId);
      if (!window) return;
      window.workerAnchors = undefined;
    });
  }

  /** Drop a worker's anchors from every window. Use when the worker's
   *  personality or config changes and existing warm sessions are stale. */
  clearWorkerAnchorEverywhere(workerName: string): void {
    for (const window of this.windows.values()) {
      if (window.workerAnchors) delete window.workerAnchors[workerName];
    }
  }

  // ── Add turns ──────────────────────────────────────────────────

  async addUserTurn(windowId: string, text: string): Promise<void> {
    return this.withLock(windowId, () => {
      let window = this.windows.get(windowId);
      if (!window) {
        window = this.createWindow(windowId);
        this.windows.set(windowId, window);
      }

      const tokenEstimate = estimateTokens(text);
      const turn: ContextTurn = {
        id: `turn-${++this.turnCounter}`,
        role: 'user',
        timestamp: Date.now(),
        text,
        tokenEstimate,
      };
      window.turns.push(turn);
      window.totalTokens += tokenEstimate;
      window.lastActive = Date.now();

      this.recordTurn(window, turn);
    });
  }

  async addAssistantTurn(windowId: string, text: string, meta?: TurnMeta): Promise<void> {
    return this.withLock(windowId, () => {
      const window = this.windows.get(windowId);
      if (!window) return;

      const tokenEstimate = estimateTokens(text);
      const turn: ContextTurn = {
        id: `turn-${++this.turnCounter}`,
        role: 'assistant',
        timestamp: Date.now(),
        text,
        meta,
        tokenEstimate,
      };
      window.turns.push(turn);
      window.totalTokens += tokenEstimate;
      window.lastActive = Date.now();

      this.recordTurn(window, turn);
    });
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

    // Past the inline limit, hand over a cursor instead of the replay. Codey
    // owns the cursor — the CLI is a fresh process every turn and cannot be
    // asked to remember where it left off. A short tail stays inline so a
    // self-contained follow-up needs no tool round-trip at all.
    const transcript = this.transcriptFile(window.id);
    let inline = window.turns;
    if (transcript && window.turns.length > CONTEXT_INLINE_LIMIT) {
      const pointerLast = window.transcriptLines - CONTEXT_TAIL_INLINE;
      // The window only holds the retained tail; earlier lines exist on disk.
      const pointerFirst = window.transcriptLines - window.turns.length + 1;
      if (pointerLast >= pointerFirst) {
        sections.push([
          `## Earlier Conversation (${pointerLast - pointerFirst + 1} turns, not inlined)`,
          `Transcript: ${transcript}`,
          'One JSON object per line, one line per turn, oldest first.',
          `Lines ${pointerFirst}-${pointerLast} hold this history.`,
          `Read them before answering (e.g. \`sed -n '${pointerFirst},${pointerLast}p'\`) unless the current request below is fully self-contained.`,
          'Context only — do not repeat or fabricate turns.',
        ].join('\n'));
        inline = window.turns.slice(-CONTEXT_TAIL_INLINE);
      }
    }

    // Build conversation context
    sections.push('## Conversation History');

    for (const turn of inline) {
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

  // ── Transcript sidecar ─────────────────────────────────────────

  /**
   * Append-only transcript for a conversation: one JSON object per line, one
   * line per turn, line N == the Nth turn the window ever saw. `archive()`
   * rewrites its JSON snapshot wholesale, so that file's line offsets are not
   * stable; this file's are, which is what lets a prompt hand an agent a
   * `path:line` cursor instead of inlining the history.
   */
  private transcriptFile(windowId: string): string | undefined {
    if (!this.config.persistDir) return undefined;
    return path.resolve(
      path.join(this.config.persistDir, 'context-archive', `${windowId}.jsonl`),
    );
  }

  /** Absolute transcript path for a conversation, or undefined when the
   *  manager was built without a persist dir (tests, embedded use). */
  transcriptPath(windowId: string): string | undefined {
    return this.transcriptFile(windowId);
  }

  /** Lean projection — what a catching-up agent needs. Tool call payloads and
   *  token accounting are omitted: they dominate the byte count and add
   *  nothing to "what was said". */
  private transcriptLine(turn: ContextTurn): string {
    return JSON.stringify({
      id: turn.id,
      role: turn.role,
      timestamp: turn.timestamp,
      ...(turn.meta?.agent ? { agent: turn.meta.agent } : {}),
      ...(turn.meta?.toolCalls?.length
        ? { tools: turn.meta.toolCalls.map(tc => tc.tool) }
        : {}),
      ...(turn.meta?.filesChanged?.length
        ? { files: turn.meta.filesChanged.map(fc => `${fc.action}:${fc.path}`) }
        : {}),
      text: turn.summary || turn.text,
    });
  }

  /**
   * Persist a turn to the sidecar and evict the head of the in-memory window
   * once it outgrows the retention cap. Eviction is lossless: everything
   * evicted is still on disk and still reachable through the cursor.
   */
  private recordTurn(window: ContextWindow, turn: ContextTurn): void {
    const file = this.transcriptFile(window.id);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, this.transcriptLine(turn) + '\n');
      } catch {
        // Best-effort: a failed append costs the cursor a line, never the turn.
      }
    }
    window.transcriptLines += 1;

    while (window.turns.length > CONTEXT_RETAINED_TURNS) {
      const evicted = window.turns.shift();
      if (evicted) window.totalTokens -= evicted.tokenEstimate;
    }
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
        turns: window.turns,
        transcriptLines: window.transcriptLines,
        archivedAt: Date.now(),
      };
      fs.writeFileSync(path.join(archiveDir, filename), JSON.stringify(data, null, 2));
    } catch {
      // Silently fail — archiving is best-effort
    }
  }

  /**
   * Load archived context windows from disk. Called on gateway startup
   * to restore conversations that survived a previous process exit.
   */
  load(): number {
    if (!this.config.persistDir) return 0;

    const archiveDir = path.join(this.config.persistDir, 'context-archive');
    if (!fs.existsSync(archiveDir)) return 0;

    let loaded = 0;
    try {
      const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(archiveDir, file), 'utf-8');
          const data = JSON.parse(raw) as {
            id: string;
            turns: ContextTurn[];
            transcriptLines?: number;
            archivedAt: number;
          };

          // Skip if archived too long ago (TTL expired while offline)
          if (Date.now() - data.archivedAt > this.config.ttlMs) {
            fs.unlinkSync(path.join(archiveDir, file));
            continue;
          }

          const window: ContextWindow = {
            id: data.id,
            turns: data.turns || [],
            lastActive: data.archivedAt,
            totalTokens: (data.turns || []).reduce((sum, t) => sum + (t.tokenEstimate || 0), 0),
            // Snapshots written before the sidecar existed have no count; the
            // retained turns are all we can vouch for, so start the cursor there.
            transcriptLines: data.transcriptLines ?? (data.turns || []).length,
          };
          this.windows.set(window.id, window);
          fs.unlinkSync(path.join(archiveDir, file));
          loaded++;
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Skip if archive dir unreadable
    }
    return loaded;
  }

  /**
   * Archive all active windows and clear them. Called on gateway shutdown.
   */
  shutdown(): void {
    for (const window of this.windows.values()) {
      this.archive(window);
    }
    this.windows.clear();
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
        // Adapters normalize to running/done via ToolCallCollector, but tolerate
        // a CLI dialect leaking through ('completed', 'failed', ...) rather than
        // silently dropping the tool call.
        const phase = toolPhaseOf(state.status);
        if (phase === 'start') {
          seen.set(state.source, {
            tool: state.source,
            input: state.input,
            status: 'success',
          });
        } else if (phase === 'end') {
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
            // The path arrives with the START event; this is the END one, so
            // fall back to what the paired record already captured. Without
            // this, filesChanged stayed empty for every adapter that reports
            // arguments once, at the start.
            const args = state.input ?? record.input;
            const filePath = args?.file_path || args?.path || args?.file;
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
