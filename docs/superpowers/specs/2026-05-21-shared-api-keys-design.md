# Shared API Keys (APIs Tab in Settings)

## Problem

Today every `ModelEntry` carries its own inline `apiKey` and `baseUrl`. If a user
has one OpenAI-compatible key that works across `gpt-5`, `gpt-5-mini`, and a
custom OpenRouter alias, they must paste the same key into each model row
separately, and rotate it in three places. There is no way to share credentials
across models or agents.

## Goal

Introduce a first-class **API** entity that stores credentials + endpoint once,
and have each `ModelEntry` reference an API by name. A new **APIs** tab in
Settings manages these entries.

## Non-goals

- Per-agent custom env vars / timeouts (out of scope, kept for future).
- Model name patterns / wildcards on the API entry — each model is still its
  own row in the catalog; the API just supplies credentials.
- Automatic migration of existing inline keys — old `apiKey` / `baseUrl` fields
  on models are dropped on load. Users re-configure in the new tab.

## Data model

### `packages/core/src/types/index.ts`

Add:

```ts
export interface ApiEntry {
  name: string;          // unique id, surfaced in the model dropdown
  apiType: ApiType;      // 'anthropic' | 'openai'
  baseUrl?: string;      // optional endpoint override
  apiKey: string;        // required — the whole point of this entry
}
```

Modify `ModelEntry`:

```ts
export interface ModelEntry {
  apiType: ApiType;      // kept for filtering (must match referenced API)
  model: string;
  apiRef?: string;       // name of an ApiEntry; required for the model to run
  provider?: string;
  // REMOVED: apiKey, baseUrl
}
```

`apiRef` is `?` only so a freshly-created model can be saved before binding,
but the gateway rejects requests for a model whose `apiRef` doesn't resolve
to an existing API entry of the same `apiType`.

### `packages/gateway/src/config.ts`

Add `apis: ApiEntry[]` to `GatewayConfigJson`. Default to `[]`. Include it in
the `update()` merge logic and `normalize()` so existing `gateway.json` files
load cleanly. During `normalize()`, strip `apiKey` and `baseUrl` from every
`ModelEntry` (clean break — user re-configures).

## Backend

### Resolution (`packages/gateway/src/gateway.ts` ~2615)

Where the gateway currently reads `catalogEntry.apiKey` / `catalogEntry.baseUrl`:

```ts
const api = config.apis.find(a => a.name === catalogEntry.apiRef);
if (!api) throw new Error(`Model "${catalogEntry.model}" has no API bound`);
if (api.apiType !== catalogEntry.apiType) {
  throw new Error(`API "${api.name}" is ${api.apiType}, model expects ${catalogEntry.apiType}`);
}
modelConfig = {
  provider, model: catalogEntry.model,
  apiType: catalogEntry.apiType,
  apiKey: api.apiKey,
  baseUrl: api.baseUrl,
};
```

Error surfaces back through the existing agent-run error path; the renderer
shows it in chat the same way other run failures do.

### IPC handlers

New methods on the `window.codey.apis` namespace, mirroring `models`:

- `apis.list()` → `ApiEntry[]`
- `apis.save(entry)` → upsert by `name`
- `apis.delete(name)` → fail if any model still references it
- `apis.rename(oldName, newName)` → update all models' `apiRef` atomically

Wired through `codey-mac/electron/main.ts` IPC bridge, declared in
`codey-mac/electron/preload.ts` and `codey-mac/src/codey-api.d.ts`, and
implemented in `packages/gateway/src/chats.ts` (or wherever the existing
`models.*` handlers live — match the file).

## UI

### `SettingsOverlay.tsx`

Insert a new tab before `settings` (AI Models):

```ts
{ key: 'apis', label: 'APIs', icon: '🔑', description: 'Shared credentials & endpoints' },
```

Wire `{tab === 'apis' && <ApisTab isGatewayRunning={isRunning} />}` into the
main content switch.

### `components/ApisTab.tsx` (new)

Style-for-style sibling of `SettingsTab`'s Models section. Reuses the same
`pillButton`, `inputStyle`, `Section` atoms — extract them into a small
shared module (`components/settingsAtoms.ts`) so both tabs import from one
place instead of duplicating.

Row fields:
- **Name** (text, required, unique)
- **API Type** (select: anthropic / openai)
- **Base URL** (text, optional)
- **API Key** (password, required)

List, Add, Edit, Delete behave like `ModelRow`. Deleting an API that's still
referenced surfaces a confirm with the list of bound models and refuses on the
backend side as well.

### `components/SettingsTab.tsx`

In `ModelRow` edit view:
- Remove the Base URL and API Key inputs.
- Add an "API" select that lists APIs of matching `apiType`. If the list is
  empty, show inline link text "No APIs yet — add one in the APIs tab" (no
  navigation — user opens the tab themselves).

In `ModelRow` collapsed view:
- Replace the `(default url)` / `🔑` hint with: `→ {apiRef || '(no API bound)'}`.
  Models with no bound API render the badge in `C.warningFg`.

`saveModel` keeps working as-is — it just passes `apiRef` instead of
`apiKey`/`baseUrl`.

## Migration

On gateway load, `normalize()` discards `apiKey` and `baseUrl` from every
`ModelEntry`. Existing models keep their `model` id, `apiType`, `provider` —
they simply have no `apiRef` until the user binds one. The Models tab makes
that state visible via the warning badge described above.

No prompt, no toast, no auto-import. Per the user's call: clean break.

## Testing

Manual test plan (matches the project's no-test-runner reality):

1. Start gateway with an existing `gateway.json` that has inline-keyed models.
2. Verify models load with no `apiKey`/`baseUrl` and show the "no API bound"
   warning.
3. Open the new **APIs** tab, add an anthropic entry with a real key.
4. Edit a claude-code model, bind the new API, save. Run a prompt — it works.
5. Rename the API — model still works (apiRef updated atomically).
6. Try to delete the API — refused with a list of bound models.
7. Unbind the model, delete the API — succeeds.
