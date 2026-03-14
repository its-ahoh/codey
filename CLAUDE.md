# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Codey — a TypeScript gateway that routes prompts from chat platforms (Telegram, Discord, iMessage) to coding agents (Claude Code, OpenCode, Codex). Supports multi-workspace worker teams, conversation context, and parallel agent execution.

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
```

No test runner is configured.

## Architecture

**Message flow:** Chat platform → Channel handler → Gateway → Agent adapter → CLI process → Response back through gateway → Channel handler

### Core Components

- **Gateway** (`src/gateway.ts`) — Central orchestrator. Handles message routing, command parsing, rate limiting (10s cooldown), response chunking (2000 char max), workspace switching, and worker/team execution.
- **Channel handlers** (`src/channels/`) — Abstract base + platform implementations (Telegram, Discord, iMessage). Each emits UserMessage to gateway via callback.
- **Agent adapters** (`src/agents/`) — Abstract base + implementations for claude-code, opencode, codex. Each spawns a CLI process with 5-minute timeout. AgentFactory creates instances.
- **Workspace manager** (`src/workspace.ts`) — Manages workspace lifecycle. Each workspace has a `workspace.json` (workingDir + worker configs), `memory.md`, and `workers/` directory. Switching workspaces sets the agent's working directory.
- **Worker system** (`src/workers.ts`) — Workers have personality defined in markdown files and execution config in `workspace.json`. Workers run individually (`/worker <name> <task>`) or sequentially as teams (`/team <task>`), passing output between steps.
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

## TypeScript

- Target: ES2020, Module: CommonJS, strict mode
- Source maps and declarations enabled
