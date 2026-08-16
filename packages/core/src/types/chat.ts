import { ChatRoute } from './route';
import { PendingTeamState } from './pending-team';
import type { CodingAgent, ThinkingEffort } from './index';

/** The three CLIs report task lists in three shapes; the adapters normalize
 *  onto this one. codex has only a completed boolean, so it never produces
 *  'in_progress' — a list with no in-progress item means "not stated", not
 *  "nothing is running". */
export type ChecklistStatus = 'pending' | 'in_progress' | 'completed';

export interface ChecklistItem {
  text: string;
  status: ChecklistStatus;
  /** claude-code's present-tense phrasing of the same item ("Implementing the
   *  reducer"), written by the model for exactly this display. The other two
   *  agents supply only the imperative text. */
  activeForm?: string;
}

export interface FileAttachment {
  id: string;
  name: string;        // original filename
  path: string;        // absolute path on disk after save
  mimeType: string;    // e.g. "image/png", "text/typescript"
  size: number;        // bytes
}

export interface ToolCallEntry {
  id: string;
  type: 'tool_start' | 'tool_end' | 'info';
  tool?: string;
  message: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface TeamRunSummaryEntry {
  worker: string;
  step: number;
  text: string;
}

export interface TeamRunSummary {
  completed: TeamRunSummaryEntry[];
  failures: TeamRunSummaryEntry[];
  nextUserActions: TeamRunSummaryEntry[];
  finalizedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: FileAttachment[];
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
  /** Total tokens for the assistant response, set when the turn completes. */
  tokens?: number;
  /** Wall-clock seconds the agent took to produce the response. */
  durationSec?: number;
  /** Agent/model that produced this assistant message. Stored per turn so
   * historical labels remain accurate after the chat configuration changes. */
  agent?: CodingAgent;
  model?: string;
  /**
   * Present when this turn was produced by a fallback agent after the primary
   * failed. Rendered as a warning affordance next to the turn's identity.
   * `from`/`to` are display labels like "claude-code(opus)"; `reason` is the
   * primary's failure text, shown on demand.
   */
  fallback?: { from: string; to: string; reason?: string };
  /** Extended-thinking for a single-agent assistant message (collapsed in UI). */
  thinking?: string;
  /** Per-team-step extended-thinking, keyed by step number. */
  thinkingByStep?: Record<number, string>;
  /** Groups the per-worker messages of one team run. Absent on single-agent
   *  turns and on legacy combined team turns (which use the parseTeamMessage
   *  fallback renderer). */
  teamTurnId?: string;
  /** Team name for a worker message (for the group header). */
  teamName?: string;
  /** Dispatch mode of the owning team run. */
  teamMode?: 'sequential' | 'graph' | 'auto' | 'parallel';
  /** 1-based step / run index of this worker within the team run. */
  step?: number;
  /** Worker name that produced this message. */
  worker?: string;
  /** Live status of this worker's run. */
  workerStatus?: 'running' | 'done' | 'failed' | 'askedUser';
  /** Advisor's routing reason, shown as a caption on the bubble. */
  advisorReason?: string;
  /** Structured terminal error captured by the team orchestrator. */
  workerFailureReason?: string;
  /** Structured user action captured when a worker pauses for input. */
  workerNextUserAction?: { text: string; options?: string[] };
  /** A resolved pause marker; terminal but not itself a completed outcome. */
  workerSummaryExcluded?: boolean;
  /** Gateway-authored terminal aggregate for this teamTurnId. */
  teamSummary?: TeamRunSummary;
  /** Option labels when this assistant message ended in [ASK_USER:choice]. */
  choices?: string[];
  /** Structured question from AskUserQuestion tool call, with option descriptions. */
  userQuestion?: {
    question: string;
    options: Array<{ label: string; description?: string }>;
    /** When true, the question allows selecting multiple options at once. */
    multiSelect?: boolean;
  };
}

export type ChatSelection =
  | { type: 'none'; name?: string }
  | { type: 'worker'; name: string }
  /** `name` identifies which team to run. Optional only for backward compat with chats persisted before per-team selection landed; the UI always sets it. */
  | { type: 'team'; name?: string };

export type DiscussionStatus = 'running' | 'paused' | 'done' | 'terminated';
export type DiscussionTerminatedReason =
  | 'consensus'
  | 'drift'
  | 'timeout'
  | 'max_duration'
  | 'user_cancel'
  | 'advisor_error';

export interface DiscussionMeta {
  teamName: string;
  status: DiscussionStatus;
  startedAt: number;
  terminatedReason?: DiscussionTerminatedReason;
}

export interface Chat {
  id: string;
  title: string;
  workspaceName: string;
  /** 'automation' marks a hidden system chat owned by an automation; absent = normal user chat. */
  kind?: 'automation';
  selection: ChatSelection;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** Per-chat coding agent override. Falls back to gateway default when unset. */
  agent?: CodingAgent;
  /** Per-chat model override (model id from the global catalog). Falls back to the agent's default model when unset. */
  model?: string;
  /** Per-chat reasoning-effort override. Falls back to the worker's effort, then the agent's defaultEffort. */
  effort?: ThinkingEffort;
  /** Per-chat "solo advisor" backup toggle. When true and the chat is NOT a team,
   *  a stuck single agent (one that emits `[ASK_ADVISOR]: <reason>`) is escalated
   *  to the stronger advisor model for guidance, then re-run. Default off. */
  soloAdvisor?: boolean;
  /** Attached channel routes. Absent or empty means Mac-only. */
  routes?: ChatRoute[];
  /** Set while a /team run is paused waiting for the user to answer a worker's question. */
  pendingTeam?: PendingTeamState;
  /** Per-chat preference for the right-side context panel in codey-mac.
   *  undefined = user hasn't decided; auto-open logic applies on first tool call.
   *  true/false = explicit user choice; honored verbatim. */
  contextPanelOpen?: boolean;
  /** Per-chat working-directory override (absolute path). When set, the agent
   *  runs here instead of the workspace's workingDir — used to bind a chat to a
   *  git worktree. Cleared (deleted) to fall back to the workspace dir. */
  workingDirOverride?: string;
  /** Checkout currently used by this chat. Missing on legacy chats means the
   *  shared project checkout. */
  executionMode?: 'shared-checkout' | 'isolated-worktree';
  /** Stable filesystem environment owned by an isolated chat. The branch is
   *  deliberately not persisted: it is live Git state managed by the agent. */
  chatWorkspace?: {
    /** User-chosen, filesystem-safe name for this chat's worktree. */
    name?: string;
    repositoryRoot: string;
    worktreePath: string;
    workingDir: string;
    baseCommit: string;
    createdAt: number;
  };
  /** Pull request delivery state associated with this chat's current branch. */
  pullRequest?: {
    url: string;
    number?: number;
    state: 'pr-open' | 'merged' | 'merged-with-changes' | 'closed-unmerged';
    headBranch?: string;
    baseBranch?: string;
    headCommit?: string;
    mergedAt?: number;
    lastCheckedAt: number;
  };
  /** Last unanswered choice question in a non-team chat. Cleared on next user message. */
  lastAskedOptions?: { messageId: string; options: string[] };
  /** Set when the skill distiller has proposed a new skill and is waiting for
   *  the user's "yes" / "no" / "rename <name>" reply. Cleared on any resolution. */
  /** Mirrors DistillResult (skill-crystallizer). Inlined rather than imported
   *  so this type module stays dependency-free; `parameters`/`inducedFrom` are
   *  present only when the suggestion came from an induced template. */
  pendingSkillSuggestion?: {
    name: string;
    description: string;
    whenToUse: string;
    steps: string;
    parameters?: {
      name: string;
      /** Mirrors ArgShape['kind'] — kept literal so a drift shows up as a type
       *  error at the store.add call site rather than silently widening. */
      kind: 'url' | 'path' | 'enum' | 'text' | 'number' | 'bool' | 'other';
      ext?: string;
    }[];
    inducedFrom?: string[];
  };
  /** Warm CLI sessions retained independently for each agent/model identity. */
  sessionAnchors?: Array<{
    agent: CodingAgent;
    model?: string;
    sessionId: string;
    /** Last Codey transcript message already visible inside this CLI session. */
    syncedThroughMessageId?: string;
  }>;
  /** Legacy single-anchor field. Read for migration, never written by new code. */
  sessionAnchor?: {
    agent: CodingAgent;
    model?: string;
    sessionId: string;
    syncedThroughMessageId?: string;
  };
  /**
   * Rolling LLM-generated summary of older messages. When set, the bootstrap
   * prompt prepends `summary` and only renders the transcript tail starting at
   * `summarizedUpTo`. Produced asynchronously by the Aide after appendMessage
   * crosses a threshold; never blocks a user-visible turn.
   */
  compaction?: ChatCompaction;
  /** On-demand Task HUD summary. Generated by the Aide when the panel opens
   *  and the cached value is stale; never bumps Chat.updatedAt (see
   *  ChatManager.setTaskBrief) so staleness can compare updatedAt vs generatedAt. */
  taskBrief?: TaskBrief;
  /** The agent's own task list for the current turn, as last reported. Unlike
   *  taskBrief this is not inferred by an LLM — the agent stated it — so the
   *  status panel prefers it for progress. Cleared when a new turn starts. */
  checklist?: ChecklistItem[];
  /** Set when this chat is hosting a parallel-team (roundtable) discussion. */
  discussion?: DiscussionMeta;
}

export interface ChatCompaction {
  /** Summary text covering messages[0 .. summarizedUpTo - 1]. */
  summary: string;
  /** Exclusive end index — everything strictly before this is folded into `summary`. */
  summarizedUpTo: number;
  /** Model id used to produce the summary (for telemetry / future invalidation). */
  model: string;
  updatedAt: number;
}

export type TaskStatus = 'working' | 'waiting' | 'blocked' | 'done';

export type TaskEventKind = 'progress' | 'action' | 'decision' | 'dropped';

export interface TaskEvent {
  /** progress = a step forward, action = a concrete action taken,
   *  decision = a choice made (with rationale in `why`), dropped = an abandoned path. */
  kind: TaskEventKind;
  /** Headline, one line. */
  text: string;
  /** One-line rationale (decisions especially). */
  why?: string;
  /** Epoch ms if derivable. */
  when?: number;
  /** Sub-bullets — populated only for the newest entry (the resume view). */
  detail?: string[];
}

export interface TaskBrief {
  /** One-line task goal. */
  goal: string;
  state: {
    /** 0–100, best-effort. */
    progress: number;
    /** e.g. "step 3 / 5" or a phase name. */
    stepLabel?: string;
    status: TaskStatus;
  };
  nextAction?: {
    text: string;
    detail?: string;
    /** Which assistant message raised it (anchor for scroll/focus). */
    messageId?: string;
  };
  /** Reverse-chronological, newest first. */
  timeline: TaskEvent[];
  /** When the Aide produced this (epoch ms). */
  generatedAt: number;
  /** Terminal team turn summarized by the same Aide call, when applicable. */
  teamTurnId?: string;
}
