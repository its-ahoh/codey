import { describe, expect, it } from 'vitest';
import {
  catalogModels, listCatalogProviders, modelsDevIdFor,
  balanceKindFor, fetchProviderBalance, fetchProviderModels, getProviderPreset, lookupModelPrice,
  parseModelIds, PROVIDER_PRESETS, type FetchLike, type ModelsDevCatalog,
} from './providers';

type Route = { status?: number; body: unknown };

/** Fake fetch answering by exact URL; records every call with its headers. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = routes[url];
    if (!r) return { ok: false, status: 404, json: async () => ({}) };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  };
  return { impl, calls };
}

describe('presets', () => {
  it('have unique ids and at least one base URL each', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDER_PRESETS) expect(p.anthropicBaseUrl || p.openaiBaseUrl).toBeTruthy();
  });

  it('offers magpie as a dual-protocol local gateway', () => {
    const m = getProviderPreset('magpie')!;
    expect(m.anthropicBaseUrl).toBe('http://127.0.0.1:3425');
    expect(m.openaiBaseUrl).toBe('http://127.0.0.1:3425/v1');
    expect(m.defaultApiKey).toBeTruthy();
  });
});

describe('parseModelIds', () => {
  it('reads data[].id, dedupes and sorts', () => {
    expect(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { name: 'x' }] })).toEqual(['a', 'b']);
  });
  it('returns [] for unexpected shapes', () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({ models: [] })).toEqual([]);
  });
});

describe('fetchProviderModels', () => {
  it('asks the OpenAI-style endpoint with a bearer token', async () => {
    const f = fakeFetch({ 'https://example.test/v1/models': { body: { data: [{ id: 'm-2' }, { id: 'm-1' }] } } });
    const r = await fetchProviderModels({ apiKey: 'k', openaiBaseUrl: 'https://example.test/v1/' }, f.impl);
    expect(r).toEqual({ models: ['m-1', 'm-2'], source: 'provider' });
    expect(f.calls[0].headers.Authorization).toBe('Bearer k');
  });

  it('falls back to the Anthropic endpoint when the OpenAI one fails', async () => {
    const f = fakeFetch({
      'https://example.test/v1/models': { status: 500, body: {} },
      'https://example.test/anthropic/v1/models': { body: { data: [{ id: 'sonnet' }] } },
    });
    const r = await fetchProviderModels({
      apiKey: 'k', openaiBaseUrl: 'https://example.test/v1', anthropicBaseUrl: 'https://example.test/anthropic',
    }, f.impl);
    expect(r.models).toEqual(['sonnet']);
    expect(f.calls[1].headers['x-api-key']).toBe('k');
    expect(f.calls[1].headers['anthropic-version']).toBeTruthy();
  });

  it('uses models.dev for a preset whose provider has no listing', async () => {
    const f = fakeFetch({});
    const catalog: ModelsDevCatalog = { minimax: { models: { 'MiniMax-M9': {}, 'MiniMax-M8': {} } } };
    const r = await fetchProviderModels(
      { apiKey: 'k', openaiBaseUrl: 'https://example.test/v1', provider: 'minimax' }, f.impl, async () => catalog,
    );
    expect(r).toEqual({ models: ['MiniMax-M8', 'MiniMax-M9'], source: 'models.dev' });
  });

  it('says so when the key has no URL at all', async () => {
    await expect(fetchProviderModels({ apiKey: 'k' }, fakeFetch({}).impl)).rejects.toThrow(/no base URL/);
  });
});

describe('fetchProviderBalance', () => {
  it('reads DeepSeek balance from the host root', async () => {
    const f = fakeFetch({
      'https://api.deepseek.com/user/balance': { body: { balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] } },
    });
    const r = await fetchProviderBalance({ apiKey: 'k', provider: 'deepseek', openaiBaseUrl: 'https://api.deepseek.com/v1' }, f.impl);
    expect(r).toEqual({ remaining: 12.5, currency: 'CNY' });
  });

  it('picks the Moonshot currency from the host', async () => {
    const body = { data: { available_balance: 3 } };
    const f = fakeFetch({
      'https://api.moonshot.cn/v1/users/me/balance': { body },
      'https://api.moonshot.ai/v1/users/me/balance': { body },
    });
    expect((await fetchProviderBalance({ apiKey: 'k', provider: 'moonshot-cn', openaiBaseUrl: 'https://api.moonshot.cn/v1' }, f.impl)).currency).toBe('CNY');
    expect((await fetchProviderBalance({ apiKey: 'k', provider: 'moonshot', openaiBaseUrl: 'https://api.moonshot.ai/v1' }, f.impl)).currency).toBe('USD');
  });

  it('reports OpenRouter spend when the key has no limit', async () => {
    const f = fakeFetch({ 'https://openrouter.ai/api/v1/key': { body: { data: { usage: 4.2, limit_remaining: null } } } });
    const r = await fetchProviderBalance({ apiKey: 'k', provider: 'openrouter', openaiBaseUrl: 'https://openrouter.ai/api/v1' }, f.impl);
    expect(r).toEqual({ remaining: undefined, used: 4.2, currency: 'USD' });
  });

  it('follows a user-edited base URL rather than the preset', async () => {
    const f = fakeFetch({ 'https://relay.test/v1/user/info': { body: { data: { totalBalance: '7' } } } });
    const r = await fetchProviderBalance({ apiKey: 'k', provider: 'siliconflow', openaiBaseUrl: 'https://relay.test/v1' }, f.impl);
    expect(r.remaining).toBe(7);
  });

  it('has no balance for presets without an endpoint, or custom keys', () => {
    expect(balanceKindFor({ provider: 'openai', openaiBaseUrl: 'https://api.openai.com/v1' })).toBeUndefined();
    expect(balanceKindFor({ openaiBaseUrl: 'https://x.test' })).toBeUndefined();
    expect(balanceKindFor({ provider: 'deepseek' })).toBeUndefined();
  });
});

describe('lookupModelPrice', () => {
  const catalog: ModelsDevCatalog = {
    deepseek: { models: { 'ds-chat': { cost: { input: 0.3, output: 1.2 } } } },
    openrouter: { models: { 'deepseek/ds-chat': { cost: { input: 0.5, output: 2 } } } },
    other: { models: { 'ds-chat': { cost: { input: 9, output: 9 } }, free: { cost: {} } } },
  };

  it('prefers the key\'s own provider', () => {
    expect(lookupModelPrice(catalog, 'ds-chat', 'deepseek')?.input).toBe(0.3);
    expect(lookupModelPrice(catalog, 'deepseek/ds-chat', 'openrouter')?.input).toBe(0.5);
  });

  it('strips a vendor prefix when the full id is unknown', () => {
    expect(lookupModelPrice(catalog, 'acme/ds-chat', 'deepseek')?.input).toBe(0.3);
  });

  it('ignores entries without a price', () => {
    expect(lookupModelPrice(catalog, 'free')).toBeUndefined();
    expect(lookupModelPrice(undefined, 'ds-chat')).toBeUndefined();
  });
});

describe('provider catalogue', () => {
  const catalog: ModelsDevCatalog = {
    deepseek: { name: 'DeepSeek', api: 'https://api.deepseek.com', models: { a: {}, b: {} } },
    'acme-anthropic': { name: 'Acme', npm: '@ai-sdk/anthropic', api: 'https://acme.test/anthropic/v1', doc: 'https://acme.test/docs', models: { m: {} } },
    zeta: { name: 'Zeta Cloud', api: 'https://zeta.test/v1', npm: '@ai-sdk/openai-compatible', models: {
      old: { name: 'Old', release_date: '2025-01-01' },
      'new-1': { name: 'New One', release_date: '2026-05-01' },
    } },
    empty: { name: 'Empty', models: {} },
  };

  it('puts curated presets first, then models.dev providers by name', () => {
    const list = listCatalogProviders(catalog);
    const curatedCount = list.filter(p => p.curated).length;
    expect(curatedCount).toBe(PROVIDER_PRESETS.length);
    expect(list.slice(curatedCount).map(p => p.id)).toEqual(['acme-anthropic', 'zeta']);
    // A curated preset already covering a models.dev id isn't listed twice,
    // and picks up that provider's model count.
    expect(list.filter(p => p.id === 'deepseek')).toHaveLength(1);
    expect(list.find(p => p.id === 'deepseek')!.modelCount).toBe(2);
  });

  it('maps models.dev endpoints onto the right protocol', () => {
    const list = listCatalogProviders(catalog);
    expect(list.find(p => p.id === 'acme-anthropic')).toMatchObject({
      anthropicBaseUrl: 'https://acme.test/anthropic', keyUrl: 'https://acme.test/docs',
    });
    expect(list.find(p => p.id === 'acme-anthropic')!.openaiBaseUrl).toBeUndefined();
    expect(list.find(p => p.id === 'zeta')!.openaiBaseUrl).toBe('https://zeta.test/v1');
  });

  it('returns only the curated presets when offline', () => {
    const list = listCatalogProviders(undefined);
    expect(list.every(p => p.curated && p.modelCount === 0)).toBe(true);
  });

  it('lists a provider\'s models newest first, by preset or raw id', () => {
    expect(catalogModels(catalog, 'zeta')).toEqual([
      { id: 'new-1', name: 'New One', releaseDate: '2026-05-01' },
      { id: 'old', name: 'Old', releaseDate: '2025-01-01' },
    ]);
    expect(catalogModels(catalog, 'deepseek').map(m => m.id)).toEqual(['a', 'b']);
    expect(catalogModels(catalog, 'nope')).toEqual([]);
  });

  it('carries price and context window when models.dev has them', () => {
    const c: ModelsDevCatalog = { p: { models: { m: { limit: { context: 200000 }, cost: { input: 1, output: 5 } } } } };
    expect(catalogModels(c, 'p')).toEqual([{ id: 'm', context: 200000, price: { input: 1, output: 5 } }]);
  });

  it('gives each provider a logo id except local gateways', () => {
    const list = listCatalogProviders(catalog);
    expect(list.find(p => p.id === 'moonshot')!.logoId).toBe('moonshotai');
    expect(list.find(p => p.id === 'zeta')!.logoId).toBe('zeta');
    expect(list.find(p => p.id === 'magpie')!.logoId).toBeUndefined();
  });

  it('adds a colour logo where LobeHub has one, never for black-logo brands', () => {
    const list = listCatalogProviders(catalog);
    expect(list.find(p => p.id === 'deepseek')!.colorLogo).toBe('deepseek');
    expect(list.find(p => p.id === 'moonshot')!.colorLogo).toBe('kimi');
    expect(list.find(p => p.id === 'anthropic')!.colorLogo).toBeUndefined();
    expect(list.find(p => p.id === 'zeta')!.colorLogo).toBeUndefined();
  });

  it('maps preset ids to models.dev ids and passes raw ids through', () => {
    expect(modelsDevIdFor('moonshot')).toBe('moonshotai');
    expect(modelsDevIdFor('zeta')).toBe('zeta');
    expect(modelsDevIdFor('ollama')).toBeUndefined();
  });
});
