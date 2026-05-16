# Permission Mode Setting — Design Spec

## Problem

Codey runs coding agents with full permission bypass (`--dangerously-skip-permissions`) because chat-spawned CLIs have no TTY for interactive approval. Users have no visibility or control over destructive operations executed on their behalf.

## Solution

A `permissionMode: 'auto' | 'ask'` setting that, when set to `ask`, routes Claude Code's permission requests through the chat interface using the existing `[ASK_USER:choice]` mechanism.

## Architecture

### Approach: CLI `--permission-prompt-tool`

The claude-code adapter replaces `--dangerously-skip-permissions` with `--permission-prompt-tool` pointing at a local MCP server that the adapter spawns alongside the CLI. The MCP server intercepts permission requests and routes them through the gateway's chat interface.

**Why this over Agent SDK `canUseTool`:** Fits the existing spawn-based architecture without rewriting the adapter. Lower risk. The gateway-side plumbing is identical regardless — only the adapter integration layer changes between approaches.

---

## Components

### 1. Configuration

**Gateway config (`gateway.json`):**
```json
{ "permissionMode": "auto" }
```
Added to `GatewayConfigJson` in `packages/gateway/src/config.ts`. The `normalize()` function defaults to `'auto'` when missing.

**Workspace config (`workspace.json`):**
```json
{ "permissionMode": "ask" }
```
Added to `WorkspaceJson` in `packages/core/src/workspace.ts`. Per-workspace override takes precedence over global.

**Runtime resolution:**
```
workspace.permissionMode ?? config.permissionMode ?? 'auto'
```

**Type additions:**
- `GatewayConfigJson.permissionMode?: 'auto' | 'ask'` in `config.ts`
- `WorkspaceJson.permissionMode?: 'auto' | 'ask'` in `workspace.ts`
- `GatewayConfig.permissionMode?: 'auto' | 'ask'` in `types/index.ts`

### 2. `/permissions` Command

Follows the existing `/agent` and `/model` command pattern.

**Syntax:**
- `/permissions` — show current effective mode and source (global vs workspace)
- `/permissions auto` — set workspace to auto mode
- `/permissions ask` — set workspace to ask mode

**Implementation:** `cmdPermissions` method on the `Codey` class in `gateway.ts`. Reads/writes `permissionMode` on the workspace config. Registered in the `handleCommand` switch and `REGEX_HELP_COMMAND`.

### 3. Category Filter

New file: `packages/core/src/permissions.ts`

```typescript
export type PermissionCategory = 'shell' | 'file-write-outside-cwd' | 'network';

export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): PermissionCategory | null;
```

**Classification rules:**

| Tool | Category |
|------|----------|
| `bash`, `sh`, `execute` | `shell` |
| `write`, `edit` to path outside CWD | `file-write-outside-cwd` |
| `curl`, `fetch`, network tools | `network` |
| `read`, `grep`, `search`, `glob` | `null` (pass silently) |
| `write`, `edit` inside CWD | `null` (pass silently) |

Returns `null` for safe operations — no prompt needed.

### 4. Claude Code Adapter Changes

**File:** `packages/core/src/agents/claude-code.ts`

**Current behavior (line 67-69):**
```typescript
if (!request.interactive) {
  args.push('--dangerously-skip-permissions');
}
```

**New behavior:**
```typescript
if (!request.interactive) {
  if (request.permissionMode === 'ask' && request.onPermissionRequest) {
    // Start MCP server for permission interception
    const mcpServer = this.startPermissionMcpServer(request.onPermissionRequest);
    args.push('--permission-prompt-tool', 'permission_prompt');
    args.push('--mcp-server', mcpServer.getCommand());
  } else {
    args.push('--dangerously-skip-permissions');
  }
}
```

**New types on `AgentRequest` (`types/index.ts`):**
```typescript
permissionMode?: 'auto' | 'ask';
onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
```

**New types:**
```typescript
interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  category: PermissionCategory;
  description: string; // Human-readable, e.g. "Run `rm -rf node_modules`"
}

type PermissionDecision = 'allow_once' | 'allow_category' | 'deny';
```

### 5. Permission MCP Server

New file: `packages/core/src/agents/permission-mcp.ts`

A lightweight stdio-based MCP server that:
1. Exposes a `permission_prompt` tool
2. When Claude Code calls it, invokes the `onPermissionRequest` callback
3. Waits for the result and returns it to Claude Code

The server is spawned as a child process by the adapter and killed when the agent run completes.

### 6. Gateway Permission Prompt Routing

**In `runOneTurn` and `runTeamTask` methods (`gateway.ts`):**

