# Shared API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "APIs" tab in Mac Settings that stores reusable credentials/endpoints, and refactor `ModelEntry` to reference an API by name instead of carrying inline `apiKey`/`baseUrl`.

**Architecture:** New `ApiEntry` type in `@codey/core` and an `apis: ApiEntry[]` field on `GatewayConfigJson`. `ModelEntry.apiRef` replaces inline credential fields. Gateway resolution walks model → apiRef → API entry to inject creds. UI gets a new `ApisTab.tsx` mirroring the existing models pattern, and `ModelRow` swaps two inputs for a single API dropdown.

**Tech Stack:** TypeScript, Electron IPC, React, vitest (already a dev-dep on `@codey/core`).

**Reference spec:** `docs/superpowers/specs/2026-05-21-shared-api-keys-design.md`

---

## Task 1: Define `ApiEntry` and refactor `ModelEntry`

**Files:**
- Modify: `packages/core/src/types/index.ts` (lines 37-65)

- [ ] **Step 1: Add `ApiEntry` and update `ModelEntry`**

Edit `packages/core/src/types/index.ts`. Find the existing block at line 37-65 (the section starting with `// Model configuration for agents`). Replace it with:

```ts
// Model configuration for agents
export type ApiType = 'anthropic' | 'openai';

/**
 * A reusable API connection — credentials + endpoint stored once and
 * referenced from any number of ModelEntry rows by name. Lets a single
 * key power multiple models without duplication.
 */
export interface ApiEntry {
  name: string;        // unique id, surfaced in the model dropdown
  apiType: ApiType;
  baseUrl?: string;    // optional endpoint override
  apiKey: string;      // required
}

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Which environment-variable style the spawned CLI expects.
   * anthropic → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
   * openai   → OPENAI_BASE_URL   + OPENAI_API_KEY
   * Inferred from the referenced ModelEntry in gateway.json.
   */
  apiType?: ApiType;
}

/**
 * A reusable model definition the user manages in Settings.
 * The `model` field is both the identifier agent.defaultModel points
 * at and the string passed to the CLI as --model. `apiRef` names an
 * ApiEntry that supplies the credentials at run time.
 */
export interface ModelEntry {
  apiType: ApiType;
  model: string;
  apiRef?: string;      // name of an ApiEntry in the gateway's apis catalog
  provider?: string;    // optional human label (anthropic, minimax, openai, …)
}
```

- [ ] **Step 2: Build core to catch type breakage**

Run: `npm run build -w @codey/core`
Expected: errors in any code that still reads `ModelEntry.apiKey` / `ModelEntry.baseUrl`. Note the call sites — they're handled in Task 2.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/index.ts
git commit -m "feat(core): add ApiEntry type, replace ModelEntry inline creds with apiRef"
```

---

## Task 2: Add `apis` to gateway config + normalize() drops legacy fields

**Files:**
- Modify: `packages/gateway/src/config.ts` (interface lines 8-69, normalize at 431-465, default config, ConfigManager methods)
- Create: `packages/gateway/src/config.test.ts`

- [ ] **Step 1: Add `apis` to the config interface**

In `packages/gateway/src/config.ts`, change the import line 4 from:

```ts
import { CodingAgent, FallbackConfig, FallbackEntry, ModelEntry, TeamConfigRaw } from '@codey/core';
```

to:

```ts
import { ApiEntry, CodingAgent, FallbackConfig, FallbackEntry, ModelEntry, TeamConfigRaw } from '@codey/core';
```

In the same file, find the `GatewayConfigJson` interface block. Right after the `models: ModelEntry[];` line (~line 29), insert:

```ts
  /** Shared API connections referenced by ModelEntry.apiRef. */
  apis: ApiEntry[];
