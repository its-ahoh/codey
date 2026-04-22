# Shared Core Extraction — Design

**Date:** 2026-04-21
**Status:** Draft, pending approval

## Goal

Decouple the Mac app from a running gateway process by extracting `WorkerManager`, `WorkspaceManager`, `AgentFactory`, and related orchestration into a shared library (`@codey/core`) that both the gateway and the Mac Electron main process import directly. The gateway becomes a thin bridge focused on Telegram/Discord/iMessage. The Mac app runs the gateway in-process so Mac chat and Telegram chat can share conversation state.

## Motivation

Today the Mac app requires the gateway HTTP server to be running for local worker CRUD, team editing, and chat — even though those operations are just file IO and child-process spawning. The gateway's true job is bridging external chat platforms to coding agents; serving the local Mac UI is a coupling accident.

After this refactor:

- Mac app does local CRUD in-process via IPC — no HTTP, no separate gateway process.
- Mac chat and Telegram chat share conversation state through one in-process `Gateway` instance hosted by Electron main.
- Headless gateway deployment (cloud box, no Mac app) still works — `packages/gateway` has its own entry point.
- No code duplication between gateway and Mac app.

## Architecture

### Package layout (npm workspaces)

```
codey/
├── package.json              # root, "workspaces": ["packages/*", "codey-mac"]
├── packages/
│   ├── core/                 # @codey/core
│   │   ├── src/
│   │   │   ├── workers.ts
│   │   │   ├── workspace.ts
│   │   │   ├── worker-generator.ts
│   │   │   ├── agents/
│   │   │   ├── context.ts
│   │   │   ├── memory.ts
│   │   │   ├── planner.ts
│   │   │   ├── types/
│   │   │   ├── utils/
│   │   │   └── index.ts      # barrel export
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── gateway/              # @codey/gateway
│       ├── src/
│       │   ├── gateway.ts
│       │   ├── channels/
│       │   ├── config.ts
│       │   ├── logger.ts
│       │   ├── startup-guard.ts
│       │   ├── cli.ts
│       │   ├── health.ts     # slim: /health /metrics /ready only
│       │   └── index.ts      # headless entry
│       ├── package.json      # depends on "@codey/core": "*"
│       └── tsconfig.json
└── codey-mac/                # workspace member
    ├── package.json          # depends on "@codey/core": "*", "@codey/gateway": "*"
    ├── electron/
    │   ├── main.ts           # boots in-process Gateway, wires IPC
    │   └── preload.ts        # exposes window.codey.{workers, workspaces, teams, chat, conversations}
    └── src/                  # renderer — no services/api.ts
```

**Core exports:** `WorkerManager`, `WorkspaceManager`, `AgentFactory`, `generateWorker`, `Context`, `MemoryStore`, `Planner`, all shared types.

**Gateway exports:** `Gateway` class (so Electron can `new Gateway(core, config)`), channel classes, a `startHeadless()` function for cloud deployments.

**Consumer pattern:** Electron consumes compiled JS via the workspace symlink (`node_modules/@codey/core → packages/core`). `tsc` runs in core before Electron launches.

### What gets deleted

- `src/worker-routes.ts` — HTTP handlers for workers/teams/generate
- HTTP API portions of `src/health.ts` — `/workers`, `/workspaces/:name/teams`, `/chat` SSE, etc.
- `codey-mac/src/services/api.ts` — replaced by IPC proxy in preload
- Gateway-path Settings UI — no longer meaningful (core bundled with Mac app)
- Start/Stop Gateway tray menu items — gateway always runs in-process with the Mac app

### What stays

- CLI commands (`configure`, `status`, `set-agent`, `set-model`, `tui`) — unchanged, they use `ConfigManager` directly
- Health server (slim) — `/health`, `/metrics`, `/ready` for ops visibility
- All channel adapters (Telegram, Discord, iMessage)
- All agent adapters (claude-code, opencode, codex)
- `verify-workers` script — rewritten to test core directly, no HTTP

## Data Flow

### A. Worker/workspace/team CRUD (Mac app, local only)

```
Renderer  → window.codey.workers.list()
          → ipcRenderer.invoke('workers:list')
Electron  → handler calls WorkerManager.list() directly
          → reads workers/*/ from disk
          → returns JSON through IPC
```

