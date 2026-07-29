// packages/core/src/agents/tool-events.ts
//
// Shared normalization for the tool activity CLIs report, so every adapter
// feeds the same two consumers the same way:
//
//   request.onStatus(...)  — the chat/Mac surface's live tool timeline
//   AgentResponse.states   — the channel surface, via ContextManager.extractMeta
//
// Adapters differ in both vocabulary and timing. claude-code reports a tool
// twice ('running' then 'done'); opencode and codex report it once, already
// finished ('completed' / 'failed'). Downstream consumers key a run's
// procedure off START events, so a report that only ever arrives at the end
// must still produce one — otherwise the run looks like it did nothing.

import { AgentStateEntry, StatusUpdate } from '../types';

export type ToolPhase = 'start' | 'end';

const START_STATUSES = new Set(['running', 'pending', 'in_progress', 'started', 'start', 'active']);
const END_STATUSES = new Set([
  'done', 'completed', 'complete', 'success', 'succeeded', 'ok',
  'failed', 'failure', 'error', 'cancelled', 'canceled', 'aborted',
]);

/** Map a CLI's status word onto a phase, or null when it means nothing to us.
 *  Unknown words are treated as terminal: a tool we heard about exactly once
 *  is more likely finished than perpetually running. */
export function toolPhaseOf(status?: string): ToolPhase | null {
  if (!status) return null;
  const normalized = status.toLowerCase().trim();
  if (START_STATUSES.has(normalized)) return 'start';
  if (END_STATUSES.has(normalized)) return 'end';
  return 'end';
}

/** True for statuses that report the tool did not succeed. */
export function isFailureStatus(status?: string): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().trim();
  return normalized.startsWith('fail') || normalized === 'error'
    || normalized === 'cancelled' || normalized === 'canceled' || normalized === 'aborted';
}

function summarizeInput(input?: Record<string, unknown>): string {
  if (!input) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = String(value);
    parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
    if (parts.length >= 2) break;
  }
  return parts.join(', ');
}

export interface ObservedToolEvent {
  tool: string;
  /** Explicit phase when the event name carries it (codex item.started /
   *  item.completed). Omit to derive it from `status`. */
  phase?: ToolPhase;
  status?: string;
  /** Stable id for pairing start with end. Falls back to the tool name. */
  key?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

/** Collects a run's tool activity into the shapes the rest of the gateway
 *  expects. `states` carries normalized 'running'/'done' statuses so
 *  ContextManager.extractMeta can pair them without knowing any CLI's dialect. */
export class ToolCallCollector {
  readonly states: AgentStateEntry[] = [];
  readonly statusUpdates: string[] = [];
  private open = new Set<string>();

  constructor(private readonly onStatus?: (update: StatusUpdate) => void) {}

  record(event: ObservedToolEvent): void {
    const key = event.key ?? event.tool;
    const phase = event.phase ?? toolPhaseOf(event.status) ?? 'end';

    if (phase === 'start') {
      if (this.open.has(key)) return; // duplicate start — one call, not two
      this.open.add(key);
      this.emitStart(event);
      return;
    }

    // Terminal event. Synthesize the start we never saw, so a CLI that only
    // reports finished tools still contributes a procedure.
    if (!this.open.has(key)) this.emitStart(event);
    this.open.delete(key);

    const output = typeof event.output === 'string'
      ? event.output
      : event.output !== undefined ? JSON.stringify(event.output) : undefined;
    this.states.push({ source: event.tool, status: 'done', input: event.input, output: event.output });
    if (event.status) this.statusUpdates.push(`${event.tool}: ${event.status}`);
    this.onStatus?.({
      type: 'tool_end',
      tool: event.tool,
      message: isFailureStatus(event.status) ? `${event.tool} failed` : event.tool,
      ...(output !== undefined ? { output: output.slice(0, 500) } : {}),
    });
  }

  private emitStart(event: ObservedToolEvent): void {
    const summary = summarizeInput(event.input);
    this.states.push({ source: event.tool, status: 'running', input: event.input });
    this.onStatus?.({
      type: 'tool_start',
      tool: event.tool,
      message: summary ? `${event.tool}(${summary})` : event.tool,
      ...(event.input ? { input: event.input } : {}),
    });
  }

  /** Close out anything still open when the process exits. */
  finish(): void {
    for (const key of this.open) {
      this.states.push({ source: key, status: 'done' });
    }
    this.open.clear();
  }
}
