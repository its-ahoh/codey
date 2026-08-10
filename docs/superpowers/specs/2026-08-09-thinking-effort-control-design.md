# Thinking-effort control

**Date:** 2026-08-09
**Status:** Approved, ready for planning

## Problem

Each coding agent CLI exposes a reasoning-effort knob, but Codey never forwards it,
so every prompt runs at the CLI's default effort. There is no way to make a hard
problem think harder, or cheap chatter think less, from the chat surfaces.

## Verified CLI surface

Probed on this machine (claude-code 2.1.221, codex v0.145.0, opencode latest):

| Agent | Knob | Valid values | Invalid-value behavior |
|---|---|---|---|
| claude-code | `--effort <L>` | low, medium, high, xhigh, max | lenient: warns, falls back to default |
| codex | `-c model_reasoning_effort="<L>"` | none, minimal, low, medium, high, xhigh, max | **strict**: `invalid_enum_value` → whole run fails |
| opencode | `--variant <L>` | provider-specific | lenient: silently ignored |

The unified vocabulary is **low / medium / high / xhigh / max**, forwarded
verbatim to every agent — no translation table needed, only the flag syntax
differs. `undefined` = pass no flag = the CLI's own default; we never invent a
`'default'` literal.

## Design

### 1. Data model and precedence

`packages/core/src/types/index.ts`:

```ts
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

Three storage layers, mirroring the existing Model chain exactly:

| Layer | Location | Field |
|---|---|---|
| worker | `packages/core/src/workers.ts:11` `WorkerConfig` | `effort?: ThinkingEffort` |
| chat override | chat record, `packages/gateway/src/chats.ts:303` | `effort?: ThinkingEffort` |
| global default | `packages/core/src/types/index.ts:267` `AgentModelConfig` | `defaultEffort?: ThinkingEffort` |

Precedence: `chat.effort ?? worker.config.effort ?? agents[agent].defaultEffort`,
structurally identical to the `effectiveModel` derivation at
`codey-mac/src/components/ChatTab.tsx:1313`.

The global default is per-agent, not a single cross-agent value: codex's valid
subset varies by model and claude's `max` vs codex's `max` cost differently, so a
single value would force the most conservative agent on everyone.

Transport: `AgentRequest` (`types/index.ts:117`) gains `effort?: ThinkingEffort`.
Deliberately **not** in `ModelConfig` — effort is per-invocation intent, not a
property of a model definition, and putting it there would pollute the `gateway.json`
model catalog.

### 2. Adapter wiring and codex degrade-retry

Three argv insertions, all verbatim passthrough when `request.effort` is set:

| File | Insertion point | Append |
|---|---|---|
| `packages/core/src/agents/claude-code.ts:69` | after `--output-format` block | `--effort <e>` |
| `packages/core/src/agents/codex.ts:128` | after `--json --skip-git-repo-check` | `-c model_reasoning_effort="<e>"` |
| `packages/core/src/agents/opencode.ts:81` | near `--model` | `--variant <e>` |

claude-code and opencode need no fallback — both are lenient on invalid values.

codex gets a degrade-retry. New pure helper
`packages/core/src/agents/effort-retry.ts` (unit-tested):

```ts
/** True when a codex run failed *because of* the effort flag it was given. */
export function isEffortRejection(text: string, passedEffort: string): boolean
```

It requires **all three** to match: `invalid_enum_value`, `reasoning.effort`, and
the exact effort value that was passed out (the `passedEffort` argument, quoted as
`'<value>'` in the probe error). The three-way AND stops a prompt that happens to
quote this error text from being misread as a degrade signal. (Probed
error: `[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.`)

Retry lives inside `CodexAdapter.run`, in the `close` callback just before the
`AgentResponse` is assembled (`codex.ts:290`). On a hit, the adapter clears
`request.effort` and recurses `this.run(request)` once, guarded by a private
`__effortRetried` marker so it can never loop. `resumeSessionId` is carried into
the retry unchanged — the first attempt failed at parameter validation, so the
session state is untouched.

On retry success, the user-visible note is prepended to `AgentResponse.output`:

```
> Effort `max` isn't accepted by the current codex model — reran with the model's default effort.
```

Not `statusUpdates`: that channel is transient process state and vanishes when the
run ends, while this is a config correction the user should see afterward.

Deliberately not done: no "this model rejects X" cache (stale-cache risk; a retry
costs one API rejection that fails before token billing), and the retry does not
rotate the session.

### 3. UI and command surfaces

Four surfaces, one per existing Model surface.

**3a. Chat run-settings row** (`codey-mac/src/components/ChatTab.tsx:1871-1885`,
insert after Model). A `<select>` — not a cycling button: the row's other three
controls are selects, and 5 levels would take 4 clicks to traverse from low to
max with no visible full set. Options: `Inherit (high)` / low / medium / high /
xhigh / max. Selecting `Inherit` clears the chat override (same behavior as
`/effort clear`). `title` reuses the Model row's three-state wording (`(override)` /
`(worker: X)` / `(default)`). The team branch (`ChatTab.tsx:1853`, "Teams choose
their own agent routing.") already hides the whole block — team members each
carry worker-level effort.

**3b. Settings → Agents** (`codey-mac/src/components/AgentsTab.tsx:16`): `AgentSlot`
gains `defaultEffort?: ThinkingEffort`; each agent card gets a `Default effort`
select next to `Default model`, defaulting to `Unset`.

**3c. Worker editor** (`codey-mac/src/components/WorkersTab.tsx:100-128`): an
Effort select next to the model input, written to `WorkerConfig.effort`. The
list-row summary (`WorkersTab.tsx:40`) appends effort when set:
`claude-code · opus · max`.

**3d. Channel command** `/effort [level]`, dispatched beside `case 'model'`
(`packages/gateway/src/gateway.ts:2378`) via a new `cmdEffort`. No arg prints the
effective value and its source layer; `/effort clear` clears the chat override.
Required for Telegram/Discord users, who have no Mac UI and would otherwise have
no way to reach this feature.

Deliberate asymmetry: `updateAgentModel` (`chats.ts:303`) is **not** extended —
a new `updateEffort(chatId, effort)` is added instead. That function's docstring
says it keeps every agent/model session anchored; changing effort mid-conversation
should *not* rotate the session, since raising effort and continuing the same
thread is the primary use case.

## Test plan

- `effort-retry.ts`: unit tests for `isEffortRejection` (hit on the real probed
  error text, miss on each single-marker text, miss when the quoted effort doesn't
  match what was passed).
- Adapter argv: assert the flag lands in the spawned argv for each agent, and is
  absent when `request.effort` is undefined.
- codex retry: assert recursion happens exactly once, `__effortRetried` prevents a
  second retry, and the output note is prepended on retry success.
- Precedence: `chat > worker > global` resolution unit test.
- `/effort` command: set / clear / report, including `clear` behavior.

## Out of scope

- Per-worker-per-agent variant of the global default (worker already carries
  effort; per-agent is enough).
- Surfacing effort in the run-log / activity feed.
- A model→supported-levels whitelist (would rot as OpenAI ships models; the
  degrade-retry covers the failure).
