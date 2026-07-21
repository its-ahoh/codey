# External MCP Servers (MCP tab) — Design

Date: 2026-07-21
Status: Approved
Builds on: 2026-07-21-plugins-browser-mcp-design.md (branch `external-mcp-servers` off `plugins-browser-mcp`)

## Goal

Let users register external MCP servers (beyond Codey's built-in plugins) in a
new **Tools → MCP** tab, and expose the enabled ones to every task-performing
agent turn through the existing `AgentRequest.mcpServers` seam.

## Decisions (user)

- Transports: **local stdio AND remote URLs** in v1.
- Add UX: **form fields only** (name, transport, command, args, env, url) — no
  JSON paste/import.
- Tools tab subtitles removed (shipped separately on PR #180's branch).

## Config (`gateway.json`)

```json
"mcpServers": {
  "github": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." }, "enabled": true },
  "linear": { "transport": "remote", "url": "https://mcp.linear.app/sse", "enabled": false }
}
```

- Record keyed by server name. `enabled` defaults false and is coerced
  strictly (same posture as `plugins`).
- `ConfigManager` gains `setExternalMcpServer(name, cfg)`,
  `removeExternalMcpServer(name)` (merge-based `update()` cannot delete keys),
  and `getEnabledExternalMcpServers(): Record<string, McpServerSpec>` which
  skips disabled/invalid entries and the reserved name `codey-browser`.
- Env values are plaintext in `gateway.json` — consistent with the existing
  `apiKeys` handling.

## Core seam

- `McpServerSpec` gains optional `url?: string`. Remote entries carry
  `command: ''`, `args: []`, `env: {}` plus `url`.
- New `addExternalMcpServers(request, servers)` in `packages/core/src/agents`:
  merges entries into `request.mcpServers` under the same task-performing-turn
  gate as the browser plugin (`browserTools === true`, workingDir, no
  `allowedTools` — the flag doubles as the "tools-capable turn" marker);
  filters the reserved `codey-browser` name; existing request entries win
  conflicts. `AgentFactory` gains `setExternalMcpProvider(fn)`; the gateway
  wires it to `getEnabledExternalMcpServers()` (live config read).

## Adapter serialization

- **claude-code** (`writeClaudeMcpConfig`): stdio entries as today; url
  entries serialize as `{ "type": "http", "url": ... }`.
- **opencode** (`writeOpenCodeMcpConfig`): url entries as
  `{ "type": "remote", "url": ..., "enabled": true }`.
- **codex** (`codexMcpArgs`): **skips url entries** — codex's `-c` MCP config
  has no reliable remote support. The MCP tab notes this limitation.

## Electron / IPC

- `codey-mac/electron/external-mcp.ts`: `validateExternalMcp(draft)` pure
  helper — name `^[a-z0-9][a-z0-9_-]*$/i` and not `codey-browser`; stdio
  requires `command`; remote requires an http(s) `url`; `enabled` coerced.
- IPC: `mcp:list` (array of `{ name, ...cfg }`), `mcp:save` (validated
  add/update), `mcp:remove`, `mcp:setEnabled`. Exposed via preload as
  `window.codey.mcp.*` with the `IpcResult` envelope; types in
  `codey-api.d.ts`.

## UI

- Fourth tab `MCP` in ToolsView (icon `server`).
- `McpTab.tsx`: card list (name, transport badge, command/url summary, Toggle
  with busy affordance, trash delete) + add/edit form with the five fields;
  args entered as one space-separated line, env as KEY=VALUE lines (parsed in
  the renderer before `mcp:save`). A footnote states remote servers are not
  passed to Codex. Deleting asks confirm().

## Testing

- gateway: config round-trip incl. set/remove/getEnabled mapping + coercion.
- core: `addExternalMcpServers` gate matrix, reserved-name filter, conflict
  precedence; remote serialization in claude/opencode helpers; codex skip.
- codey-mac: `validateExternalMcp` cases; renderer arg/env parsing helpers.
