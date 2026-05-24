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
  /** Hard timeout in ms. Default 30_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Run a one-shot prompt through the configured Aide. Returns trimmed output, or throws. */
export async function runAide(prompt: string, opts: AideOptions): Promise<string> {
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

/** JSON variant — runs the prompt, then extracts and parses the first balanced object. */
export async function runAideJson<T = unknown>(prompt: string, opts: AideOptions): Promise<T | null> {
  const txt = await runAide(prompt, opts);
  return extractJsonObject(txt) as T | null;
}