```typescript
const effectivePermMode = workspacePermMode ?? this.config.permissionMode ?? 'auto';

// Degradation notice for non-claude-code agents
if (effectivePermMode === 'ask' && agent !== 'claude-code') {
  if (!this.hasSentDegradationNotice(conversationId)) {
    await this.sendResponse({
      chatId, channel,
      text: `⚠️ Ask mode is not supported for ${agent}. Running in auto mode.`,
    });
    this.markDegradationNoticeSent(conversationId);
  }
}

request.permissionMode = effectivePermMode;
request.onPermissionRequest = effectivePermMode === 'ask' && agent === 'claude-code'
  ? (req) => this.handlePermissionPrompt(message, req)
  : undefined;
```

**`handlePermissionPrompt` method:**

1. Classify tool call using `classifyToolCall`
2. If category is `null`, return `'allow_once'` immediately
3. Check conversation-scoped memory for category allowals
4. If allowed, return `'allow_once'`
5. Send `[ASK_USER:choice]`:
   ```
   [ask mode] Allow `rm -rf node_modules`? | Allow once | Allow all shell for this conversation | Deny
   ```
6. Wait for user response (10-minute timeout, then auto-deny)
7. If "Allow all shell", record in conversation memory
8. Return the decision

### 7. Conversation-Scoped Permission Memory

**Storage:** Add `permissionMemory` to `ContextWindow` in `packages/core/src/context.ts`:

```typescript
interface PermissionMemory {
  allowedCategories: Set<PermissionCategory>;
  allowedAt: number;
}
```

Lives as long as the context window (30-min TTL). Cleared when conversation expires or is cleared.

### 8. Timeout Handling

- **Permission prompt timeout:** 10 minutes
- **Implementation:** `Promise.race` between `onPermissionRequest` and a 10-min timer
- **On timeout:** Auto-deny, send notification: *"Permission prompt timed out. Denied [tool]. The agent will try an alternative approach."*
- **Agent timeout extension:** If the agent's overall timeout (15 min default) would fire during the permission wait, extend it by the permission wait time. The agent is paused, not hung.

### 9. Codex/OpenCode Degradation

When `permissionMode === 'ask'` but agent is codex or opencode:
- Log one-time warning per conversation: *"⚠️ Ask mode is not supported for [agent]. Running in auto mode."*
- Execute with existing permission bypass
- Track "notice sent" per conversation ID to avoid repeating

### 10. Team Mode Integration

Permission prompts in team mode use a separate `pendingPermission` field on `Chat` (not `pendingTeam`) to avoid conflating with worker `[ASK_USER]` pauses.

**Flow:**
1. Worker hits a permission-gated operation
2. MCP server sends prompt back to gateway
3. Gateway sends `[ASK_USER:choice]` to the originating user
4. Team pipeline pauses
5. User responds, permission decision flows back, team resumes

**`Chat` type addition (`types/chat.ts`):**
```typescript
pendingPermission?: {
  tool: string;
  category: PermissionCategory;
  description: string;
  resolve: (decision: PermissionDecision) => void;
  askedAt: number;
};
```

The `handleMessage` method checks `pendingPermission` before `pendingTeam` — permission answers take priority since they unblock the paused agent.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/gateway/src/config.ts` | Add `permissionMode` to `GatewayConfigJson`, `normalize()`, `getDefaultConfig()` |
| `packages/core/src/workspace.ts` | Add `permissionMode` to `WorkspaceJson` |
| `packages/core/src/types/index.ts` | Add `permissionMode`, `onPermissionRequest` to `AgentRequest`; add `PermissionRequest`, `PermissionDecision` types |
| `packages/core/src/types/chat.ts` | Add `pendingPermission` to `Chat` |
| `packages/core/src/permissions.ts` | **New.** Category filter, `classifyToolCall` |
| `packages/core/src/agents/permission-mcp.ts` | **New.** MCP server for permission interception |
| `packages/core/src/agents/claude-code.ts` | Use `--permission-prompt-tool` when `ask` mode |
| `packages/core/src/context.ts` | Add `permissionMemory` to `ContextWindow` |
| `packages/gateway/src/gateway.ts` | Add `cmdPermissions`, `handlePermissionPrompt`, degradation notices, timeout handling |

## Non-Goals (v1)

- Full RBAC / per-user permissions
- Codex/opencode `ask` mode
- Custom permission taxonomies
- Persistent "allow always" rules (v1 follow-up)
- Audit log (future)

## Open Decisions

- MCP server implementation details (stdio vs HTTP, tool schema)
- Exact `[ASK_USER:choice]` message format
- Whether `pendingPermission` needs to be persisted to disk (for crash recovery) or in-memory only