No gateway involvement. Pure file IO. Fast.

### B. Chat (Mac ↔ Telegram shared conversation)

```
Mac renderer  → IPC 'chat:send' { conversationId, text }
Electron main → Gateway.handleMessage({ channel: 'mac', conversationId, sender, text })
              → AgentFactory spawns CLI, streams tokens
              → emits 'chat:token' IPC events
Renderer      → appends token to message in conversation

Telegram bot  → TelegramChannel.onMessage
              → Gateway.handleMessage({ channel: 'telegram', conversationId, sender, text })
              → same Gateway instance, same Context store
              → AgentFactory response → TelegramChannel.send
```

Same `Gateway` instance serves both. See the Conversation Model section for how `conversationId` is resolved.

### C. Headless gateway (cloud box, no Electron)

```
packages/gateway/src/index.ts
  → loads gateway.json
  → constructs Gateway(core, config)
  → registers Telegram/Discord/iMessage channels
  → no HTTP API, no renderer
```

## Conversation Model

A workspace contains N named conversations, each with its own context window and memory. Conversations are independent — they serve different purposes and do not share history.

**Identity:** `Context` is keyed by `conversationId` (not by `(channel, userId)` as it is today). Multiple senders from multiple channels can write into one conversation; it's their shared context.

**Resolution:**
- Mac renderer: user picks a conversation from a list; UI sends `conversationId` with every chat message.
- Telegram user: defaults to a per-chat conversation ID (e.g. `telegram-${chat_id}`). User can switch with a slash command (`/conv <name>`) handled by `TelegramChannel` before passing to gateway.
- First message to an unknown `conversationId` creates the conversation.

**Breaking change:** `Gateway.handleMessage` signature changes from `(channel, userId, text)` to `({channel, conversationId, sender, text})`. All channel adapters update accordingly. Existing per-user conversation state is lost on migration; this is acceptable given the app's early stage.

**Out of scope for this refactor:** the Mac conversation-picker UI, conversation rename/delete UI, Telegram `/conv` command implementation. This design only commits to the data model being capable of supporting them; UI work happens in follow-up plans.

## Components and Responsibilities

### `@codey/core`

| Module | Responsibility |
|---|---|
| `workers.ts` | Global worker CRUD: read/write `workers/<name>/{personality.md, config.json}` |
| `workspace.ts` | Workspace CRUD: read/write `workspaces/<name>/workspace.json`, teams, memory |
| `worker-generator.ts` | LLM-powered worker generation using `AgentFactory` |
| `agents/` | `AgentFactory.run(...)` spawns coding-agent CLIs, returns a streaming handle |
| `context.ts` | Conversation context store keyed by `conversationId`, 30-min TTL, 10-message cap |
| `memory.ts` | Per-workspace memory (`memory.md`) read/write |
| `planner.ts` | Multi-step task planning |
| `types/` | Shared interfaces (`WorkerDto`, `WorkspaceDto`, `Message`, etc.) |
| `utils/` | Pure helpers |

Throws typed errors: `WorkerNotFoundError`, `WorkspaceNotFoundError`, `AgentSpawnError`.

### `@codey/gateway`

| Module | Responsibility |
|---|---|
| `gateway.ts` | `Gateway` class. Ingests channel messages, applies rate limiting, routes through `Context` + `AgentFactory`, emits responses |
| `channels/` | Telegram, Discord, iMessage adapters. Each pushes to `Gateway.handleMessage` |
| `config.ts` | `ConfigManager` for `gateway.json` |
| `logger.ts` | Singleton logger |
| `startup-guard.ts` | Ensures dependencies, validates config on boot |
| `cli.ts` | Interactive CLI commands |
| `health.ts` | Tiny HTTP server exposing `/health`, `/metrics`, `/ready` |
| `index.ts` | Headless entry: boots gateway + channels from `gateway.json` |

### `codey-mac` (Electron main additions)

