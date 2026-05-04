import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { DISPATCHER_PERSONALITY } from './dispatcher-personality';

export interface DispatchMember {
  name: string;
  hint: string;
}

export interface DispatchInput {
  task: string;
  members: DispatchMember[];
}

export interface DispatchResult {
  /** Subset of input member names, sorted to match members' input order. */
  selected: string[];
  /** One-sentence explanation surfaced to the user. */
  reason: string;
  /** True when dispatcher failed and the caller should run all members. */
  fallback: boolean;
  /** Optional human-readable detail about the fallback cause. */
  fallbackReason?: string;
}

export type DispatcherRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface DispatcherOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: DispatcherRunner;
  /** Hard timeout in ms. Default 30_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildDispatcherPrompt(input: DispatchInput): string {
  const lines: string[] = [];
  lines.push('# Dispatcher');
  lines.push('## Role');
  lines.push(DISPATCHER_PERSONALITY.role);
  lines.push('## Instructions');
  lines.push(DISPATCHER_PERSONALITY.instructions);
  lines.push('## Task');
  lines.push(input.task);
  lines.push('## Workers');
  for (const m of input.members) {
    lines.push(`- ${m.name}: ${m.hint || '(no description)'}`);
  }
  return lines.join('\n\n');
}

/**
 * Extract the first balanced {...} object from a string and JSON.parse it.
 * Tolerates leading/trailing prose, markdown fences, and nested objects.
 * Returns null if no parseable object is found.
 */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every(x => typeof x === 'string')) return null;
  return v as string[];
}

export async function runDispatcher(
  input: DispatchInput,
  opts: DispatcherOptions,
): Promise<DispatchResult> {
  const memberNames = input.members.map(m => m.name);
  const allFallback = (reason: string): DispatchResult => ({
    selected: memberNames,
    reason: '',
    fallback: true,
    fallbackReason: reason,
  });

  if (input.members.length === 0) {
    return { selected: [], reason: '', fallback: false };
  }

  const prompt = buildDispatcherPrompt(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Compose AbortSignal that fires on either user signal or our timeout.
  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: AgentResponse;
  try {
    response = await opts.runner({
      prompt,
      agent: opts.agent,
      model: opts.model,
      signal: ac.signal,
    });
  } catch (err) {
    return allFallback(`runner threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort);
  }

  if (!response.success) {
    return allFallback(response.error || 'runner returned non-success');
  }

  const obj = extractJsonObject(response.output) as { selected?: unknown; reason?: unknown } | null;
  if (!obj) return allFallback('no JSON object in dispatcher output');

  const selectedRaw = asStringArray(obj.selected);
  if (!selectedRaw) return allFallback('selected is not a string array');

  // Filter unknown names; preserve input order.
  const known = new Set(memberNames);
  const filtered = selectedRaw.filter(n => known.has(n));
  if (filtered.length === 0) return allFallback('selection empty after filtering unknowns');

  // Reorder to match input order so callers' carry-chain semantics are preserved.
  const indexOf = new Map(memberNames.map((n, i) => [n, i]));
  const ordered = Array.from(new Set(filtered)).sort(
    (a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0),
  );

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  return { selected: ordered, reason, fallback: false };
}
