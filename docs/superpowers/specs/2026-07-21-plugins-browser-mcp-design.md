# Plugins & Browser MCP Server — Design

Date: 2026-07-21
Status: Approved

## Problem

The in-app browser is currently exposed to coding agents by appending a ~20-line
`<codey_browser_tools>` instruction block to every task prompt
(`packages/core/src/agents/index.ts`, `addCodeyBrowserTools`). This pollutes the
user's actual prompt on every turn (browsing-related or not), re-appends on each
turn of a resumed session, and is always on — the user cannot opt out.

## Goal

Introduce **plugins**: optional capability packs that are off by default and,
when the user enables one, expose typed MCP tools to whatever agent Codey
spawns. The first plugin is **Browser** (the in-app browser). With no plugins
enabled, agents receive no MCP config, no extra env vars, and no injected
prompt text.

## Decisions (settled during brainstorming)

- **Mechanism:** a real stdio MCP server, not the shell-CLI/prompt mechanism.
- **Scope:** plugin enablement is global (one switch for all chats, workers,
  and workspaces).
- **Tool surface:** ~8 condensed tools with enum'd action parameters, not 1:1
  per CLI command (~25) — every tool schema costs context tokens each turn.
- **Old path:** the `<codey_browser_tools>` prompt injection is deleted, not
  kept as a fallback. MCP tool schemas are the discovery mechanism.
  `browser-agent-cli.cjs` remains for now (unchanged) but is no longer
  advertised to agents.

## 1. Plugin concept & config

- Static plugin registry in code (no dynamic loading): one entry, `browser`,
  with display name "Browser" and description "Let agents see and control the
  in-app browser".
- Persistence: `gateway.json` → `plugins: { browser: { enabled: boolean } }`,
  default `false`, read/written via `ConfigManager`.
- Gating chain for a given agent spawn, all required:
  1. Plugin globally enabled in config.
  2. The per-turn `browserTools === true` request flag (existing behavior:
     advisor, housekeeping, and Quick Question turns stay excluded).
  3. Browser bridge available (Mac app running; `CODEY_BROWSER_*` env set on
     the gateway process). Headless/Telegram-only deployments are unaffected.

## 2. Browser MCP server

New file `codey-mac/electron/browser-mcp-server.cjs` — plain Node (CommonJS,
no bundler deps), shipped in app resources exactly like
`browser-agent-cli.cjs`, launched as
`ELECTRON_RUN_AS_NODE=1 <electron-binary> browser-mcp-server.cjs`.

It is a thin proxy: each MCP tool call → authenticated HTTP request over the
existing Unix-socket `BrowserAgentBridge`. The bridge, the
`BrowserControlPermissionGate`, and the login-watch/chat-resume flow are
untouched.

### Tools (8)

| Tool | Parameters (sketch) |
|------|--------------------|
| `browser_open` | `url`, `view?: boolean` (open-view = open + read atomically) |
| `browser_read` | `mode: view \| screenshot \| snapshot \| state \| viewport` |
| `browser_interact` | `action: click \| fill \| select \| check \| uncheck \| press \| hover \| submit \| click_at \| drag \| scroll \| scroll_at`, plus `ref?`, `value?`, `key?`, coordinate fields |
| `browser_wait` | `for: ref \| text \| url \| title`, `value`, `state?`, `timeoutMs?` |
| `browser_navigate` | `action: back \| forward \| reload` |
| `browser_tabs` | `action: list \| new \| switch \| close`, `id?`, `url?` |
| `browser_files` | `action: upload \| downloads \| wait_download`, `ref?`, `paths?`, `timeoutMs?` |
| `browser_login_wait` | `seconds?` |

### MCP-specific behaviors

- `browser_read` with `mode: screenshot` returns inline MCP image content
  (base64), not a PNG path.
- `browser_login_wait` registers the watch and **returns immediately** with a
  message telling the agent Codey is watching and it should end its turn; the
  existing bridge-driven chat resume handles the rest. It does not block.
- Mutating `browser_interact` calls still block on the in-app permission gate
  until the user approves full browser control; adapters configure generous
  MCP tool timeouts to accommodate.
- Tool descriptions carry the safety text currently in the prompt block:
  view-only by default, mutations require user approval, authenticated-session
  content is sensitive, never claim success unless the call succeeded.

## 3. Agent wiring (the plugin-agnostic seam)

- `AgentRequest` gains
  `mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string> }>`
  in `packages/core/src/types`.
- The gateway populates it from enabled plugins at request-build time.
  `addCodeyBrowserTools` is replaced by an `addPluginServers`-style function in
  `packages/core` that applies the gating chain from §1.
- Each adapter serializes `mcpServers` natively:
  - **claude-code:** write a temp MCP config JSON, pass `--mcp-config <path>`.
  - **codex:** `-c mcp_servers.<name>.command=... / .args=... / .env=...`
    overrides.
  - **opencode:** generated config fragment via its config mechanism.
- Future plugins contribute additional entries to `mcpServers`; adapters have
  no plugin-specific knowledge.

## 4. UI

- `ToolsView.tsx` gains a third tab `plugins` → new `PluginsTab.tsx`:
  a list of plugin cards (icon, name, description, enable toggle), visually
  consistent with `SkillsTab`.
- IPC: `plugins:list` → registry + enabled state; `plugins:setEnabled` →
  updates gateway config. Changes take effect on the next agent spawn; no
  restart.
- The Browser card notes that state-changing actions still require the
  separate browser-control approval.

## 5. Error handling

- Bridge unreachable (Mac app quit mid-session, socket gone): tool calls
  return an MCP error result with a clear message; agent proceeds without the
  browser.
- Plugin enabled but bridge never started (headless gateway): gating chain §1
  step 3 fails silently — no MCP config injected.
- Malformed tool arguments: MCP schema validation rejects before reaching the
  bridge.

## 6. Testing (Vitest, alongside existing suites)

- Config gating: plugin disabled → request untouched (no `mcpServers`, no env).
- Gateway: enabled plugin + `browserTools: true` + bridge env present →
  `mcpServers` populated; advisor/housekeeping turns → not populated.
- Adapters: each serializes `mcpServers` correctly (flag/config file content).
- MCP server: tool → bridge-route mapping with a mocked socket server (same
  style as `browser-tools.test.ts`); `browser_login_wait` returns immediately;
  screenshot returns image content.
