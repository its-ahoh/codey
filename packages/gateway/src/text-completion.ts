import { request } from 'undici';
import { ModelConfig } from '@codey/core';

/**
 * Minimal one-shot text completion against a hosted LLM API.
 *
 * This exists for short, tool-free text transforms (currently the voice
 * speech digest) where spawning a full agentic CLI is the wrong executor:
 * a cold `claude -p` spawn pays process boot + config load + MCP server
 * init before the model is even called, which lands in the 5-15s range.
 * A direct API call to a small model is ~1s, and that latency sits in the
 * worst possible place for voice — the silence between "agent finished"
 * and "Codey starts speaking".
 *
 * Deliberately narrow: no tools, no sessions, no streaming (streaming is a
 * separate follow-up), and a short timeout, because a stalled digest should
 * degrade to speaking the full reply rather than leaving dead air.
 */

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

export interface TextCompletionOptions {
  /** Upper bound on generated tokens. Digest output is a few sentences. */
  maxTokens?: number;
  /** Hard abort. Short by design — see the note above about dead air. */
  timeoutMs?: number;
}

/** True when `model` carries enough credentials to be callable directly. */
export function canRunDirectly(model: ModelConfig | undefined): model is ModelConfig {
  return Boolean(model?.apiKey && model.model);
}

interface BuiltCompletion {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  isAnthropic: boolean;
}

/**
 * Which protocol to speak to a model over this direct HTTP path.
 *
 * A dual-protocol ('all') model could be called either way, so we need one
 * deterministic pick: anthropic first, falling back to openai only when the
 * provider exposes an openai endpoint and no anthropic one.
 */
function prefersAnthropic(model: ModelConfig): boolean {
  if (model.apiType === 'all') {
    if (model.anthropicBaseUrl) return true;
    if (model.openaiBaseUrl) return false;
    return true;
  }
  return model.apiType !== 'openai';
}

/** Resolve provider, endpoint URL, auth headers, and request body. Shared by
 *  the one-shot and streaming paths so auth/endpoint fixes happen once. */
function buildCompletion(model: ModelConfig, prompt: string, maxTokens: number, stream: boolean): BuiltCompletion {
  const isAnthropic = prefersAnthropic(model);
  const protocolBase = model.apiType === 'all'
    ? (isAnthropic ? model.anthropicBaseUrl : model.openaiBaseUrl)
    : model.baseUrl;
  const base = (protocolBase ?? (isAnthropic ? DEFAULT_ANTHROPIC_BASE : DEFAULT_OPENAI_BASE)).replace(/\/$/, '');
  const url = isAnthropic ? `${base}/messages` : `${base}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = model.apiKey!;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const body: Record<string, unknown> = isAnthropic
    ? { model: model.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
    : { model: model.model, max_completion_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (stream) body.stream = true;

  return { url, headers, body, isAnthropic };
}

/** POST the completion. Resolves null on network error/abort or a non-2xx
 *  status; the timeout is applied here and the timer always cleared. */
async function postCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof request>> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `prompt` against `model` and returns the completion text, or null if
 * the call fails or comes back empty. Never throws — every caller so far has
 * a usable fallback, and surfacing an exception into a voice turn is worse
 * than degrading quietly.
 */
export async function runTextCompletion(
  prompt: string,
  model: ModelConfig,
  opts: TextCompletionOptions = {},
): Promise<string | null> {
  const maxTokens = opts.maxTokens ?? 512;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const { url, headers, body, isAnthropic } = buildCompletion(model, prompt, maxTokens, false);

  const res = await postCompletion(url, headers, body, timeoutMs);
  if (!res) return null;
  try {
    const json = (await res.body.json()) as any;
    const text = isAnthropic ? extractAnthropicText(json) : extractOpenAiText(json);
    return text && text.trim().length > 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Streaming variant. Calls `onDelta` with each incremental text fragment as
 * it arrives and resolves with the full text (or null if nothing at all was
 * produced, so the caller can fall back).
 *
 * The point is first-sound latency: with a non-streaming digest the caller
 * can't synthesize anything until the whole summary exists, so the user
 * waits for generation *and* synthesis serially. Streaming lets the first
 * sentence go to TTS while the rest is still being written.
 *
 * A mid-stream failure resolves with whatever text arrived rather than
 * null — the caller has already spoken those sentences, and re-running a
 * fallback would repeat them.
 */
export async function streamTextCompletion(
  prompt: string,
  model: ModelConfig,
  onDelta: (delta: string) => void,
  opts: TextCompletionOptions = {},
): Promise<string | null> {
  const maxTokens = opts.maxTokens ?? 512;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const { url, headers, body, isAnthropic } = buildCompletion(model, prompt, maxTokens, true);

  const res = await postCompletion(url, headers, body, timeoutMs);
  if (!res) return null;

  let acc = '';
  try {
    let buffered = '';
    for await (const chunk of res.body) {
      buffered += chunk.toString();
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        const delta = parseSseDelta(line, isAnthropic);
        if (delta) {
          acc += delta;
          onDelta(delta);
        }
      }
    }
  } catch {
    // Fall through — partial text is still worth returning.
  }
  return acc.trim().length > 0 ? acc : null;
}

/** Pulls the text fragment out of one SSE line, or '' if it carries none. */
function parseSseDelta(line: string, isAnthropic: boolean): string {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return '';
  }
  const delta = isAnthropic
    ? json?.type === 'content_block_delta'
      ? json?.delta?.text
      : undefined
    : json?.choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : '';
}

function extractAnthropicText(json: any): string {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

function extractOpenAiText(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
