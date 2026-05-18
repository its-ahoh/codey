<p align="center">
  <img src="assets/logo.png" alt="Codey Logo" width="300" />
</p>

# Codey 🚀

[English](README.md) | [中文](README.zh-CN.md)

A local gateway that routes prompts from chat platforms (Telegram, Discord, iMessage) to coding agents with support for multi-workspace and worker teams. Ships with a native macOS menu-bar app for managing chats, workspaces, and agents locally — including a system-wide push-to-talk **voice input** that types into whatever app you're focused on.

## Download

Grab the latest macOS app from the [Releases page](https://github.com/its-ahoh/codey/releases/latest):

- Apple Silicon: `Codey-<version>-arm64.dmg`
- Intel: `Codey-<version>.dmg`

Builds are currently unsigned — on first launch, right-click the app → **Open** → confirm to bypass Gatekeeper.

## Features

- **macOS menu-bar app** with multi-chat tabs, workspace switcher, and inline settings
- **Multi-channel support**: Telegram, Discord, iMessage
- **Multiple coding agents**: Claude Code, OpenCode, Codex (with session resume)
- **Multi-workspace**: Each workspace has its own working directory, memory, and workers
- **Worker teams**: Define workers with roles, personalities, and relationships
- **Parallel execution**: Run multiple agents or workers simultaneously
- **Conversation context**: Remembers previous messages within a session
- **Voice input (macOS)**: Hotkey-triggered dictation with on-device WhisperKit (CoreML / ANE) or OpenAI-compatible APIs — pastes directly into whichever app you're focused on
- **Health endpoints**: Built-in health check and metrics

## Quick Start

This is a monorepo with three workspaces: `@codey/core`, `@codey/gateway`, and `codey-mac`.

```bash
# Install dependencies (all workspaces)
npm install

# Build everything
npm run build

# Copy config template
cp gateway.json.example gateway.json

# Configure (optional)
npm run configure

# Start the gateway
npm start
```

To run the macOS app in development:

```bash
npm run dev -w codey-mac        # dev with hot reload
npm run build:mac -w codey-mac  # produce a DMG in codey-mac/release/
```

## Configuration

Edit `gateway.json`:

```json
{
  "gateway": {
    "port": 3000,
    "defaultAgent": "claude-code",
    "defaultModel": "claude-sonnet-4-20250514"
  },
  "channels": {
    "telegram": { "enabled": true, "botToken": "YOUR_TOKEN" },
    "discord": { "enabled": false, "botToken": "" },
    "imessage": { "enabled": false }
  },
  "agents": {
    "claude-code": { "enabled": true, "provider": "anthropic", "defaultModel": "claude-sonnet-4-20250514" },
    "opencode": { "enabled": true, "provider": "openai", "defaultModel": "gpt-4.1" },
    "codex": { "enabled": true, "provider": "openai", "defaultModel": "gpt-5-codex" }
  },
  "profiles": [
    {
      "name": "default",
      "anthropic": { "apiKey": "sk-..." },
      "openai": { "apiKey": "sk-..." }
    }
  ],
  "activeProfile": "default",
  "dev": {
    "logLevel": "info"
  }
}
```

Auto-dispatch settings: `dispatcher.{agent, model}` (optional).

## Workspace Structure

```
workspaces/
├── default/
│   ├── workspace.json       # Workspace config (workingDir + workers)
│   ├── memory.md            # Project memory/notes
│   └── workers/
│       ├── architect.md
│       └── executor.md
├── project-a/
│   ├── workspace.json
│   ├── memory.md
│   └── workers/
│       └── ...
└── project-b/
    ├── workspace.json
    ├── memory.md
    └── workers/
        └── ...
```

Each workspace ties to a project directory via `workspace.json`:

```json
{
  "workingDir": "/path/to/project",
  "workers": {
    "architect": {
      "codingAgent": "claude-code",
      "model": "claude-opus-4-6",
      "tools": ["file-system", "git", "web-search"]
    }
  }
}
```

Switching workspaces (`/workspace myproject`) automatically sets the agent's working directory.

## Worker Configuration

Each worker is defined in a markdown file:

```markdown
# Worker: Architect

## Role
Lead architect responsible for project planning...

## Soul
Strategic thinker, focused on scalability...

## Coding Agent
claude-code

## Model
claude-opus-4-20250514

## Tools
file-system, git, web-search

## Relationship
Leads the implementation workers

## Instructions
When prompted, analyze requirements and provide...
```

## Commands

### Workers
| Command | Description |
|---------|-------------|
| `/workers` | List all workers in current workspace |
| `/worker <name> <task>` | Run a specific worker |
| `/team <name> [--all] <task>` | Run a named team (see below) |

**Team dispatch details:**

- `/team <name> [--all] <task>` — Run a named team. Members run sequentially with carry chain.
  - Teams default to `dispatch: 'all'` (every member runs).
  - Teams configured with `dispatch: 'auto'` first invoke a built-in dispatcher
    that selects the relevant subset. Pass `--all` to bypass it for one call.
  - Optional `dispatchHint` on each worker's `config.json` improves routing accuracy.
  - The dispatcher's agent/model is configured under `gateway.json` `dispatcher.{agent, model}`,
    defaulting to the gateway's default agent/model.

### Workspaces
| Command | Description |
|---------|-------------|
| `/workspaces` | List all workspaces |
| `/workspace <name>` | Switch to a workspace |

### Agents (legacy)
| Command | Description |
|---------|-------------|
| `/parallel <prompt>` | Run all agents in parallel |
| `/all <prompt>` | Run all agents in parallel |
| `/agent <name>` | Switch default agent |

### Settings
| Command | Description |
|---------|-------------|
| `/help` | Show help message |
| `/status` | Show gateway status |
| `/clear` | Clear conversation history |
| `/reset` | Start a new conversation |
| `/model <name>` | Show/set model |

## Examples

```bash
# Switch workspace
/workspace myproject

# List workers
/workers

# Run a worker
/worker architect design a REST API

# Run team task
/team build a todo app

# Run all agents in parallel
/parallel create a hello world app
```

## Voice Input (macOS)

System-wide push-to-talk dictation. Hold the configured hotkey (default `Fn`), speak, release — Codey transcribes and pastes into whatever text field is focused, no matter which app you're in.

**Transcription backends:**
- **Local (WhisperKit)** — on-device CoreML / Neural Engine. Models pulled from HuggingFace on first use; default is `large-v3-turbo` quantized (~954 MB). No network, no API key. Pipeline idle-unloads after 30s so RAM/ANE stay free when you're not dictating.
- **API** — any OpenAI-compatible `/audio/transcriptions` endpoint. Just point `apiUrl` / `apiKey` / `apiModel` (e.g. `whisper-1`, `gpt-4o-transcribe`).

**HUD overlay:**
- **Recording**: floating pill with a 5-bar live audio meter so you can see the mic is hearing you
- **Transcribing**: spinner + "Transcribing…"
- **Inserted**: green check, auto-hide
- **No focus to paste into**: full transcript shown in a wider card, auto-copied to clipboard, dismiss by click

**Controls:**
- **Hotkey** (default `Fn`) — toggle recording on / off. Configurable to F-keys or modifier combos (`Cmd+Shift+V`, etc.)
- **Esc while recording** — cancel without transcribing (buffer discarded)

Configure everything from the macOS app's **Whisper** tab: pick provider, swap models, download / warm / delete WhisperKit variants, change hotkey or injection mode (paste vs Accessibility API).

Requires Microphone and Accessibility permissions (the app prompts on first launch).

## Health Endpoints

The gateway exposes health endpoints on `port + 1`:

- `GET /health` - Full status JSON
- `GET /metrics` - Prometheus-style metrics
- `GET /ready` - Readiness check

## CLI Commands

```bash
npm run configure              # Interactive configuration
npm run status                 # Show config
npm run set-agent claude-code  # Set default coding agent
npm run set-model              # Set default model
npm run tui                    # Launch terminal UI
npm run build                  # Build all workspaces
```

For everything else (channels, profiles, API keys), edit `gateway.json` directly or use the macOS app's Settings panel.

## Project Structure

```
packages/
├── core/                # Shared types, workspace + worker managers
│   └── src/
└── gateway/             # Gateway server, channels, agents
    └── src/
        ├── agents/      # Coding agent adapters (claude-code, opencode, codex)
        ├── channels/    # Chat platform handlers (telegram, discord, imessage)
        ├── config.ts
        ├── conversation.ts
        ├── gateway.ts
        ├── health.ts
        ├── logger.ts
        └── index.ts
codey-mac/               # macOS menu-bar app (Electron + React)
├── electron/            # Main + preload processes
└── src/                 # Renderer (React UI)
voice/                   # Native Swift helper for hotkey + capture + WhisperKit
└── Sources/CodeyVoice/  # AudioCapture, HotkeyManager, HudOverlay, WhisperKitEngine, ...
workspaces/              # Per-workspace config, memory, and workers
```

## License

[MIT](LICENSE)
