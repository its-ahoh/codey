/**
 * Provider presets, model-list fetching and balance lookups.
 *
 * A preset is only a starting point for an ApiKeyEntry: picking "DeepSeek"
 * fills in the base URLs and remembers the preset id on the entry, nothing
 * more. Every lookup below reads the URLs off the entry itself, so a user who
 * edits a URL after picking a preset gets their URL, not the preset's.
 */

import type { ApiKeyEntry } from './types';

export type BalanceKind = 'deepseek' | 'moonshot' | 'openrouter' | 'siliconflow';

export interface ProviderPreset {
  id: string;
  label: string;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  /** Where the user creates a key. */
  keyUrl?: string;
  /** Key pre-filled for local gateways that ignore it. */
  defaultApiKey?: string;
  /** How to ask this provider for the account balance. */
  balance?: BalanceKind;
  /** Provider id on models.dev, used for prices and as a model-list fallback. */
  modelsDevId?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic', label: 'Anthropic',
    anthropicBaseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    modelsDevId: 'anthropic',
  },
  {
    id: 'openai', label: 'OpenAI',
    openaiBaseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    modelsDevId: 'openai',
  },
  {
    id: 'deepseek', label: 'DeepSeek',
    anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    balance: 'deepseek',
    modelsDevId: 'deepseek',
  },
  {
    id: 'moonshot', label: 'Kimi',
    anthropicBaseUrl: 'https://api.moonshot.ai/anthropic',
    openaiBaseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    balance: 'moonshot',
    modelsDevId: 'moonshotai',
  },
  {
    id: 'moonshot-cn', label: 'Kimi China',
    anthropicBaseUrl: 'https://api.moonshot.cn/anthropic',
    openaiBaseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    balance: 'moonshot',
    modelsDevId: 'moonshotai-cn',
  },
  {
    id: 'zhipu', label: 'Zhipu GLM',
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    modelsDevId: 'zhipuai',
  },
  {
    id: 'zai', label: 'Z.ai GLM',
    anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
    openaiBaseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    modelsDevId: 'zai',
  },
  {
    id: 'minimax', label: 'MiniMax',
    anthropicBaseUrl: 'https://api.minimax.io/anthropic',
    openaiBaseUrl: 'https://api.minimax.io/v1',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    modelsDevId: 'minimax',
  },
  {
    id: 'openrouter', label: 'OpenRouter',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    balance: 'openrouter',
    modelsDevId: 'openrouter',
  },
  {
    id: 'siliconflow', label: 'SiliconFlow',
    openaiBaseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    balance: 'siliconflow',
    modelsDevId: 'siliconflow-cn',
  },
  {
    id: 'xai', label: 'xAI',
    openaiBaseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    modelsDevId: 'xai',
  },
  {
    id: 'ollama', label: 'Ollama',
    openaiBaseUrl: 'http://localhost:11434/v1',
    defaultApiKey: 'ollama',
  },
  {
    // magpie's local gateway speaks both protocols and accepts any key; it
    // owns subscriptions, protocol translation and account failover.
    id: 'magpie', label: 'magpie',
    anthropicBaseUrl: 'http://127.0.0.1:3425',
    openaiBaseUrl: 'http://127.0.0.1:3425/v1',
    keyUrl: 'https://usemagpie.ai',
    defaultApiKey: 'magpie',
  },
];

