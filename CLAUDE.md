# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Codey — a TypeScript gateway that routes prompts from chat platforms (Telegram, Discord, iMessage) to coding agents (Claude Code, OpenCode, Codex, pi). Supports multi-workspace worker teams, conversation context, and parallel agent execution.

## Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Run with ts-node (development)
npm start              # Run compiled build
npm run watch          # TypeScript watch mode
npm run configure      # Interactive config setup
npm run status         # Show current config
npm run set-agent      # Set default coding agent
npm run set-model      # Set default model
npm test               # Run all workspace unit tests (Vitest)
npm run lint           # Flag non-English characters in source
```

Tests run on Vitest. `npm test` runs every workspace's suite (`packages/core`,
`packages/gateway`, `codey-mac`); target one with `npm test -w @codey/core`.

## Architecture

**Message flow:** Chat platform → Channel handler → Gateway → Agent adapter → CLI process → Response back through gateway → Channel handler

### Core Components

- **Gateway** (`src/gateway.ts`) — Central orchestrator. Handles message routing, command parsing, rate limiting (10s cooldown), response chunking (2000 char max), workspace switching, and worker/team execution.
- **Channel handlers** (`src/channels/`) — Abstract base + platform implementations (Telegram, Discord, iMessage). Each emits UserMessage to gateway via callback.
- **Agent adapters** (`src/agents/`) — Abstract base + implementations for claude-code, opencode, codex, pi. Each spawns a CLI process with 5-minute timeout. AgentFactory creates instances.
- **Workspace manager** (`src/workspace.ts`) — Manages workspace lifecycle. Each workspace has a `workspace.json` (workingDir + worker configs), `memory.md`, and `workers/` directory. Switching workspaces sets the agent's working directory.
- **Worker system** (`src/workers.ts`) — Workers have personality defined in markdown files and execution config in `workspace.json`. Workers run individually (`/worker <name> <task>`) or as teams (`/team <task>`). Teams dispatch in one of three modes: `sequential` (every member runs in order, carrying output forward), `auto` (the Advisor picks the relevant subset), or `roundtable` (all members run concurrently in an Advisor-moderated discussion). The old names `all` and `parallel` are still read from saved config and mapped to the new ones.
- **Flow graphs (Sequential)** (`src/team-graph.ts`, `src/judge.ts`) — A `sequential` team may optionally define a `graph` (`{ entry, maxHops, nodes, edges }`) in its config. Nodes are workers (plus `start`/`end`); edges carry natural-language conditions. After each worker runs, a judge LLM (reuses the Advisor's `gateway.json` `advisor.{agent, model}`) picks the next edge by its condition, so flows can branch and loop back to an earlier worker for revision. Reaching an `end` node or the `maxHops` cap stops the run; `validateGraph` drops an invalid graph back to plain linear Sequential. Workers can pause mid-flow with `[ASK_USER]`; pause state is persisted and resumed on both the channel (`handleMessage`) and chat/Mac (`sendToChat`) surfaces via the shared `TeamEmitter` continuation path (`src/team-emitter.ts`) — the same path also powers `sequential` and `auto` resume on chat. Authored on a drag-and-drop canvas in the Mac app (`codey-mac` `FlowEditor.tsx`). `auto` and `roundtable` are unaffected.
- **Advisor** (`src/advisor.ts`, `src/discussion/parallel-advisor.ts`) — The routing/orchestration LLM behind teams. It is a coordination role only (it never writes code): in `auto`/sequential mode it iteratively picks the next worker and can loop back for revisions; in `parallel` mode an Advisor loop evaluates progress, maintains the shared summary, and decides when to ask the user, continue, or terminate. Configured via `gateway.json` `advisor.{agent, model}` (falls back to the gateway default). Workers escalate to it with an `[ASK_ADVISOR]` line.
- **Conversation manager** (`src/conversation.ts`) — Tracks multi-user, multi-channel context. 30-minute TTL, max 10 messages per conversation.
- **Config** (`src/config.ts`) — Persists to `gateway.json`. Manages channels, agents, API keys, models.
- **Health server** (`src/health.ts`) — HTTP on port+1 with `/health`, `/metrics`, `/ready` endpoints.

### Key Patterns

- Adapter pattern for agents and channels with abstract base classes
- Factory pattern (AgentFactory in `src/agents/index.ts`)
- Singleton pattern (Logger, ConfigManager)
- Workspaces live in `workspaces/<name>/` with `workspace.json` + `memory.md` + `workers/*.md`

## Configuration

Gateway config: `gateway.json` (see `gateway.json.example`)

Environment variables override config: `PORT`, `DEFAULT_AGENT`, `DEFAULT_MODEL`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`.

**Secrets do not live in `gateway.json`.** Provider API keys and bot tokens are
stored in `~/.codey/secrets.json` (mode `0600`), and Router API bearer tokens in
`~/.codey/api-tokens.json` — both via `secure-file.ts`. `gateway.json` keeps only
the non-secret metadata (key name, base URL, purpose; channel enabled/disabled)
with the secret field blanked. A config still holding inline secrets is migrated
automatically on load: the value is written to the store first, then rewritten
out of `gateway.json`. `ConfigManager` hydrates the values back into the
in-memory config, so runtime readers see the shape they always saw.

Tests must never build a `SecretStore` or `ApiTokenStore` on the default path —
`packages/gateway/vitest.setup.ts` redirects `CODEY_HOME` to a temp dir so a
fixture key cannot be migrated into a real credential store.

## TypeScript

- Target: ES2020, Module: CommonJS, strict mode
- Source maps and declarations enabled