| Responsibility |
|---|
| Import `@codey/core` and `@codey/gateway` |
| Construct `WorkerManager`/`WorkspaceManager` for CRUD IPC handlers |
| Construct `Gateway` instance, register Telegram channel if token present |
| Register IPC handlers: `workers:*`, `workspaces:*`, `teams:*`, `chat:send`, `conversations:*` |
| Forward `Gateway` token-stream events to renderer via `chat:token` IPC events |
| Wrap all core calls in try/catch, return `{ok, error?, data?}` shape to renderer |

### `codey-mac/electron/preload.ts`

Exposes `window.codey.{workers, workspaces, teams, chat, conversations}` — each a thin wrapper over `ipcRenderer.invoke` / `ipcRenderer.on`.

## Migration Order

Six phases. Each phase ends with a green build and a working app.

1. **Scaffold workspaces.** Root `package.json` with `"workspaces": ["packages/*", "codey-mac"]`. Empty `packages/core` and `packages/gateway` with their own `package.json` + `tsconfig.json`. Verify `npm install` symlinks work.

2. **Move pure-data modules into core.** `workers.ts`, `workspace.ts`, `worker-generator.ts`, `agents/*`, `types/*`, `utils/*`. Gateway imports from `@codey/core`. `npm run verify-workers` still green.

3. **Move orchestration into core.** `context.ts`, `memory.ts`, `planner.ts`. Reshape `Context` to key by `conversationId`. Update `Gateway.handleMessage` signature and all channel adapters to pass a conversation ID (defaulting to `${channel}-${userId}` for now). Build green.

4. **Move gateway code into packages/gateway.** `gateway.ts`, `channels/*`, `config.ts`, `logger.ts`, `startup-guard.ts`, `cli.ts`, `index.ts`, slim `health.ts`. Delete `worker-routes.ts` and HTTP API portions of `health.ts`. `npm run dev` and `npm start` still work for headless mode. Rewrite `verify-workers` to test core directly, no HTTP.

5. **Wire Electron to core + gateway.** `electron/main.ts` imports `@codey/core` and `@codey/gateway`, boots a `Gateway` in-process, registers Telegram channel if configured, registers IPC handlers. `preload.ts` exposes `window.codey.*`. Remove Start/Stop Gateway tray items and Settings gateway-path input.

6. **Rewrite Mac renderer data layer.** Delete `codey-mac/src/services/api.ts`. Replace all call sites with `window.codey.*` IPC calls. Chat tab streams tokens via IPC events instead of SSE.

Each phase is a commit. The writing-plans skill will break these into finer task-level steps with test/commit instructions.

## Error Handling

- **Core** throws typed errors (`WorkerNotFoundError`, `WorkspaceNotFoundError`, `AgentSpawnError`).
- **Gateway** catches, logs, and translates to channel-appropriate user messages (Telegram reply, Discord embed, etc.).
- **Electron IPC handlers** wrap core calls in try/catch and return `{ok: false, error: string}` to the renderer. Renderer displays errors in-UI; stack traces stay in main-process logs.
- **Agent spawn failures** bubble up as rejections from `AgentFactory.run`; channels and IPC handlers both treat them as user-visible errors.

## Testing

No test runner is configured; stay lightweight.

- **`scripts/verify-workers.ts`** — rewritten to call `@codey/core` directly. No HTTP spin-up. Faster, simpler, no port conflicts.
- **`scripts/verify-gateway.ts`** (new) — smoke test. Boots `Gateway` in-process with a mock channel and mock agent, feeds a fake message, asserts round-trip works. Exercises the shared-conversation code path.
- **Electron IPC handlers** — thin wrappers, covered by manual run-through of the Mac app. No dedicated tests.

## Loose Ends

- **CLI commands** stay in `packages/gateway` and keep working unchanged — they use `ConfigManager` directly, not the HTTP API.
- **`gateway.json` location** stays cwd-relative. Electron and headless gateway share the same path when running in the same working directory; Electron falls back to `app.getPath('userData')` if no repo-local config exists.
- **Tray menu** loses Start/Stop Gateway items. "Open Codey" and "Quit" remain. Future: "Pause channels" to stop Telegram/Discord listeners without tearing down core.
- **`worker-generator`** stays in core. The `POST /workers/generate` HTTP endpoint dies; Mac app calls `generateWorker(...)` via IPC.
- **Settings UI** drops "gateway path." Keeps agent/model defaults, API keys, channel toggles.