export function getProviderPreset(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find(p => p.id === id) : undefined;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const REQUEST_TIMEOUT_MS = 10_000;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Both OpenAI's and Anthropic's model endpoints answer `{ data: [{ id }] }`. */
export function parseModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map(m => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export interface ModelListResult {
  models: string[];
  /** Which source answered: the provider itself, or models.dev as a fallback. */
  source: 'provider' | 'models.dev';
}

/**
 * Ask the key's own endpoints which models it can use. Tries the OpenAI-style
 * `/models` first (most providers), then Anthropic's `/v1/models`. When both
 * fail and the entry came from a preset, falls back to models.dev's catalogue
 * for that provider, so a provider without a listing endpoint still gets a
 * picker instead of a blank box.
 */
export async function fetchProviderModels(
  entry: Pick<ApiKeyEntry, 'apiKey' | 'anthropicBaseUrl' | 'openaiBaseUrl' | 'provider'>,
  fetchImpl: FetchLike,
  modelsDev?: () => Promise<ModelsDevCatalog | undefined>,
): Promise<ModelListResult> {
  const errors: string[] = [];
  if (entry.openaiBaseUrl) {
    try {
      const ids = parseModelIds(await getJson(fetchImpl, `${trimSlash(entry.openaiBaseUrl)}/models`, {
        Authorization: `Bearer ${entry.apiKey}`,
      }));
      if (ids.length) return { models: ids, source: 'provider' };
    } catch (e) { errors.push((e as Error).message); }
  }
  if (entry.anthropicBaseUrl) {
    try {
      const ids = parseModelIds(await getJson(fetchImpl, `${trimSlash(entry.anthropicBaseUrl)}/v1/models`, {
        'x-api-key': entry.apiKey,
        Authorization: `Bearer ${entry.apiKey}`,
        'anthropic-version': '2023-06-01',
      }));
      if (ids.length) return { models: ids, source: 'provider' };
    } catch (e) { errors.push((e as Error).message); }
  }
  const devId = modelsDevIdFor(entry.provider);
  if (devId && modelsDev) {
    const catalog = await modelsDev().catch(() => undefined);
    const models = Object.keys(catalog?.[devId]?.models ?? {}).sort((a, b) => a.localeCompare(b));
    if (models.length) return { models, source: 'models.dev' };
  }
  if (!entry.openaiBaseUrl && !entry.anthropicBaseUrl) {
    throw new Error('This key has no base URL to ask. Add one, or pick a provider preset.');
  }
  throw new Error(errors.length ? errors.join('; ') : 'The provider returned no models.');
}

export interface BalanceResult {
  /** Money left, when the provider reports it. */
  remaining?: number;
  /** Money spent, when the provider reports that instead (OpenRouter keys without a limit). */
  used?: number;
  currency: string;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Undefined when the entry's provider has no known balance endpoint. */
export function balanceKindFor(entry: Pick<ApiKeyEntry, 'provider' | 'openaiBaseUrl'>): BalanceKind | undefined {
  const kind = getProviderPreset(entry.provider)?.balance;
  return kind && entry.openaiBaseUrl ? kind : undefined;
}

export async function fetchProviderBalance(
  entry: Pick<ApiKeyEntry, 'apiKey' | 'openaiBaseUrl' | 'provider'>,
  fetchImpl: FetchLike,
): Promise<BalanceResult> {
  const kind = balanceKindFor(entry);
  if (!kind || !entry.openaiBaseUrl) throw new Error('This provider has no balance endpoint.');
  const base = trimSlash(entry.openaiBaseUrl);
  const auth = { Authorization: `Bearer ${entry.apiKey}` };
  switch (kind) {
    case 'deepseek': {
      // Lives at the host root, not under /v1.
      const body = await getJson(fetchImpl, `${new URL(base).origin}/user/balance`, auth) as {
        balance_infos?: Array<{ currency?: string; total_balance?: unknown }>;
      };
      const info = body.balance_infos?.[0];
      const remaining = num(info?.total_balance);
      if (remaining === undefined) throw new Error('Unexpected balance response.');
      return { remaining, currency: info?.currency ?? 'CNY' };
    }
    case 'moonshot': {
      const body = await getJson(fetchImpl, `${base}/users/me/balance`, auth) as {
        data?: { available_balance?: unknown };
      };
      const remaining = num(body.data?.available_balance);
      if (remaining === undefined) throw new Error('Unexpected balance response.');
      return { remaining, currency: new URL(base).hostname.endsWith('.cn') ? 'CNY' : 'USD' };
    }
    case 'openrouter': {
      const body = await getJson(fetchImpl, `${base}/key`, auth) as {
        data?: { usage?: unknown; limit_remaining?: unknown };
      };
      const remaining = num(body.data?.limit_remaining);
      const used = num(body.data?.usage);
      if (remaining === undefined && used === undefined) throw new Error('Unexpected key response.');
      return { remaining, used, currency: 'USD' };
    }
    case 'siliconflow': {
      const body = await getJson(fetchImpl, `${base}/user/info`, auth) as {
        data?: { totalBalance?: unknown; balance?: unknown };
      };
      const remaining = num(body.data?.totalBalance) ?? num(body.data?.balance);
      if (remaining === undefined) throw new Error('Unexpected balance response.');
      return { remaining, currency: 'CNY' };
    }
  }
}

// ── models.dev catalogue ─────────────────────────────────────────────

/** USD per 1M tokens, as models.dev publishes it. */
export interface ModelPrice {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  release_date?: string;
  limit?: { context?: number; output?: number };
  cost?: ModelPrice;
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  /** Base URL, when the provider has one fixed endpoint. */
  api?: string;
  /** AI SDK package; tells which protocol `api` speaks. */
  npm?: string;
  doc?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * List price for a model id. Prefers the provider the key came from, then any
 * provider that lists the exact id, then the id without a `vendor/` prefix
 * (OpenRouter-style ids). Undefined when models.dev has no price for it.
 */
export function lookupModelPrice(
  catalog: ModelsDevCatalog | undefined,
  model: string,
  preferredProvider?: string,
): ModelPrice | undefined {
  if (!catalog || !model) return undefined;
  const priced = (p: string, id: string) => {
    const cost = catalog[p]?.models?.[id]?.cost;
    return cost && (cost.input !== undefined || cost.output !== undefined) ? cost : undefined;
  };
  const candidates = [model];
  const slash = model.lastIndexOf('/');
  if (slash >= 0) candidates.push(model.slice(slash + 1));
  const devId = modelsDevIdFor(preferredProvider);
  for (const id of candidates) {
    if (devId) {
      const hit = priced(devId, id);
      if (hit) return hit;
    }
    for (const p of Object.keys(catalog)) {
      const hit = priced(p, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ── Colour logos ─────────────────────────────────────────────────────

/**
 * models.dev logos are single-colour on purpose. LobeHub Icons (MIT) has
 * colour versions for many AI companies; this maps a models.dev provider id to
 * its LobeHub slug (`<slug>-color.svg`). Brands whose own logo is black —
 * Anthropic, OpenAI, xAI — have no colour version and stay off this list.
 * Generated against @lobehub/icons-static-svg 1.102.0; ids missing here fall
 * back to the models.dev logo.
 */
export const COLOR_LOGOS: Record<string, string> = {
  '302ai': 'ai302',
  'aihubmix': 'aihubmix',
  'alibaba': 'qwen',
  'alibaba-cn': 'qwen',
  'alibaba-coding-plan': 'alibaba',
  'amazon-bedrock': 'bedrock',
  'arcee': 'arcee',
  'azure': 'azure',
  'cerebras': 'cerebras',
  'cloudflare-ai-gateway': 'cloudflare',
  'cloudflare-workers-ai': 'workersai',
  'cohere': 'cohere',
  'crusoe': 'crusoe',
  'deepinfra': 'deepinfra',
  'deepseek': 'deepseek',
  'empiriolabs': 'empiriolabs',
  'fireworks-ai': 'fireworks',
  'github-copilot': 'copilot',
  'google': 'gemini',
  'google-vertex': 'vertexai',
  'greenpt': 'greenpt',
  'huggingface': 'huggingface',
  'inceptron': 'inceptron',
  'longcat': 'longcat',
  'meta': 'meta',
  'minimax': 'minimax',
  'minimax-cn': 'minimax',
  'minimax-cn-coding-plan': 'minimax',
  'minimax-coding-plan': 'minimax',
  'mistral': 'mistral',
  'modelscope': 'modelscope',
  'moonshotai': 'kimi',
  'moonshotai-cn': 'kimi',
  'morph': 'morph',
  'nova': 'nova',
  'novita-ai': 'novita',
  'nvidia': 'nvidia',
  'openrouter': 'openrouter',
  'perplexity': 'perplexity',
  'poe': 'poe',
  'poolside': 'poolside',
  'qiniu-ai': 'qiniu',
  'reflection': 'reflection',
  'sakana': 'sakana',
  'sambanova': 'sambanova',
  'sensenova': 'sensenova',
  'siliconflow': 'siliconcloud',
  'siliconflow-cn': 'siliconcloud',
  'stepfun': 'stepfun',
  'stepfun-ai': 'stepfun',
  'submodel': 'submodel',
  'tencent-coding-plan': 'tencent',
  'togetherai': 'together',
  'upstage': 'upstage',
  'venice': 'venice',
  'volcengine': 'volcengine',
  'volcengine-coding-plan': 'volcengine',
  'wandb': 'wandb',
  'zai': 'zhipu',
  'zai-coding-plan': 'zhipu',
  'zhipuai': 'zhipu',
  'zhipuai-coding-plan': 'zhipu',
};

// ── Provider catalogue (curated presets + every models.dev provider) ─

/**
 * A provider id on an ApiKeyEntry/ModelEntry is either a curated preset id or
 * a raw models.dev id. This maps either to the models.dev id.
 */
export function modelsDevIdFor(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  const preset = getProviderPreset(provider);
  return preset ? preset.modelsDevId : provider;
}

/** One row of the provider picker: what a preset carries, plus a model count. */
export interface CatalogProvider {
  id: string;
  label: string;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  keyUrl?: string;
  defaultApiKey?: string;
  balance?: BalanceKind;
  /** Models models.dev lists for this provider (0 when unknown). */
  modelCount: number;
  /** Hand-picked preset (shown first) rather than a raw models.dev entry. */
  curated: boolean;
  /** models.dev id for the logo (`https://models.dev/logos/<id>.svg`); absent for local gateways. */
  logoId?: string;
  /** LobeHub slug for a colour logo, when one exists (see COLOR_LOGOS). */
  colorLogo?: string;
}

/**
 * models.dev's `api` is the URL its AI SDK package talks to. For the
 * Anthropic package that already ends in `/v1`, but Codey's anthropic base URL
 * is the root the CLI appends `/v1/messages` to, so the suffix comes off.
 */
function endpointsFromModelsDev(p: ModelsDevProvider): Pick<CatalogProvider, 'anthropicBaseUrl' | 'openaiBaseUrl'> {
  if (!p.api) return {};
  if (p.npm === '@ai-sdk/anthropic') return { anthropicBaseUrl: p.api.replace(/\/v1\/?$/, '') };
  return { openaiBaseUrl: p.api };
}

/**
 * Curated presets first (in their fixed order), then every other models.dev
 * provider by name. Without a catalogue (offline, first run) only the curated
 * presets come back, with no model counts.
 */
export function listCatalogProviders(catalog: ModelsDevCatalog | undefined): CatalogProvider[] {
  const count = (devId?: string) => Object.keys((devId && catalog?.[devId]?.models) || {}).length;
  const curated: CatalogProvider[] = PROVIDER_PRESETS.map(p => ({
    id: p.id,
    label: p.label,
    anthropicBaseUrl: p.anthropicBaseUrl,
    openaiBaseUrl: p.openaiBaseUrl,
    keyUrl: p.keyUrl,
    defaultApiKey: p.defaultApiKey,
    balance: p.balance,
    modelCount: count(p.modelsDevId),
    curated: true,
    ...(p.modelsDevId ? { logoId: p.modelsDevId } : {}),
    ...(p.modelsDevId && COLOR_LOGOS[p.modelsDevId] ? { colorLogo: COLOR_LOGOS[p.modelsDevId] } : {}),
  }));
  if (!catalog) return curated;
  const taken = new Set<string>();
  for (const p of PROVIDER_PRESETS) {
    taken.add(p.id);
    if (p.modelsDevId) taken.add(p.modelsDevId);
  }
  const rest: CatalogProvider[] = [];
  for (const [id, p] of Object.entries(catalog)) {
    if (taken.has(id) || !p || typeof p !== 'object') continue;
    const modelCount = count(id);
    if (modelCount === 0) continue;
    rest.push({
      id,
      label: p.name || id,
      ...endpointsFromModelsDev(p),
      keyUrl: p.doc,
      modelCount,
      curated: false,
      logoId: id,
      ...(COLOR_LOGOS[id] ? { colorLogo: COLOR_LOGOS[id] } : {}),
    });
  }
  rest.sort((a, b) => a.label.localeCompare(b.label));
  return [...curated, ...rest];
}

export interface CatalogModel {
  id: string;
  name?: string;
  /** YYYY-MM-DD as models.dev reports it. */
  releaseDate?: string;
  /** Context window in tokens. */
  context?: number;
  /** List price, USD per 1M tokens. */
  price?: { input?: number; output?: number };
}

/** A provider's models as models.dev lists them, newest first. No key needed. */
export function catalogModels(catalog: ModelsDevCatalog | undefined, provider: string): CatalogModel[] {
  const devId = modelsDevIdFor(provider);
  const models = (devId && catalog?.[devId]?.models) || {};
  return Object.entries(models)
    .map(([id, m]) => ({ id, m, date: m?.release_date ?? '' }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .map(({ id, m }) => {
      const out: CatalogModel = { id };
      if (m?.name && m.name !== id) out.name = m.name;
      if (m?.release_date) out.releaseDate = m.release_date;
      if (typeof m?.limit?.context === 'number') out.context = m.limit.context;
      if (m?.cost && (m.cost.input !== undefined || m.cost.output !== undefined)) {
        out.price = { input: m.cost.input, output: m.cost.output };
      }
      return out;
    });
}
