---
name: codey-mac-app
description: Design for Codey macOS menu bar application with chat, config, and status
type: project
---

# Codey Mac App Design

**Date:** 2026-03-17
**Status:** Approved

## Overview

A macOS menu bar application that provides a native interface for Codey gateway with chat, configuration editing, workspace management, and system status monitoring.

## Architecture

- **App Type:** Menu bar application (LSUIElement = true)
- **Framework:** React Native macOS
- **Main Window:** Single window with tabbed navigation
- **Gateway Communication:** Spawns Codey as child process via IPC

## Components

### 1. Menu Bar Icon

- **Icon:** Custom icon with state indicator (green = running, gray = stopped)
- **Left-click:** Opens main window
- **Right-click:** Context menu
  - Start Gateway / Stop Gateway
  - Open Window
  - Quit

### 2. Main Window (800x600 default, resizable)

Tabbed interface with 4 tabs:

#### Chat Tab
- Message input field (multiline)
- Send button
- Response display area with markdown rendering
- Conversation history (scrollable)

#### Status Tab
- Gateway running state (on/off toggle)
- Uptime display
- Messages processed count
- Errors count
- Active channels list
- Gateway process output (stdout/stderr stream)

#### Settings Tab
- Gateway port configuration
- Default agent selector
- Default model selector
- Channel toggles (Telegram, Discord, iMessage)
- API keys input fields
- Save/Reset buttons

#### Workspaces Tab
- Workspace list with current indicator
- Create new workspace button
- Delete workspace button
- Switch workspace action

### 3. IPC Communication

- **Child Process:** Spawns `npm run dev` or `node dist/index.js`
- **Process Management:** Start, stop, restart, health check
- **Output Streaming:** Pipe stdout/stderr to Status tab
- **HTTP API:** Connect to gateway on configured port for chat

## Data Flow

```
User Input → React App → HTTP (localhost:port) → Gateway → Agent → Response
                     ↓
             Gateway Process (child)
```

## Key Features

1. **Gateway Control** - Start/stop gateway from UI
2. **Chat Interface** - Send prompts, receive markdown responses
3. **Status Monitoring** - Real-time gateway status and logs
4. **Configuration** - Edit gateway.json from UI
5. **Workspace Management** - Switch between workspaces

## Edge Cases

- Gateway crash: Show error notification, offer restart button
- Port conflict: Detect and display error with suggestion
- Invalid config: Validate JSON before saving, show errors
- Process timeout: 30-second startup timeout with feedback

## File Structure (Proposed)

```
codey-mac/
├── App.tsx                 # Main app component
├── index.js               # Entry point
├── src/
│   ├── components/
│   │   ├── MenuBar.tsx    # Menu bar icon & menu
│   │   ├── ChatTab.tsx    # Chat interface
│   │   ├── StatusTab.tsx  # Status & logs
│   │   ├── SettingsTab.tsx # Config editor
│   │   └── WorkspacesTab.tsx # Workspace manager
│   ├── hooks/
│   │   ├── useGateway.ts  # Gateway process management
│   │   └── useConfig.ts   # Config state
│   ├── services/
│   │   ├── ipc.ts         # Child process management
│   │   └── api.ts         # HTTP client for gateway
│   └── types/
│       └── index.ts       # TypeScript types
└── assets/
    └── icon.png           # Menu bar icon
```

## Testing Approach

- Manual testing of each tab
- Gateway start/stop cycle
- Config save/load
- Chat round-trip
