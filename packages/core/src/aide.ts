import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { extractJsonObject } from './advisor';

/**
 * Aide — a lightweight global role for housekeeping LLM calls (summarization,
 * title generation, classification). Configured separately from the user's
 * primary coding agent so a cheap fast model (e.g. Haiku) can be pinned for
 * these tasks while the main chat continues to use Opus/Sonnet/etc.
 *
 * This module is the agent-agnostic plumbing. Task-specific prompts live in
 * `aide-tasks.ts`.
 */

export type AideRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface AideOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: AideRunner;
  /** Hard timeout per attempt in ms. Default 30_000. */
  timeoutMs?: number;
  /** Extra attempts after the first, for transient failures only. Default 0,
   *  so existing callers are unaffected. */
  retries?: number;
  /** Delay between attempts in ms. Default 1_000. */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Configuration failures: a second attempt fails identically, so retrying
 *  only doubles the wait before the user sees the real problem. Rate limiting
 *  (429) is deliberately excluded — it IS transient and should retry. */
const CONFIG_ERROR = /\b40[123]\b|payment required|unknown model|invalid model|model not found|invalid api key|unauthorized/i;

export function isConfigError(message: string): boolean {
  return CONFIG_ERROR.test(message);
}

/** Marks output that reached us but wasn't JSON — transient in practice, so
 *  runAideJson retries it instead of giving up on the first bad completion. */
class UnparseableAideJson extends Error {
  constructor() { super('Aide returned unparseable JSON'); this.name = 'UnparseableAideJson'; }
}

/** Abort-aware backoff: a caller who cancels mid-gap should not have to wait
 *  out the timer before their rejection surfaces. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>(res => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); res(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function withRetries<T>(opts: AideOptions, attempt: () => Promise<T>): Promise<T> {
  const total = Math.max(0, opts.retries ?? 0) + 1;
  let lastErr: unknown;
  for (let i = 0; i < total; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (i === total - 1) break;
      if (opts.signal?.aborted) break;
      if (isConfigError((err as Error)?.message ?? '')) break;
      await delay(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, opts.signal);
      if (opts.signal?.aborted) break;
    }
  }
  throw lastErr;
}

/** One attempt: the timeout is per-attempt, so a retry gets a full budget. */
async function runOnce(prompt: string, opts: AideOptions): Promise<string> {
  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await opts.runner({
      prompt,
      agent: opts.agent,
      model: opts.model,
      signal: ac.signal,
    });
    if (!res.success) throw new Error(res.error ?? 'aide runner returned non-success');
    return (res.output ?? '').trim();
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort);
  }
}

/** Run a one-shot prompt through the configured Aide. Returns trimmed output, or throws. */
export async function runAide(prompt: string, opts: AideOptions): Promise<string> {
  return withRetries(opts, () => runOnce(prompt, opts));
}

/** JSON variant — runs the prompt, then extracts and parses the first balanced
 *  object. Unparseable output is retried like any other transient failure;
 *  null is returned only after the last attempt. */
export async function runAideJson<T = unknown>(prompt: string, opts: AideOptions): Promise<T | null> {
  try {
    return await withRetries(opts, async () => {
      const txt = await runOnce(prompt, opts);
      const parsed = extractJsonObject(txt) as T | null;
      if (parsed === null) throw new UnparseableAideJson();
      return parsed;
    });
  } catch (err) {
    if (err instanceof UnparseableAideJson) return null;
    throw err;
  }
}