```

- [ ] **Step 2: Include `apis: []` in the default config**

Find `getDefaultConfig()` in `packages/gateway/src/config.ts` (search for `function getDefaultConfig`). Add `apis: [],` to the returned object next to `models: [],`.

- [ ] **Step 3: Update `normalize()` to parse `apis` and strip legacy fields off models**

In `packages/gateway/src/config.ts` find `function normalize(` at line 431. Replace the body up through the `out` object construction with:

```ts
function normalize(raw: Partial<GatewayConfigJson> & { dispatcher?: { agent?: CodingAgent; model?: string }; planner?: { model?: string } }): GatewayConfigJson {
  const defaults = getDefaultConfig();
  const rawModels = Array.isArray(raw.models) ? raw.models : defaults.models;
  // Clean break: drop inline apiKey/baseUrl from any pre-existing model entries.
  // Users re-bind via the APIs tab. apiRef is left unset until they do.
  const models: ModelEntry[] = rawModels.map(m => ({
    apiType: m.apiType,
    model: m.model,
    apiRef: (m as any).apiRef,
    provider: m.provider,
  }));
  const apis: ApiEntry[] = Array.isArray(raw.apis)
    ? raw.apis.filter((a: any) => a && typeof a.name === 'string' && typeof a.apiKey === 'string')
    : [];
  const out: GatewayConfigJson = {
    gateway: { ...defaults.gateway, ...(raw.gateway ?? {}) },
    channels: raw.channels ?? defaults.channels,
    agents: { ...defaults.agents, ...(raw.agents ?? {}) },
    models,
    apis,
    fallback: normalizeFallback(raw.fallback, defaults.fallback),
    dev: raw.dev ?? defaults.dev,
  };
```

Leave the rest of `normalize()` (advisor/dispatcher/teams/voice handling) unchanged.

- [ ] **Step 4: Handle `apis` in `ConfigManager.update()`**

In `packages/gateway/src/config.ts` find the `update()` method (around line 151). After the existing `if (partial.models !== undefined) this.config.models = partial.models;` line add:

```ts
    if (partial.apis !== undefined) this.config.apis = partial.apis;
```

- [ ] **Step 5: Add API CRUD methods to `ConfigManager`**

In `packages/gateway/src/config.ts`, find the `deleteModel(...)` method (~line 229) and append the following block right after its closing brace:

```ts
  // ── APIs ───────────────────────────────────────────────────────────
  listApis(): ApiEntry[] { return this.config.apis ?? []; }

  getApi(name: string): ApiEntry | undefined {
    return this.config.apis?.find(a => a.name === name);
  }

  saveApi(entry: ApiEntry): void {
    if (!entry.name?.trim()) throw new Error('API name is required');
    if (!entry.apiKey?.trim()) throw new Error('API key is required');
    const idx = this.config.apis.findIndex(a => a.name === entry.name);
    if (idx >= 0) this.config.apis[idx] = entry;
    else this.config.apis.push(entry);
    this.save();
  }

  renameApi(oldName: string, newName: string): boolean {
    if (!newName.trim() || oldName === newName) return false;
    if (this.config.apis.some(a => a.name === newName)) {
      throw new Error(`An API with name "${newName}" already exists`);
    }
    const idx = this.config.apis.findIndex(a => a.name === oldName);
    if (idx < 0) return false;
    this.config.apis[idx] = { ...this.config.apis[idx], name: newName };
    // Rewrite every model that referenced the old name so apiRef stays valid.
    for (const m of this.config.models) {
      if (m.apiRef === oldName) m.apiRef = newName;
    }
    this.save();
    return true;
  }

  deleteApi(name: string): boolean {
    const dependents = this.config.models.filter(m => m.apiRef === name).map(m => m.model);
    if (dependents.length > 0) {
      throw new Error(`API "${name}" is referenced by: ${dependents.join(', ')}`);
    }
    const before = this.config.apis.length;
    this.config.apis = this.config.apis.filter(a => a.name !== name);
    if (this.config.apis.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
```

- [ ] **Step 6: Drop the stale comment about `apiKey` preservation in `renameModel`**

In `packages/gateway/src/config.ts`, find the `renameModel` jsdoc block (~line 210-213):

```ts
  /**
   * Change a model entry's identifier and rewrite every fallback entry that
   * pointed at it. Content (apiType, baseUrl, apiKey) is preserved.
   */
```

Replace with:

```ts
  /**
   * Change a model entry's identifier and rewrite every fallback entry that
   * pointed at it. Content (apiType, apiRef, provider) is preserved.
   */
```

- [ ] **Step 7: Write a test for normalize() and the API CRUD**

Create `packages/gateway/src/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './config';

function withTempConfig(initial: any, fn: (cm: ConfigManager, p: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-cfg-'));
  const p = path.join(dir, 'gateway.json');
  fs.writeFileSync(p, JSON.stringify(initial));
  const cm = new ConfigManager(p);
  try { fn(cm, p); } finally { cm.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('config normalize', () => {
  it('strips legacy apiKey/baseUrl from existing ModelEntry rows', () => {
    withTempConfig({
      models: [{ model: 'm1', apiType: 'anthropic', apiKey: 'sk-old', baseUrl: 'https://old' }],
    }, cm => {
      const m = cm.listModels()[0];
      expect(m.model).toBe('m1');
      expect((m as any).apiKey).toBeUndefined();
      expect((m as any).baseUrl).toBeUndefined();
    });
  });

  it('parses apis array and preserves valid entries', () => {
    withTempConfig({
      apis: [
        { name: 'main', apiType: 'anthropic', baseUrl: 'https://api', apiKey: 'sk-1' },
        { name: '', apiType: 'anthropic', apiKey: 'sk-bad' },     // dropped: empty name
        { name: 'noKey', apiType: 'openai' },                     // dropped: missing apiKey
      ],
    }, cm => {
      const apis = cm.listApis();
      expect(apis).toHaveLength(1);
      expect(apis[0].name).toBe('main');
    });
  });

  it('defaults apis to [] when missing', () => {
    withTempConfig({}, cm => {
      expect(cm.listApis()).toEqual([]);
    });
  });
});

describe('api CRUD', () => {
  it('saveApi rejects missing name or key', () => {
    withTempConfig({}, cm => {
      expect(() => cm.saveApi({ name: '', apiType: 'openai', apiKey: 'k' } as any)).toThrow();
      expect(() => cm.saveApi({ name: 'x', apiType: 'openai', apiKey: '' } as any)).toThrow();
    });
  });

  it('renameApi rewrites apiRef on dependent models', () => {
    withTempConfig({
      apis: [{ name: 'old', apiType: 'anthropic', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiRef: 'old' }],
    }, cm => {
      expect(cm.renameApi('old', 'new')).toBe(true);
      expect(cm.listApis()[0].name).toBe('new');
      expect(cm.listModels()[0].apiRef).toBe('new');
    });
  });

  it('deleteApi refuses when models still reference it', () => {
    withTempConfig({
      apis: [{ name: 'a', apiType: 'anthropic', apiKey: 'sk' }],
      models: [{ model: 'm1', apiType: 'anthropic', apiRef: 'a' }],
    }, cm => {
      expect(() => cm.deleteApi('a')).toThrow(/m1/);
    });
  });

  it('deleteApi succeeds with no dependents', () => {
    withTempConfig({
      apis: [{ name: 'a', apiType: 'anthropic', apiKey: 'sk' }],
    }, cm => {
      expect(cm.deleteApi('a')).toBe(true);
      expect(cm.listApis()).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 8: Add vitest run script + run the test**

In `packages/gateway/package.json` scripts block, add (next to `"build"`):

```json
    "test": "vitest run",
```

If `vitest` is not already in `packages/gateway/package.json` devDependencies, add it: `cd packages/gateway && npm i -D vitest@^4.1.5`. (It's a hoisted dep through `@codey/core`, so this may be unnecessary — run the test first.)

Run: `npm run test -w @codey/gateway`
Expected: all 6 tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core packages/gateway/src/config.ts packages/gateway/src/config.test.ts packages/gateway/package.json
git commit -m "feat(gateway): apis catalog in config + drop legacy inline creds on load"
```

---

## Task 3: Gateway model resolution reads creds via apiRef

**Files:**
- Modify: `packages/gateway/src/gateway.ts:2611-2622`

- [ ] **Step 1: Update `getModelConfig` to resolve via `apiRef`**

In `packages/gateway/src/gateway.ts` find `getModelConfig` (~line 2611). Replace the catalog-hit branch (lines 2612-2622) with:

```ts
    // 1. Check the global model catalog (apiRef points at the credentials)
    const catalogEntry = this.configManager?.getModel(modelName);
    if (catalogEntry) {
      const api = catalogEntry.apiRef
        ? this.configManager?.getApi(catalogEntry.apiRef)
        : undefined;
      if (!api) {
        throw new Error(
          `Model "${catalogEntry.model}" has no API bound. Open Settings → APIs to add one, then bind it from the Models tab.`
        );
      }
      if (api.apiType !== catalogEntry.apiType) {
        throw new Error(
          `Model "${catalogEntry.model}" expects apiType "${catalogEntry.apiType}" but API "${api.name}" is "${api.apiType}".`
        );
      }
      return {
        provider: catalogEntry.provider ?? (catalogEntry.apiType === 'anthropic' ? 'anthropic' : 'openai'),
        model: catalogEntry.model,
        apiKey: api.apiKey,
        baseUrl: api.baseUrl,
        apiType: catalogEntry.apiType,
      };
    }
```

- [ ] **Step 2: Build the gateway**

Run: `npm run build -w @codey/gateway`
Expected: clean compile. If any other call site still reads `.apiKey` / `.baseUrl` off a `ModelEntry`, fix it the same way (route via `apiRef`).

- [ ] **Step 3: Audit other call sites**

Run: `grep -rn "\\.apiKey\\|\\.baseUrl" packages/gateway/src/ packages/core/src/`
Expected: every match is either inside a `ModelConfig` (the runtime shape — keep), inside `ApiEntry` (keep), or inside legacy `voice.apiKey` (unrelated — keep). No `ModelEntry.apiKey` / `ModelEntry.baseUrl` reads should remain.

If `packages/gateway/src/cli.ts` or any other file still prints `m.apiKey` / `m.baseUrl` on a model row (search for `keyHint`, `urlHint`), replace it with `m.apiRef ? ` → ${m.apiRef}` : '(no API)' ` or similar — see `config.ts:347-349` for the existing display.

- [ ] **Step 4: Update the CLI model listing**

In `packages/gateway/src/config.ts` find the display formatting near line 347-349:

```ts
      const keyHint = m.apiKey ? ' 🔑' : '';
      const urlHint = m.baseUrl ? ` @ ${m.baseUrl}` : '';
```

Replace with:

```ts
      const keyHint = m.apiRef ? ` → ${m.apiRef}` : ' (no API bound)';
      const urlHint = '';
```

- [ ] **Step 5: Rebuild + commit**

Run: `npm run build -w @codey/gateway`
Expected: clean.

```bash
git add packages/gateway/src/gateway.ts packages/gateway/src/config.ts
git commit -m "feat(gateway): resolve model creds via apiRef instead of inline fields"
```

---

## Task 4: Electron IPC + preload + TypeScript surface for APIs

**Files:**
- Modify: `codey-mac/electron/main.ts:1153-1181`
- Modify: `codey-mac/electron/preload.ts:62-67`
- Modify: `codey-mac/src/codey-api.d.ts:61-66`

- [ ] **Step 1: Add IPC handlers in `main.ts`**

In `codey-mac/electron/main.ts` find the `// ── Models IPC ──` block (~line 1153). After the existing `models:rename` handler (~line 1181), insert:

```ts
  // ── APIs IPC ──────────────────────────────────────────────────────
  ipcMain.handle('apis:list', async () =>
    wrap(async () => coreConfigManager?.listApis() ?? [])
  )

  ipcMain.handle('apis:save', async (_e, entry: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      if (!entry?.name?.trim()) throw new Error('API name is required')
      if (entry.apiType !== 'anthropic' && entry.apiType !== 'openai') {
        throw new Error('API apiType must be "anthropic" or "openai"')
      }
      if (!entry.apiKey?.trim()) throw new Error('API key is required')
      coreConfigManager.saveApi(entry)
    })
  )

  ipcMain.handle('apis:delete', async (_e, name: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.deleteApi(name)
    })
  )

  ipcMain.handle('apis:rename', async (_e, oldName: string, newName: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.renameApi(oldName, newName)
    })
  )
```

- [ ] **Step 2: Expose the channels through `preload.ts`**

In `codey-mac/electron/preload.ts` find the `models:` block (lines 62-67). After it insert:

```ts
  apis: {
    list: () => ipcRenderer.invoke('apis:list'),
    save: (entry: any) => ipcRenderer.invoke('apis:save', entry),
    delete: (name: string) => ipcRenderer.invoke('apis:delete', name),
    rename: (oldName: string, newName: string) => ipcRenderer.invoke('apis:rename', oldName, newName),
  },
```

- [ ] **Step 3: Add the TypeScript surface in `codey-api.d.ts`**

In `codey-mac/src/codey-api.d.ts` find the `ModelEntry` import / declaration at the top of the file. Add `ApiEntry` to the imports from `@codey/core`. Then find the `models: { ... }` block (~line 61-66). After it insert:

```ts
      apis: {
        list: () => Promise<IpcResult<ApiEntry[]>>
        save: (entry: ApiEntry) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        rename: (oldName: string, newName: string) => Promise<IpcResult<void>>
      }
```

- [ ] **Step 4: Build the renderer to confirm types compile**

Run: `cd codey-mac && npm run build`
Expected: clean. Any remaining errors about `ModelEntry.apiKey` come from Task 5 — leave them for now.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): IPC channels for apis:list/save/delete/rename"
```

---

## Task 5: Extract shared Settings UI atoms

**Files:**
- Create: `codey-mac/src/components/settingsAtoms.ts`
- Modify: `codey-mac/src/components/SettingsTab.tsx` (lines 40-67)

The Models row and the new APIs tab share button / input / section styles. Pulling them into one file keeps both tabs visually identical and avoids divergence.

- [ ] **Step 1: Create the shared atoms file**

Create `codey-mac/src/components/settingsAtoms.ts`:

```ts
import React from 'react'
import { C } from '../theme'

export const sectionStyle: React.CSSProperties = {
  color: C.fg3, fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase', marginTop: 22, marginBottom: 8,
}
export const fieldStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 0', borderBottom: `1px solid ${C.border}`,
}
export const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

export const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? '#fff' : variant === 'danger' ? C.red : C.fg2,
})

export const Section: React.FC<{ title: string; right?: React.ReactNode }> = ({ title, right }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...sectionStyle }}>
    <span>{title}</span>
    {right}
  </div>
)

export function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (r.ok) return r.data
  throw new Error(r.error)
}
```

- [ ] **Step 2: Replace the inline declarations in `SettingsTab.tsx`**

In `codey-mac/src/components/SettingsTab.tsx`:

Delete the inline declarations lines 40-67 (the `sectionStyle`, `fieldStyle`, `inputStyle`, `selectStyle`, `pillButton`, `Section` block).

Also delete the `unwrap` function at the bottom of the file (lines 553-556).

Add a new import below the existing `import { C } from '../theme'` line:

```ts
import { sectionStyle, fieldStyle, inputStyle, selectStyle, pillButton, Section, unwrap } from './settingsAtoms'
```

- [ ] **Step 3: Build the renderer**

Run: `cd codey-mac && npm run build`
Expected: existing `ModelEntry.apiKey`/`baseUrl` errors only — atoms refactor itself compiles cleanly.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/settingsAtoms.ts codey-mac/src/components/SettingsTab.tsx
git commit -m "refactor(mac): extract shared Settings UI atoms into one module"
```

---

## Task 6: Build the new APIs tab

**Files:**
- Create: `codey-mac/src/components/ApisTab.tsx`
- Modify: `codey-mac/src/components/SettingsOverlay.tsx`

- [ ] **Step 1: Create `ApisTab.tsx`**

Create `codey-mac/src/components/ApisTab.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import {
  inputStyle, selectStyle, pillButton, Section, unwrap,
} from './settingsAtoms'

type ApiType = 'anthropic' | 'openai'
interface ApiEntry { name: string; apiType: ApiType; baseUrl?: string; apiKey: string }

interface Props { isGatewayRunning: boolean }

const ApiRow: React.FC<{
  entry: ApiEntry
  isNew?: boolean
  onSave: (draft: ApiEntry, previousName: string) => Promise<void>
  onDelete?: (name: string) => Promise<void>
  onCancel?: () => void
}> = ({ entry, isNew, onSave, onDelete, onCancel }) => {
  const [editing, setEditing] = useState(!!isNew)
  const [draft, setDraft] = useState<ApiEntry>(entry)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (!editing) setDraft(entry) }, [entry.name, editing])

  const save = async () => {
    if (!draft.name.trim() || !draft.apiKey.trim()) return
    setBusy(true); setErr(null)
    try { await onSave(draft, entry.name); setEditing(false) }
    catch (e: any) { setErr(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }

  if (!editing) {
    return (
      <div style={{
        padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`,
        background: C.surface2, marginBottom: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {entry.name}
            <span style={{ color: C.fg3, fontWeight: 400, fontSize: 11, marginLeft: 6 }}>[{entry.apiType}]</span>
          </div>
          <div style={{ color: C.fg3, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.baseUrl || '(default url)'} · 🔑
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => setEditing(true)} style={pillButton('ghost')}>Edit</button>
          {onDelete && <button onClick={() => onDelete(entry.name)} style={pillButton('danger')}>Delete</button>}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: 12, borderRadius: 10, border: `1px solid ${C.border2}`,
      background: C.surface2, marginBottom: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8, alignItems: 'center' }}>
        <label style={{ color: C.fg3, fontSize: 12 }}>Name</label>
        <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
          placeholder="e.g. anthropic-personal" style={{ ...inputStyle, width: '100%' }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>API Type</label>
        <select value={draft.apiType} onChange={e => setDraft({ ...draft, apiType: e.target.value as ApiType })}
          style={{ ...selectStyle, width: '100%' }}>
          <option value="anthropic">anthropic (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)</option>
          <option value="openai">openai (OPENAI_BASE_URL + OPENAI_API_KEY)</option>
        </select>
        <label style={{ color: C.fg3, fontSize: 12 }}>Base URL</label>
        <input value={draft.baseUrl ?? ''} onChange={e => setDraft({ ...draft, baseUrl: e.target.value || undefined })}
          placeholder="(optional) override endpoint" style={{ ...inputStyle, width: '100%' }} />
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <input type="password" value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
          placeholder="credentials" style={{ ...inputStyle, width: '100%' }} />
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        <button onClick={() => { setEditing(false); setDraft(entry); setErr(null); onCancel?.() }} style={pillButton('ghost')} disabled={busy}>Cancel</button>
        <button onClick={save} style={pillButton('primary')} disabled={busy || !draft.name.trim() || !draft.apiKey.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export const ApisTab: React.FC<Props> = ({ isGatewayRunning }) => {
  const [apis, setApis] = useState<ApiEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try { setApis(unwrap(await window.codey.apis.list())) }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { if (isGatewayRunning) reload() }, [isGatewayRunning, reload])

  if (!isGatewayRunning) {
    return (
      <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  const saveApi = async (entry: ApiEntry, previousName: string) => {
    if (previousName && previousName !== entry.name) {
      await unwrap(await window.codey.apis.rename(previousName, entry.name))
    }
    await unwrap(await window.codey.apis.save(entry))
    await reload()
    setCreating(false)
  }
  const deleteApi = async (name: string) => {
    if (!confirm(`Delete API "${name}"?`)) return
    try { await unwrap(await window.codey.apis.delete(name)); await reload() }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {error && <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{error}</div>}

      <Section title="APIs" right={
        <button onClick={() => setCreating(true)} style={pillButton('primary')} disabled={creating}>+ Add</button>
      } />
      <div style={{ color: C.fg3, fontSize: 11, marginBottom: 8 }}>
        Saved credentials & endpoints. A single API can be bound from many models in the AI Models tab.
      </div>
      {creating && (
        <ApiRow
          entry={{ name: '', apiType: 'anthropic', baseUrl: '', apiKey: '' }}
          isNew
          onSave={saveApi}
          onCancel={() => setCreating(false)}
        />
      )}
      {apis.length === 0 && !creating && (
        <div style={{ color: C.fg3, fontSize: 12, padding: '16px 0' }}>No APIs yet. Click + Add to create one.</div>
      )}
      {[...apis]
        .sort((a, b) => a.apiType.localeCompare(b.apiType) || a.name.localeCompare(b.name))
        .map(a => <ApiRow key={a.name} entry={a} onSave={saveApi} onDelete={deleteApi} />)}
    </div>
  )
}
```

- [ ] **Step 2: Register the tab in `SettingsOverlay.tsx`**

In `codey-mac/src/components/SettingsOverlay.tsx`:

Add at the top with other tab imports:

```ts
import { ApisTab } from './ApisTab'
```

Change the `Tab` union (line 12) to include `'apis'`:

```ts
type Tab = 'general' | 'workers' | 'teams' | 'workspaces' | 'status' | 'settings' | 'whisper' | 'apis'
```

In the `TABS` array (lines 13-21), insert a new entry right after the `general` row, *before* `settings`:

```ts
  { key: 'apis',       label: 'APIs',       icon: '🔑', description: 'Shared credentials' },
```

In the main content switch (lines 75-81), add:

```ts
              {tab === 'apis'       && <ApisTab isGatewayRunning={isRunning} />}
```

- [ ] **Step 3: Build the renderer**

Run: `cd codey-mac && npm run build`
Expected: existing `SettingsTab.tsx` errors about `apiKey`/`baseUrl` only — `ApisTab` itself compiles.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/ApisTab.tsx codey-mac/src/components/SettingsOverlay.tsx
git commit -m "feat(mac): add APIs settings tab for shared credentials"
```

---

## Task 7: Refactor `ModelRow` to bind an API

**Files:**
- Modify: `codey-mac/src/components/SettingsTab.tsx` (ModelEntry interface + ModelRow render)

- [ ] **Step 1: Update the `ModelEntry` interface in the file**

In `codey-mac/src/components/SettingsTab.tsx` near line 9-16:

```ts
interface ModelEntry {
  apiType: ApiType
  model: string
  baseUrl?: string
  apiKey?: string
  provider?: string
}
```

Replace with:

```ts
interface ApiEntry { name: string; apiType: ApiType; baseUrl?: string; apiKey: string }
interface ModelEntry {
  apiType: ApiType
  model: string
  apiRef?: string
  provider?: string
}
```

- [ ] **Step 2: Pass available APIs into `ModelRow`**

Change the `ModelRow` props (~line 136):

```ts
const ModelRow: React.FC<{
  entry: ModelEntry
  isNew?: boolean
  onSave: (draft: ModelEntry, previousId: string) => Promise<void>
  onDelete?: (modelId: string) => Promise<void>
  onCancel?: () => void
}>
```

to:

```ts
const ModelRow: React.FC<{
  entry: ModelEntry
  apis: ApiEntry[]
  isNew?: boolean
  onSave: (draft: ModelEntry, previousId: string) => Promise<void>
  onDelete?: (modelId: string) => Promise<void>
  onCancel?: () => void
}>
```

Destructure `apis` in the component signature on the same line.

- [ ] **Step 3: Replace the collapsed-row "url · 🔑" hint**

In `ModelRow`'s `!editing` return (~lines 174-176):

```tsx
          <div style={{ color: C.fg3, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.baseUrl || '(default url)'}{entry.apiKey ? ' · 🔑' : ''}
          </div>
```

Replace with:

```tsx
          <div style={{
            color: entry.apiRef ? C.fg3 : C.warningFg,
            fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {entry.apiRef ? `→ ${entry.apiRef}` : '(no API bound)'}
          </div>
```

- [ ] **Step 4: Replace the Base URL + API Key edit inputs with an API dropdown**

In `ModelRow`'s editing return (~lines 201-206):

```tsx
        <label style={{ color: C.fg3, fontSize: 12 }}>Base URL</label>
        <input value={draft.baseUrl ?? ''} onChange={e => setDraft({ ...draft, baseUrl: e.target.value || undefined })}
          placeholder="(optional) override endpoint" style={{ ...inputStyle, width: '100%' }}/>
        <label style={{ color: C.fg3, fontSize: 12 }}>API Key</label>
        <input type="password" value={draft.apiKey ?? ''} onChange={e => setDraft({ ...draft, apiKey: e.target.value || undefined })}
          placeholder="(optional) credentials" style={{ ...inputStyle, width: '100%' }}/>
```

Replace with:

```tsx
        <label style={{ color: C.fg3, fontSize: 12 }}>API</label>
        <select
          value={draft.apiRef ?? ''}
          onChange={e => setDraft({ ...draft, apiRef: e.target.value || undefined })}
          style={{ ...selectStyle, width: '100%' }}
        >
          <option value="">Select an API…</option>
          {apis
            .filter(a => a.apiType === draft.apiType)
            .map(a => (
              <option key={a.name} value={a.name}>
                {a.name}{a.baseUrl ? ` (${a.baseUrl})` : ''}
              </option>
            ))}
        </select>
        {apis.filter(a => a.apiType === draft.apiType).length === 0 && (
          <span />
        )}
        {apis.filter(a => a.apiType === draft.apiType).length === 0 && (
          <div style={{ gridColumn: '1 / span 2', color: C.fg3, fontSize: 11, marginTop: -4 }}>
            No {draft.apiType} APIs yet — add one in the APIs tab.
          </div>
        )}
```

- [ ] **Step 5: Load APIs in `SettingsTab` and pass them down**

In `SettingsTab` (~line 354 onward), add an `apis` state and reload alongside models. Replace the `reload` callback (~line 375-386) with:

```ts
  const [apis, setApis] = useState<ApiEntry[]>([])

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [m, f, d, a] = await Promise.all([
        unwrap(await window.codey.models.list()),
        unwrap(await window.codey.fallback.get()),
        unwrap(await window.codey.dispatcher.get()),
        unwrap(await window.codey.apis.list()),
      ])
      setModels(m); setFallback(f as FallbackCfg)
      setAdvisor({ agent: d.agent ?? '', model: d.model ?? '' })
      setApis(a as ApiEntry[])
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])
```

Then update the two `ModelRow` usages (the `creating` one and the `.map(m => <ModelRow ...>)`) to pass `apis={apis}`:

```tsx
      {creating && (
        <ModelRow
          entry={{ apiType: 'anthropic', model: '' }}
          apis={apis}
          isNew
          onSave={saveModel}
          onCancel={() => setCreating(false)}
        />
      )}
```

and:

```tsx
        .map(m => <ModelRow key={m.model} entry={m} apis={apis} onSave={saveModel} onDelete={deleteModel}/>)}
```

(Note: the `creating` entry's initial object also drops `baseUrl: ''` and `apiKey: ''`.)

- [ ] **Step 6: Build the renderer**

Run: `cd codey-mac && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/SettingsTab.tsx
git commit -m "feat(mac): Model row binds an API instead of inline key/url"
```

---

## Task 8: Full-stack manual verification

This task has no code changes — it validates the feature end-to-end. Required because the gateway has no automated integration tests for the renderer path.

- [ ] **Step 1: Start the gateway + Mac app fresh**

Pre-flight: back up your `gateway.json` (`cp ~/.codey/gateway.json ~/.codey/gateway.json.bak` or whatever path the app uses), and confirm it currently contains at least one model with an inline `apiKey`.

Run: from the project root, launch the Mac app the way you normally do (`cd codey-mac && npm run dev` or the packaged binary).

Expected: gateway boots, app opens. On startup the gateway's `normalize()` rewrites `gateway.json` — open it and confirm `models[*].apiKey` and `models[*].baseUrl` are gone and an `apis: []` field exists.

- [ ] **Step 2: Verify the warning badge appears on existing models**

Open Settings → AI Models.
Expected: existing model rows show "(no API bound)" in the warning color where the URL + 🔑 hint used to be.

- [ ] **Step 3: Add an API entry**

Click the new APIs tab. Click "+ Add". Fill in name (e.g. "main"), apiType anthropic, optionally baseUrl, paste a real Anthropic API key. Save.
Expected: the row collapses, shows `main [anthropic] (default url) · 🔑`.

- [ ] **Step 4: Bind the API to a model**

Go to AI Models. Edit a `claude-code`-compatible (anthropic) model. The new "API" dropdown lists `main`. Pick it. Save.
Expected: collapsed row now shows `→ main` in the muted color.

- [ ] **Step 5: Run a chat and verify it works**

In the main chat UI, send a prompt to that model.
Expected: model responds successfully. No "no API bound" error.

- [ ] **Step 6: Test rename propagation**

Settings → APIs → edit "main", rename to "main2". Save. Switch to AI Models.
Expected: the bound model now reads `→ main2`. Send another chat prompt — still works.

- [ ] **Step 7: Test delete protection**

Settings → APIs → delete "main2".
Expected: confirm modal; on confirm an error toast appears listing the dependent model — entry stays.

Now unbind by editing the model and selecting "Select an API…". Save. Try delete again.
Expected: succeeds; row disappears.

- [ ] **Step 8: Test type mismatch error path**

Manually edit `gateway.json` to bind an anthropic-typed model to an openai-typed API. Restart the app, send a prompt.
Expected: error in chat reads "Model X expects apiType anthropic but API Y is openai".

- [ ] **Step 9: Restore your real keys**

Re-bind models to your real APIs (or restore `gateway.json.bak` and re-run normalize once — the migration is idempotent).

- [ ] **Step 10: Commit the verification log (optional)**

If you took screenshots or notes worth keeping, drop them in `docs/superpowers/notes/2026-05-22-shared-api-keys-verification.md` and commit. Otherwise skip.

---

## Self-review notes

- Spec coverage: ApiEntry (Task 1), config storage + normalize migration (Task 2), backend resolution (Task 3), IPC (Task 4), atoms refactor + UI (Tasks 5-7), manual verification (Task 8). ✓
- The spec's mention of an inline "no APIs yet" hint in the Model edit dropdown is in Task 7 Step 4. ✓
- The spec's "renaming an API rewrites all model apiRef atomically" is implemented in Task 2 Step 5's `renameApi`. ✓
- The spec's "delete refuses when models still reference" is in Task 2 Step 5 and tested in Task 2 Step 7. ✓
- No placeholders: every step has the actual code or command. ✓
