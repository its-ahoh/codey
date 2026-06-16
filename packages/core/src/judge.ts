import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { extractJsonObject } from './advisor';

export interface JudgeEdge {
  id: string;
  condition?: string;
  /** Worker name of the target node, or a label like "(end)". */
  targetWorker: string;
}

export interface JudgeInput {
  task: string;
  worker: string;
  workerOutput: string;
  blackboardSummary: string;
  /** Diamond decision question; when set, the judge answers it yes/no over the edges. */
  question?: string;
  edges: JudgeEdge[];
}

export interface JudgeDecision {
  edgeId: string | null;
  reason: string;
  fallback: boolean;
  fallbackReason?: string;
}

export type JudgeRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface JudgeOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: JudgeRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildJudgePrompt(input: JudgeInput): string {
  const lines: string[] = [];
  lines.push('# Flow Judge');
  lines.push('## Role');
  lines.push(
    'You route a sequential worker team along a fixed graph. You never write code. ' +
    'Given the worker that just finished, its output, and the list of outgoing edges, ' +
    'choose exactly one edge to follow. Each edge has a natural-language condition; ' +
    'pick the edge whose condition the output best satisfies. If none clearly match, ' +
    'pick the edge marked as the default target.',
  );
  lines.push('## Task');
  lines.push(input.task);
  if (input.blackboardSummary.trim()) {
    lines.push('## Shared notes');
    lines.push(input.blackboardSummary.trim());
  }
  lines.push(`## Worker just finished: ${input.worker}`);
  lines.push('## Worker output');
  lines.push(input.workerOutput || '(empty)');
  if (input.question && input.question.trim()) {
    lines.push('## Decision');
    lines.push(`Answer this yes/no question about the latest output, then pick the matching edge: ${input.question.trim()}`);
  }
  lines.push('## Outgoing edges (choose one)');
  for (const e of input.edges) {
    lines.push(`- id="${e.id}" → ${e.targetWorker}: ${e.condition ? `if ${e.condition}` : '(default)'}`);
  }
  lines.push('## Output format');
  lines.push('Reply with ONLY a JSON object: {"edge_id":"<one of the ids above>","reason":"<one short sentence>"}');
  return lines.join('\n\n');
}

function fallback(reason: string): JudgeDecision {
  return { edgeId: null, reason: '', fallback: true, fallbackReason: reason };
}

export async function runJudge(input: JudgeInput, opts: JudgeOptions): Promise<JudgeDecision> {
  if (input.edges.length === 0) return fallback('no outgoing edges');

  const prompt = buildJudgePrompt(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: AgentResponse;
  try {
    response = await opts.runner({ prompt, agent: opts.agent, model: opts.model, signal: ac.signal });
  } catch (err) {
    return fallback(`runner threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  if (!response.success) return fallback(response.error || 'runner returned non-success');

  const obj = extractJsonObject(response.output) as { edge_id?: unknown; reason?: unknown } | null;
  if (!obj || typeof obj.edge_id !== 'string') return fallback('could not parse judge JSON');
  const edgeId = obj.edge_id;
  if (!input.edges.some(e => e.id === edgeId)) return fallback(`judge chose unknown edge "${edgeId}"`);
  return {
    edgeId,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    fallback: false,
  };
}
