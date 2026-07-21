# Plugins & Browser MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a user-toggleable plugin system; the first plugin ("Browser") exposes the in-app browser to coding agents as a typed MCP server instead of today's always-on prompt injection.

**Architecture:** A static plugin registry gated by `gateway.json` config (`plugins.browser.enabled`, default off). When enabled, `AgentFactory` attaches an `mcpServers` entry to each qualifying `AgentRequest`; adapters serialize it natively (claude `--mcp-config`, codex `-c` overrides, opencode `OPENCODE_CONFIG`). The MCP server itself is a dependency-free stdio JSON-RPC proxy (`browser-mcp-server.cjs`) over the existing Unix-socket `BrowserAgentBridge`. The old `<codey_browser_tools>` prompt injection is deleted.

**Tech Stack:** TypeScript (ES2020/CommonJS, strict), Vitest, Electron main process, plain-Node CJS for the MCP server (no MCP SDK dependency — hand-rolled JSON-RPC, matching the zero-dep `browser-agent-cli.cjs` pattern).

**Spec:** `docs/superpowers/specs/2026-07-21-plugins-browser-mcp-design.md`

**Environment notes (critical):**
- Work on branch `plugins-browser-mcp` (already created; a repo hook blocks commits to main).
- System node is v16 and cannot run vitest/tsc. Before ANY build/test command:
  `export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"` (verify with `node --version` → v22.x).
- Run all commands from the repo root `/Users/jackou/Documents/projects/codey` unless a task says otherwise.
- Test commands: `npm test -w @codey/core`, `npm test -w @codey/gateway`, `npm test -w codey-mac` (or `npm test` for all).
- `packages/gateway` imports `@codey/core` from `packages/core/dist` — after changing core source, run `npm run build -w @codey/core` before gateway tests.

---

### Task 1: `plugins` section in gateway config

**Files:**
- Modify: `packages/gateway/src/config.ts`
- Test: `packages/gateway/src/plugins-config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/plugins-config.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './config';

describe('plugins config', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-plugins-cfg-'));
    file = path.join(dir, 'gateway.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to no plugins enabled', () => {
    const mgr = new ConfigManager(file);
    expect(mgr.isPluginEnabled('browser')).toBe(false);
  });

  it('persists plugin enablement through update()', () => {
    const mgr = new ConfigManager(file);
    mgr.update({ plugins: { browser: { enabled: true } } });
    expect(mgr.isPluginEnabled('browser')).toBe(true);

    const reloaded = new ConfigManager(file);
    expect(reloaded.isPluginEnabled('browser')).toBe(true);
  });

  it('coerces non-boolean enabled values to false on load', () => {
    fs.writeFileSync(file, JSON.stringify({ plugins: { browser: { enabled: 'yes' } } }));
    const mgr = new ConfigManager(file);
    expect(mgr.isPluginEnabled('browser')).toBe(false);
  });

  it('merges plugins updates without clobbering other plugin entries', () => {
    const mgr = new ConfigManager(file);
    mgr.update({ plugins: { browser: { enabled: true } } });
    mgr.update({ plugins: {} });
    expect(mgr.isPluginEnabled('browser')).toBe(true);
  });
});
```

Note: check how existing `ConfigManager` tests construct the manager (see other `*.test.ts` in `packages/gateway/src/`). If the constructor signature is not `new ConfigManager(filePath)`, mirror the construction used there — the assertions stay the same.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/gateway -- plugins-config`
Expected: FAIL — `isPluginEnabled` does not exist / `plugins` not accepted by `update()`.

- [ ] **Step 3: Implement**

In `packages/gateway/src/config.ts`:

(a) Add to `GatewayConfigJson` (after the `aide?` block):

```typescript
  /**
   * Optional capability packs ("plugins") exposed to agents as MCP servers.
   * Everything is off by default; the user enables plugins explicitly in the
   * Mac app's Tools → Plugins tab.
   */
  plugins?: {
    browser?: { enabled: boolean };
  };
```

(b) In `update()` (the method with the `if (partial.advisor !== undefined)` line), add:

```typescript
    if (partial.plugins !== undefined) {
      this.config.plugins = { ...this.config.plugins, ...partial.plugins };
    }
```

(c) In the raw-config sanitizer (the function containing `out.advisor = {` around line 592 — it maps untrusted `raw` JSON into a typed config), add alongside the advisor handling:

```typescript
  if (raw.plugins && typeof raw.plugins === 'object') {
    out.plugins = {
      browser: { enabled: raw.plugins.browser?.enabled === true },
    };
  }
```

(d) Add a public accessor on `ConfigManager` (near `getAgentConfig`):

```typescript
  /** True only when the user has explicitly enabled the named plugin. */
  isPluginEnabled(name: 'browser'): boolean {
    return this.config.plugins?.[name]?.enabled === true;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/gateway -- plugins-config`
Expected: PASS (4 tests). Also run the full gateway suite: `npm test -w @codey/gateway` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config.ts packages/gateway/src/plugins-config.test.ts
git commit -m "feat(gateway): add plugins section to gateway config"
```

---

### Task 2: `McpServerSpec` type + `mcpServers` on `AgentRequest`

**Files:**
- Modify: `packages/core/src/types/index.ts` (AgentRequest ends near line 162)

- [ ] **Step 1: Add the type and field**

In `packages/core/src/types/index.ts`, add a top-level exported interface (near the other exported interfaces, before `AgentRequest`):

```typescript
/** Definition of one MCP server an adapter should expose to the spawned CLI. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}
```

Then inside `AgentRequest`, after the `browserChatId?: string;` field, add:

```typescript
  /**
   * MCP servers to expose to this agent turn. Populated by AgentFactory from
   * enabled plugins; each adapter serializes the record into its CLI's native
   * MCP configuration mechanism. Absent when no plugin applies.
   */
  mcpServers?: Record<string, McpServerSpec>;
```

- [ ] **Step 2: Build core to verify it compiles**

Run: `npm run build -w @codey/core`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/index.ts
git commit -m "feat(core): add McpServerSpec and AgentRequest.mcpServers"
```

---

### Task 3: Replace prompt injection with `addCodeyBrowserMcp`

**Files:**
- Modify: `packages/core/src/agents/index.ts` (delete `addCodeyBrowserTools` + prompt block, lines 13–65; modify `AgentFactory.run`)
- Delete: `packages/core/src/agents/browser-tools.test.ts`
- Test: `packages/core/src/agents/browser-mcp.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/agents/browser-mcp.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { addCodeyBrowserMcp } from './index';
import { AgentRequest } from '../types';

const base = (): AgentRequest => ({
  prompt: 'do the thing',
  context: { workingDir: '/tmp/work' },
  browserTools: true,
} as AgentRequest);

const env = {
  CODEY_BROWSER_SOCKET: '/tmp/codey-browser.sock',
  CODEY_BROWSER_TOKEN: 'secret-token',
  CODEY_BROWSER_RUNTIME: '/Applications/Codey.app/Contents/MacOS/Codey',
  CODEY_BROWSER_MCP: '/Applications/Codey.app/browser-mcp-server.cjs',
} as NodeJS.ProcessEnv;

describe('addCodeyBrowserMcp', () => {
  it('attaches the codey-browser MCP server when the plugin is enabled', () => {
    const request = addCodeyBrowserMcp({ ...base(), browserChatId: 'chat-1' }, true, env);
    const server = request.mcpServers?.['codey-browser'];
    expect(server).toBeDefined();
    expect(server!.command).toBe(env.CODEY_BROWSER_RUNTIME);
    expect(server!.args).toEqual([env.CODEY_BROWSER_MCP]);
    expect(server!.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      CODEY_BROWSER_SOCKET: env.CODEY_BROWSER_SOCKET,
      CODEY_BROWSER_TOKEN: env.CODEY_BROWSER_TOKEN,
      CODEY_BROWSER_CHAT_ID: 'chat-1',
    });
  });

  it('never touches the prompt', () => {
    const request = addCodeyBrowserMcp(base(), true, env);
    expect(request.prompt).toBe('do the thing');
  });

  it('does nothing when the plugin is disabled', () => {
    const request = addCodeyBrowserMcp(base(), false, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('does nothing when the bridge env is missing', () => {
    const request = addCodeyBrowserMcp(base(), true, {} as NodeJS.ProcessEnv);
    expect(request.mcpServers).toBeUndefined();
  });

  it('excludes coordination turns (browserTools not set)', () => {
    const request = addCodeyBrowserMcp({ ...base(), browserTools: false }, true, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('excludes tool-restricted turns (allowedTools set)', () => {
    const request = addCodeyBrowserMcp({ ...base(), allowedTools: ['Read'] }, true, env);
    expect(request.mcpServers).toBeUndefined();
  });

  it('omits chat id env when no browserChatId is present', () => {
    const request = addCodeyBrowserMcp(base(), true, env);
    expect(request.mcpServers?.['codey-browser'].env).not.toHaveProperty('CODEY_BROWSER_CHAT_ID');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/core -- browser-mcp`
Expected: FAIL — `addCodeyBrowserMcp` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/agents/index.ts`:

(a) Delete the entire `BROWSER_PROMPT_MARKER` constant and `addCodeyBrowserTools` function (lines 13–65). Replace with:

```typescript
import { CodingAgent, AgentRequest, AgentResponse, McpServerSpec } from '../types';

/**
 * Attach the in-app browser MCP server to a task-performing agent turn.
 * Requires the user-enabled Browser plugin AND a live bridge (the Mac app
 * exports CODEY_BROWSER_* on the gateway process). Advisor, housekeeping,
 * and tool-restricted turns are excluded via the same browserTools /
 * allowedTools gating the old prompt injection used.
 */
export function addCodeyBrowserMcp(
  request: AgentRequest,
  pluginEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AgentRequest {
  const socket = env.CODEY_BROWSER_SOCKET;
  const token = env.CODEY_BROWSER_TOKEN;
  const runtime = env.CODEY_BROWSER_RUNTIME;
  const server = env.CODEY_BROWSER_MCP;
  if (!pluginEnabled || !socket || !token || !runtime || !server) return request;
  if (request.browserTools !== true || !request.context?.workingDir || request.allowedTools) {
    return request;
  }

  const spec: McpServerSpec = {
    command: runtime,
    args: [server],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CODEY_BROWSER_SOCKET: socket,
      CODEY_BROWSER_TOKEN: token,
      ...(request.browserChatId ? { CODEY_BROWSER_CHAT_ID: request.browserChatId } : {}),
    },
  };
  return {
    ...request,
    mcpServers: { ...(request.mcpServers ?? {}), 'codey-browser': spec },
  };
}
```

(Keep the existing top-of-file imports/exports; adjust the first import line to include `McpServerSpec` as shown.)

(b) In `AgentFactory`, add a provider next to `envProvider`:

```typescript
  private pluginEnabledProvider?: (plugin: string) => boolean;

  /**
   * Inject a callback that answers "is this plugin enabled?" from the live
   * config, so toggles in the renderer take effect on the next request.
   */
  setPluginEnabledProvider(provider: (plugin: string) => boolean): void {
    this.pluginEnabledProvider = provider;
  }
```

(c) In `AgentFactory.run()`, replace the line `request = addCodeyBrowserTools(request);` with:

```typescript
    request = addCodeyBrowserMcp(request, this.pluginEnabledProvider?.('browser') === true);
```

(d) Delete `packages/core/src/agents/browser-tools.test.ts` (`git rm packages/core/src/agents/browser-tools.test.ts`).

- [ ] **Step 4: Run tests and build**

Run: `npm test -w @codey/core` — all pass, including the 7 new tests.
Run: `npm run build -w @codey/core` — clean compile.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core/src/agents
git commit -m "feat(core): replace browser prompt injection with gated MCP server spec"
```

---

### Task 4: Gateway wires the plugin provider

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (constructor, ~line 551, right after `setAgentEnvProvider`)

- [ ] **Step 1: Implement**

In the `Codey` gateway constructor, immediately after the `this.agentFactory.setAgentEnvProvider(...)` block, add:

```typescript
    // Plugins are opt-in: the factory only attaches plugin MCP servers when
    // the user has enabled them in config. Read live so toggling in the
    // renderer applies on the next agent spawn without a restart.
    this.agentFactory.setPluginEnabledProvider((plugin) =>
      plugin === 'browser' && this.configManager?.isPluginEnabled('browser') === true
    );
```

- [ ] **Step 2: Build and test**

Run: `npm run build -w @codey/core && npm test -w @codey/gateway`
Expected: clean compile, all gateway tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): wire plugin enablement provider into AgentFactory"
```

---

### Task 5: MCP config serialization helpers

**Files:**
- Create: `packages/core/src/agents/mcp-config.ts`
- Test: `packages/core/src/agents/mcp-config.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/agents/mcp-config.test.ts`:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeClaudeMcpConfig, codexMcpArgs, writeOpenCodeMcpConfig } from './mcp-config';
import { McpServerSpec } from '../types';

const servers: Record<string, McpServerSpec> = {
  'codey-browser': {
    command: '/app/Codey',
    args: ['/app/browser-mcp-server.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', CODEY_BROWSER_TOKEN: 'tok' },
  },
};

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('writeClaudeMcpConfig', () => {
  it('writes a claude --mcp-config file', () => {
    const { args, cleanup } = writeClaudeMcpConfig(servers);
    cleanups.push(cleanup);
    expect(args[0]).toBe('--mcp-config');
    const parsed = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
    expect(parsed.mcpServers['codey-browser']).toEqual(servers['codey-browser']);
  });

  it('cleanup removes the temp file', () => {
    const { args, cleanup } = writeClaudeMcpConfig(servers);
    cleanup();
    expect(fs.existsSync(args[1])).toBe(false);
  });
});

describe('codexMcpArgs', () => {
  it('emits -c overrides with TOML-safe values', () => {
    const args = codexMcpArgs(servers);
    expect(args).toEqual([
      '-c', 'mcp_servers."codey-browser".command="/app/Codey"',
      '-c', 'mcp_servers."codey-browser".args=["/app/browser-mcp-server.cjs"]',
      '-c', 'mcp_servers."codey-browser".env={ELECTRON_RUN_AS_NODE="1",CODEY_BROWSER_TOKEN="tok"}',
    ]);
  });
});

describe('writeOpenCodeMcpConfig', () => {
  it('writes an OPENCODE_CONFIG json with local mcp servers', () => {
    const { env, cleanup } = writeOpenCodeMcpConfig(servers);
    cleanups.push(cleanup);
    const parsed = JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf-8'));
    expect(parsed.mcp['codey-browser']).toEqual({
      type: 'local',
      command: ['/app/Codey', '/app/browser-mcp-server.cjs'],
      enabled: true,
      environment: servers['codey-browser'].env,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @codey/core -- mcp-config`
Expected: FAIL — module `./mcp-config` not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/agents/mcp-config.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerSpec } from '../types';

/**
 * Write a Claude Code MCP config file and return the CLI args referencing it.
 * The temp dir is per-spawn; callers invoke cleanup() after the CLI exits.
 */
export function writeClaudeMcpConfig(
  servers: Record<string, McpServerSpec>,
): { args: string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-mcp-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return {
    args: ['--mcp-config', file],
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}

/**
 * Codex takes MCP servers as `-c` TOML overrides. JSON string/array encoding
 * is valid TOML for these value shapes; server names are quoted because they
 * may contain dashes.
 */
export function codexMcpArgs(servers: Record<string, McpServerSpec>): string[] {
  const args: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const key = `mcp_servers."${name}"`;
    args.push('-c', `${key}.command=${JSON.stringify(spec.command)}`);
    args.push('-c', `${key}.args=${JSON.stringify(spec.args)}`);
    const envBody = Object.entries(spec.env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(',');
    args.push('-c', `${key}.env={${envBody}}`);
  }
  return args;
}

/**
 * OpenCode reads extra config from the file named by OPENCODE_CONFIG. The
 * fragment only declares mcp servers; opencode merges it with its own config.
 */
export function writeOpenCodeMcpConfig(
  servers: Record<string, McpServerSpec>,
): { env: Record<string, string>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-mcp-'));
  const file = path.join(dir, 'opencode.json');
  const mcp: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mcp[name] = {
      type: 'local',
      command: [spec.command, ...spec.args],
      enabled: true,
      environment: spec.env,
    };
  }
  fs.writeFileSync(file, JSON.stringify({ mcp }));
  return {
    env: { OPENCODE_CONFIG: file },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @codey/core -- mcp-config`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/mcp-config.ts packages/core/src/agents/mcp-config.test.ts
git commit -m "feat(core): add per-adapter MCP config serialization helpers"
```

---

### Task 6: Adapters consume `request.mcpServers`

**Files:**
- Modify: `packages/core/src/agents/claude-code.ts` (`run()`, args built ~lines 64–95, close handler)
- Modify: `packages/core/src/agents/codex.ts` (`run()`, args built ~lines 58–74)
- Modify: `packages/core/src/agents/opencode.ts` (`run()`, args ~44–61, env at spawn ~69)

- [ ] **Step 1: claude-code**

In `claude-code.ts` `run()`:

(a) Import at top: `import { writeClaudeMcpConfig } from './mcp-config';`

(b) Immediately BEFORE the line `args.push('-p', request.prompt);` (the comment says `-p` must be last), add:

```typescript
      let mcpCleanup: (() => void) | undefined;
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        const mcp = writeClaudeMcpConfig(request.mcpServers);
        args.push(...mcp.args);
        mcpCleanup = mcp.cleanup;
      }
```

(c) In the existing `childProcess.on('close', ...)` handler that clears `this.activeProcess`, add `mcpCleanup?.();` as the first line.

- [ ] **Step 2: codex**

In `codex.ts` `run()`:

(a) Import at top: `import { codexMcpArgs } from './mcp-config';`

(b) Immediately BEFORE the line `args.push(request.prompt);`, add:

```typescript
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        args.push(...codexMcpArgs(request.mcpServers));
      }
```

- [ ] **Step 3: opencode**

In `opencode.ts` `run()`:

(a) Import at top: `import { writeOpenCodeMcpConfig } from './mcp-config';`

(b) Immediately BEFORE the line `args.push(request.prompt);`, add:

```typescript
      let mcpCleanup: (() => void) | undefined;
      let mcpEnv: Record<string, string> = {};
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        const mcp = writeOpenCodeMcpConfig(request.mcpServers);
        mcpEnv = mcp.env;
        mcpCleanup = mcp.cleanup;
      }
```

(c) Find where the spawn `env` object is finalized (the `spawn('opencode', args, { ..., env })` call at ~line 69 and the env construction above it) and merge `mcpEnv` LAST so it wins: `Object.assign(env, mcpEnv);` just before the `spawn` call.

(d) In the process `close` handler (mirror how claude-code clears `activeProcess`; opencode has an equivalent), add `mcpCleanup?.();`.

- [ ] **Step 4: Build and run all core tests**

Run: `npm run build -w @codey/core && npm test -w @codey/core`
Expected: clean compile, all tests pass (adapter behavior without `mcpServers` is unchanged, so existing adapter tests must stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/claude-code.ts packages/core/src/agents/codex.ts packages/core/src/agents/opencode.ts
git commit -m "feat(core): serialize AgentRequest.mcpServers in all three adapters"
```

---

### Task 7: The browser MCP server

**Files:**
- Create: `codey-mac/electron/browser-mcp-server.cjs`
- Test: `codey-mac/electron/browser-mcp-server.test.ts` (create)

The server is a dependency-free stdio JSON-RPC 2.0 implementation of MCP (protocol `2024-11-05`, tools capability only), proxying to the bridge Unix socket. It exports its internals for unit tests and only starts the stdio loop when run as main.

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/browser-mcp-server.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'

// The server is plain CJS so the packaged app can run it without a build step.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./browser-mcp-server.cjs')

const TOKEN = 'test-token'
let server: http.Server
let socketPath: string
let received: Array<{ method: string; route: string; body: any }>

beforeEach(async () => {
  received = []
  socketPath = path.join(os.tmpdir(), `codey-mcp-test-${randomBytes(5).toString('hex')}.sock`)
  server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const route = (req.url || '/').split('?')[0]
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      received.push({ method: req.method || '', route, body: raw ? JSON.parse(raw) : {} })
      if (route === '/screenshot') {
        const png = Buffer.from('fake-png')
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Codey-Viewport-Width': '1200',
          'X-Codey-Viewport-Height': '800',
          'X-Codey-Device-Scale-Factor': '2',
        })
        res.end(png)
        return
      }
      if (route === '/hover') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'element not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, route }))
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  process.env.CODEY_BROWSER_SOCKET = socketPath
  process.env.CODEY_BROWSER_TOKEN = TOKEN
  process.env.CODEY_BROWSER_CHAT_ID = 'chat-42'
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  delete process.env.CODEY_BROWSER_SOCKET
  delete process.env.CODEY_BROWSER_TOKEN
  delete process.env.CODEY_BROWSER_CHAT_ID
})

describe('protocol handshake', () => {
  it('answers initialize with tools capability', async () => {
    const res = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(res.result.protocolVersion).toBe('2024-11-05')
    expect(res.result.capabilities.tools).toBeDefined()
    expect(res.result.serverInfo.name).toBe('codey-browser')
  })

  it('lists exactly the 8 condensed tools', async () => {
    const res = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(res.result.tools.map((t: any) => t.name).sort()).toEqual([
      'browser_files', 'browser_interact', 'browser_login_wait', 'browser_navigate',
      'browser_open', 'browser_read', 'browser_tabs', 'browser_wait',
    ])
    for (const tool of res.result.tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('returns null for notifications', async () => {
    const res = await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res).toBeNull()
  })
})

describe('tool routing', () => {
  const call = (name: string, args: any) =>
    mcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })

  it('browser_open routes to /open, and /open-view when view=true', async () => {
    await call('browser_open', { url: 'https://a.example' })
    await call('browser_open', { url: 'https://b.example', view: true })
    expect(received.map(r => r.route)).toEqual(['/open', '/open-view'])
    expect(received[0].body).toEqual({ url: 'https://a.example' })
  })

  it('browser_read modes route to their GET endpoints', async () => {
    await call('browser_read', { mode: 'view' })
    await call('browser_read', { mode: 'snapshot' })
    await call('browser_read', { mode: 'state' })
    await call('browser_read', { mode: 'viewport' })
    expect(received.map(r => r.route)).toEqual(['/view', '/snapshot', '/state', '/viewport'])
    expect(received.every(r => r.method === 'GET')).toBe(true)
  })

  it('browser_read screenshot returns inline image content plus viewport text', async () => {
    const res = await call('browser_read', { mode: 'screenshot' })
    const image = res.result.content.find((c: any) => c.type === 'image')
    expect(image.mimeType).toBe('image/png')
    expect(Buffer.from(image.data, 'base64').toString()).toBe('fake-png')
    const text = res.result.content.find((c: any) => c.type === 'text')
    expect(text.text).toContain('1200')
  })

  it('browser_interact maps actions to routes and payloads', async () => {
    await call('browser_interact', { action: 'click', ref: 'e1' })
    await call('browser_interact', { action: 'fill', ref: 'e2', value: 'hi' })
    await call('browser_interact', { action: 'uncheck', ref: 'e3' })
    await call('browser_interact', { action: 'click_at', x: 10, y: 20, clickCount: 2 })
    await call('browser_interact', { action: 'drag', x: 1, y: 2, toX: 3, toY: 4 })
    await call('browser_interact', { action: 'scroll', deltaY: 100 })
    expect(received.map(r => [r.route, r.body])).toEqual([
      ['/click', { ref: 'e1' }],
      ['/fill', { ref: 'e2', value: 'hi' }],
      ['/check', { ref: 'e3', checked: false }],
      ['/click-at', { x: 10, y: 20, clickCount: 2 }],
      ['/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 12 }],
      ['/scroll', { deltaY: 100, deltaX: 0 }],
    ])
  })

  it('browser_wait passes kind/value/state/timeout through', async () => {
    await call('browser_wait', { for: 'text', value: 'Done', state: 'visible', timeoutMs: 5000 })
    expect(received[0].route).toBe('/wait')
    expect(received[0].body).toEqual({ kind: 'text', value: 'Done', state: 'visible', timeoutMs: 5000 })
  })

  it('browser_navigate and browser_tabs route correctly', async () => {
    await call('browser_navigate', { action: 'back' })
    await call('browser_tabs', { action: 'list' })
    await call('browser_tabs', { action: 'switch', id: 't2' })
    expect(received.map(r => r.route)).toEqual(['/back', '/tabs', '/tab/switch'])
  })

  it('browser_files handles upload/downloads/wait_download', async () => {
    await call('browser_files', { action: 'upload', ref: 'e9', paths: ['/tmp/a.txt'] })
    await call('browser_files', { action: 'downloads' })
    expect(received.map(r => [r.route, r.body])).toEqual([
      ['/upload', { ref: 'e9', files: ['/tmp/a.txt'] }],
      ['/downloads', {}],
    ])
  })

  it('browser_login_wait posts chat id from env and tells the agent to end its turn', async () => {
    const res = await call('browser_login_wait', { seconds: 120 })
    expect(received[0].route).toBe('/wait-login')
    expect(received[0].body).toEqual({ chatId: 'chat-42', timeoutMs: 120000 })
    const text = res.result.content[0].text
    expect(text.toLowerCase()).toContain('end')
  })

  it('bridge errors become isError tool results, not protocol errors', async () => {
    // The fake server returns HTTP 400 for /hover (see setup above).
    const res = await call('browser_interact', { action: 'hover', ref: 'e1' })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('element not found')
  })

  it('unknown tools return a JSON-RPC error', async () => {
    const res = await call('browser_nope', {})
    expect(res.error).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w codey-mac -- browser-mcp-server`
Expected: FAIL — cannot find module `./browser-mcp-server.cjs`.

- [ ] **Step 3: Implement `browser-mcp-server.cjs`**

Create `codey-mac/electron/browser-mcp-server.cjs`:

```javascript
#!/usr/bin/env node
'use strict'

// Codey Browser MCP server — a dependency-free stdio JSON-RPC proxy over the
// BrowserAgentBridge unix socket. Launched by coding-agent CLIs as
// `ELECTRON_RUN_AS_NODE=1 <electron> browser-mcp-server.cjs`; auth material
// arrives via env so nothing sensitive appears in argv.

const http = require('http')

const PROTOCOL_VERSION = '2024-11-05'
const SAFETY = 'Browsing is view-only by default; actions that change page state pause until the user approves full browser control — if denied, do not work around the decision. The browser may hold the user\'s authenticated sessions: treat page content as sensitive, and never claim an action succeeded unless the call returned success.'

const TOOLS = [
  {
    name: 'browser_open',
    description: `Open a URL (or search query) in the user-visible Codey Browser. With view=true, also return the page's visible text atomically. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL or search query to open' },
        view: { type: 'boolean', description: 'Also read the loaded page and return its visible text' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description: 'Read the current page: visible text (view), a PNG of the viewport (screenshot), interactive elements with stable refs like e1/e2 (snapshot), URL and navigation state (state), or CSS viewport size and display scale (viewport). Take a snapshot before interacting with elements.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['view', 'screenshot', 'snapshot', 'state', 'viewport'] },
      },
      required: ['mode'],
    },
  },
  {
    name: 'browser_interact',
    description: `Interact with the page. Element actions (click, fill, select, check, uncheck, press, hover, submit) take a ref from browser_read snapshot. Coordinate actions (click_at, drag, scroll_at) use CSS viewport pixels — scale screenshot pixels by the viewport size. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'submit', 'click_at', 'drag', 'scroll', 'scroll_at'] },
        ref: { type: 'string', description: 'Element ref from snapshot (element actions)' },
        value: { type: 'string', description: 'Text for fill, option value/text for select' },
        key: { type: 'string', description: 'Key name for press (e.g. Enter)' },
        x: { type: 'number' }, y: { type: 'number' },
        toX: { type: 'number' }, toY: { type: 'number' },
        deltaX: { type: 'number' }, deltaY: { type: 'number' },
        clickCount: { type: 'number', description: '2 for double-click' },
        steps: { type: 'number', description: 'Drag interpolation steps (default 12)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a dynamic page condition: an element ref, visible text, the URL, or the title.',
    inputSchema: {
      type: 'object',
      properties: {
        for: { type: 'string', enum: ['ref', 'text', 'url', 'title'] },
        value: { type: 'string' },
        state: { type: 'string', enum: ['visible', 'hidden', 'enabled'] },
        timeoutMs: { type: 'number' },
      },
      required: ['for', 'value'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate browser history: back, forward, or reload the current page.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } },
      required: ['action'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'Manage browser tabs: list them, open a new tab, switch the visible tab, or close one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
        id: { type: 'string', description: 'Tab id (switch/close)' },
        url: { type: 'string', description: 'URL for the new tab' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_files',
    description: 'File transfer: upload local files to a file input (needs user approval), list downloads, or wait for a download to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['upload', 'downloads', 'wait_download'] },
        ref: { type: 'string', description: 'File-input ref (upload)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths (upload)' },
        timeoutMs: { type: 'number', description: 'Wait budget for wait_download' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_login_wait',
    description: 'When the task is blocked only by a user login: start watching the login page, tell the user Codey is watching, and END YOUR TURN. Codey re-runs this chat automatically once the login completes. Do not poll or busy-loop.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Watch budget in seconds (default 300)' } },
    },
  },
]

function bridgeRequest(method, route, body, binary) {
  const socketPath = process.env.CODEY_BROWSER_SOCKET
  const token = process.env.CODEY_BROWSER_TOKEN
  if (!socketPath || !token) {
    return Promise.reject(new Error('Codey Browser bridge is not available (missing socket/token)'))
  }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      // Mutating calls block on the in-app permission gate; give them ample room.
      timeout: 600000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          if (binary) return resolve({ buffer: buf, headers: res.headers })
          try { return resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {}) }
          catch { return resolve({ raw: buf.toString('utf8') }) }
        }
        let message = `Browser bridge error (HTTP ${res.statusCode})`
        try { message = JSON.parse(buf.toString('utf8')).error || message } catch { /* keep default */ }
        reject(new Error(message))
      })
    })
    req.on('timeout', () => { req.destroy(new Error('Browser bridge request timed out')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text', text }] }
}

const INTERACT_ROUTES = {
  click:    a => ['/click', { ref: String(a.ref || '') }],
  fill:     a => ['/fill', { ref: String(a.ref || ''), value: String(a.value ?? '') }],
  select:   a => ['/select', { ref: String(a.ref || ''), value: String(a.value ?? '') }],
  check:    a => ['/check', { ref: String(a.ref || ''), checked: true }],
  uncheck:  a => ['/check', { ref: String(a.ref || ''), checked: false }],
  press:    a => ['/press', { key: String(a.key || ''), ...(a.ref ? { ref: String(a.ref) } : {}) }],
  hover:    a => ['/hover', { ref: String(a.ref || '') }],
  submit:   a => ['/submit', { ref: String(a.ref || '') }],
  click_at: a => ['/click-at', { x: Number(a.x), y: Number(a.y), clickCount: Number(a.clickCount) || 1 }],
  drag:     a => ['/drag', { fromX: Number(a.x), fromY: Number(a.y), toX: Number(a.toX), toY: Number(a.toY), steps: Number(a.steps) || 12 }],
  scroll:   a => ['/scroll', { deltaY: Number(a.deltaY) || 0, deltaX: Number(a.deltaX) || 0 }],
  scroll_at: a => ['/scroll-at', { x: Number(a.x), y: Number(a.y), deltaY: Number(a.deltaY) || 0, deltaX: Number(a.deltaX) || 0 }],
}

async function callTool(name, args) {
  const a = args || {}
  switch (name) {
    case 'browser_open':
      return textResult(await bridgeRequest('POST', a.view ? '/open-view' : '/open', { url: String(a.url || '') }))
    case 'browser_read': {
      const mode = String(a.mode || '')
      if (mode === 'screenshot') {
        const { buffer, headers } = await bridgeRequest('GET', '/screenshot', undefined, true)
        const viewport = `Viewport: ${headers['x-codey-viewport-width']}x${headers['x-codey-viewport-height']} CSS px, device scale ${headers['x-codey-device-scale-factor']}. Coordinates for browser_interact are CSS viewport pixels.`
        return {
          content: [
            { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: viewport },
          ],
        }
      }
      const routes = { view: '/view', snapshot: '/snapshot', state: '/state', viewport: '/viewport' }
      if (!routes[mode]) throw new Error(`Unknown read mode: ${mode}`)
      return textResult(await bridgeRequest('GET', routes[mode]))
    }
    case 'browser_interact': {
      const make = INTERACT_ROUTES[String(a.action || '')]
      if (!make) throw new Error(`Unknown interact action: ${a.action}`)
      const [route, body] = make(a)
      return textResult(await bridgeRequest('POST', route, body))
    }
    case 'browser_wait':
      return textResult(await bridgeRequest('POST', '/wait', {
        kind: String(a.for || ''),
        value: String(a.value || ''),
        ...(a.state ? { state: String(a.state) } : {}),
        ...(a.timeoutMs ? { timeoutMs: Number(a.timeoutMs) } : {}),
      }))
    case 'browser_navigate': {
      const routes = { back: '/back', forward: '/forward', reload: '/reload' }
      const route = routes[String(a.action || '')]
      if (!route) throw new Error(`Unknown navigate action: ${a.action}`)
      return textResult(await bridgeRequest('POST', route, {}))
    }
    case 'browser_tabs': {
      const action = String(a.action || '')
      if (action === 'list') return textResult(await bridgeRequest('GET', '/tabs'))
      if (action === 'new') return textResult(await bridgeRequest('POST', '/tab/new', { url: String(a.url || 'about:blank') }))
      if (action === 'switch') return textResult(await bridgeRequest('POST', '/tab/switch', { id: String(a.id || '') }))
      if (action === 'close') return textResult(await bridgeRequest('POST', '/tab/close', { id: String(a.id || '') }))
      throw new Error(`Unknown tabs action: ${action}`)
    }
    case 'browser_files': {
      const action = String(a.action || '')
      if (action === 'upload') {
        const paths = Array.isArray(a.paths) ? a.paths.map(String) : []
        return textResult(await bridgeRequest('POST', '/upload', { ref: String(a.ref || ''), files: paths }))
      }
      if (action === 'downloads') return textResult(await bridgeRequest('GET', '/downloads'))
      if (action === 'wait_download') return textResult(await bridgeRequest('POST', '/wait-download', { timeoutMs: Number(a.timeoutMs) || 60000 }))
      throw new Error(`Unknown files action: ${action}`)
    }
    case 'browser_login_wait': {
      const chatId = process.env.CODEY_BROWSER_CHAT_ID || ''
      const seconds = Number(a.seconds) || 300
      const watch = await bridgeRequest('POST', '/wait-login', { chatId, timeoutMs: seconds * 1000 })
      return textResult(
        `Codey is watching the login page (${JSON.stringify(watch)}). Tell the user Codey is waiting for them to log in, then END YOUR TURN now — this chat is re-run automatically once the login completes. Do not poll.`,
      )
    }
    default:
      return null
  }
}

async function handleMessage(message) {
  const { id, method, params } = message || {}
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } })

  if (typeof method !== 'string') return fail(-32600, 'Invalid request')
  if (method.startsWith('notifications/')) return null
  if (method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'codey-browser', version: '1.0.0' },
    })
  }
  if (method === 'tools/list') return reply({ tools: TOOLS })
  if (method === 'ping') return reply({})
  if (method === 'tools/call') {
    const name = params && params.name
    try {
      const result = await callTool(name, params && params.arguments)
      if (result === null) return fail(-32602, `Unknown tool: ${name}`)
      return reply(result)
    } catch (error) {
      return reply({
        content: [{ type: 'text', text: `Error: ${error && error.message ? error.message : String(error)}` }],
        isError: true,
      })
    }
  }
  return fail(-32601, `Method not found: ${method}`)
}

function startStdioLoop() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      void handleMessage(message).then(response => {
        if (response) process.stdout.write(JSON.stringify(response) + '\n')
      })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

module.exports = { TOOLS, callTool, handleMessage }

if (require.main === module) startStdioLoop()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w codey-mac -- browser-mcp-server`
Expected: PASS (all tests). If vitest refuses to `require` the `.cjs`, check how `browser-agent-cli` (or other `.cjs`) is handled in `codey-mac/vitest.config.*` / existing tests and mirror it; the fallback is `const mcp = await import('./browser-mcp-server.cjs')` with `createRequire`.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/browser-mcp-server.cjs codey-mac/electron/browser-mcp-server.test.ts
git commit -m "feat(mac): add dependency-free browser MCP stdio server"
```

---

### Task 8: Ship the MCP server and export its path

**Files:**
- Modify: `codey-mac/electron/main.ts` (~line 80 `browserAgentCliPath`, ~line 1441 env exports)
- Modify: `codey-mac/package.json` (extraResources list, ~line 118)

- [ ] **Step 1: Add path helper and env export**

In `main.ts`, next to `browserAgentCliPath()` (~line 80), add:

```typescript
function browserMcpServerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'browser-mcp-server.cjs')
    : join(app.getAppPath(), 'electron', 'browser-mcp-server.cjs')
}
```

(Match the exact `app.isPackaged` conditional style used by `browserAgentCliPath` — copy its shape.)

In the bridge startup block (~line 1441), after `process.env.CODEY_BROWSER_CLI = browserAgentCliPath()`, add:

```typescript
    process.env.CODEY_BROWSER_MCP = browserMcpServerPath()
```

- [ ] **Step 2: Package the file**

In `codey-mac/package.json`, in the `extraResources` array containing the `browser-agent-cli.cjs` entry, add:

```json
      {
        "from": "electron/browser-mcp-server.cjs",
        "to": "browser-mcp-server.cjs"
      }
```

- [ ] **Step 3: Verify compile**

Run: `npm run build -w codey-mac` (or the codey-mac typecheck script if build is heavyweight — check `codey-mac/package.json` scripts; `tsc --noEmit` on the electron tsconfig is sufficient).
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/package.json
git commit -m "feat(mac): ship browser MCP server and export CODEY_BROWSER_MCP"
```

---

### Task 9: Plugins IPC (registry + enable/disable)

**Files:**
- Create: `codey-mac/electron/plugins.ts`
- Modify: `codey-mac/electron/main.ts` (IPC section, near `config:get` ~line 2492)
- Modify: `codey-mac/electron/preload.ts`
- Modify: `codey-mac/src/codey-api.d.ts`
- Test: `codey-mac/electron/plugins.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/plugins.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { PLUGINS, listPlugins } from './plugins'

describe('plugin registry', () => {
  it('registers exactly the browser plugin', () => {
    expect(PLUGINS.map(p => p.id)).toEqual(['browser'])
    expect(PLUGINS[0].name).toBe('Browser')
    expect(PLUGINS[0].description.length).toBeGreaterThan(10)
  })

  it('merges enabled state from config', () => {
    expect(listPlugins({ plugins: { browser: { enabled: true } } })[0].enabled).toBe(true)
    expect(listPlugins({ plugins: { browser: { enabled: false } } })[0].enabled).toBe(false)
    expect(listPlugins({})[0].enabled).toBe(false)
    expect(listPlugins(undefined)[0].enabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w codey-mac -- plugins`
Expected: FAIL — module `./plugins` not found.

- [ ] **Step 3: Implement the registry**

Create `codey-mac/electron/plugins.ts`:

```typescript
export interface PluginInfo {
  id: 'browser'
  name: string
  description: string
  enabled: boolean
}

/** Static registry of Codey plugins. Enablement lives in gateway config. */
export const PLUGINS: Array<Omit<PluginInfo, 'enabled'>> = [
  {
    id: 'browser',
    name: 'Browser',
    description:
      'Let agents see and control the in-app Codey Browser through typed MCP tools. '
      + 'Browsing stays view-only by default; actions that change page state still '
      + 'require your approval in the app.',
  },
]

export function listPlugins(config: { plugins?: Record<string, { enabled?: boolean }> } | undefined): PluginInfo[] {
  return PLUGINS.map(plugin => ({
    ...plugin,
    enabled: config?.plugins?.[plugin.id]?.enabled === true,
  }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w codey-mac -- plugins`
Expected: PASS.

- [ ] **Step 5: Wire IPC handlers**

In `main.ts`, next to the Config IPC section (~line 2492), add:

```typescript
  // ── Plugins IPC ───────────────────────────────────────────────────
  ipcMain.handle('plugins:list', async () =>
    wrap(async () => listPlugins(coreConfigManager?.get() as any))
  )

  ipcMain.handle('plugins:setEnabled', async (_e, id: string, enabled: boolean) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      if (id !== 'browser') throw new Error(`Unknown plugin: ${id}`)
      coreConfigManager.update({ plugins: { [id]: { enabled: enabled === true } } } as any)
    })
  )
```

Add the import at the top of `main.ts`: `import { listPlugins } from './plugins'`.

- [ ] **Step 6: Expose in preload + types**

In `preload.ts`, inside the exposed `codey` object (same level as `workers`/`workspaces`), add:

```typescript
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  },
```

In `codey-mac/src/codey-api.d.ts`, follow the existing declaration style (find the `skills` section and mirror it):

```typescript
export interface PluginInfo {
  id: string
  name: string
  description: string
  enabled: boolean
}
```

and in the `codey` API surface:

```typescript
  plugins: {
    list(): Promise<Result<PluginInfo[]>>
    setEnabled(id: string, enabled: boolean): Promise<Result<void>>
  }
```

Note: `codey-api.d.ts` wraps results in whatever envelope the other IPC calls use (the renderer calls `unwrap(...)` on them) — inspect how `skills.list` is typed there and use the identical wrapper type; the names above (`Result`) are stand-ins for that existing wrapper.

- [ ] **Step 7: Verify compile + tests**

Run: `npm test -w codey-mac && npm run build -w codey-mac`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add codey-mac/electron/plugins.ts codey-mac/electron/plugins.test.ts codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(mac): plugin registry with list/setEnabled IPC"
```

---

### Task 10: Plugins tab UI

**Files:**
- Create: `codey-mac/src/components/PluginsTab.tsx`
- Modify: `codey-mac/src/components/ToolsView.tsx`

- [ ] **Step 1: Create `PluginsTab.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import type { PluginInfo } from '../codey-api'

export const PluginsTab: React.FC = () => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPlugins(unwrap(await window.codey.plugins.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = async (plugin: PluginInfo) => {
    setBusy(plugin.id)
    setError(null)
    try {
      unwrap(await window.codey.plugins.setEnabled(plugin.id, !plugin.enabled))
      await reload()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading && plugins.length === 0) return <div style={styles.note}>Loading plugins…</div>

  return (
    <div>
      <div style={styles.intro}>
        Plugins give agents extra capabilities. Everything is off until you enable it;
        changes apply to the next agent run.
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {plugins.map(plugin => (
        <div key={plugin.id} style={styles.card}>
          <div style={styles.cardIcon}><UIIcon name="tools" size={18} /></div>
          <div style={styles.cardBody}>
            <div style={styles.cardName}>{plugin.name}</div>
            <div style={styles.cardDesc}>{plugin.description}</div>
          </div>
          <button
            onClick={() => void toggle(plugin)}
            disabled={busy === plugin.id}
            style={{ ...styles.toggle, ...(plugin.enabled ? styles.toggleOn : null) }}
          >
            <span style={{ ...styles.knob, ...(plugin.enabled ? styles.knobOn : null) }} />
          </button>
        </div>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  note: { color: C.fg3, fontSize: 12, padding: 8 },
  intro: { color: C.fg2, fontSize: 12, marginBottom: 14 },
  error: { color: C.danger, fontSize: 12, marginBottom: 10 },
  card: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
    border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface2, marginBottom: 10,
  },
  cardIcon: { color: C.accent, flexShrink: 0 },
  cardBody: { flex: 1, minWidth: 0 },
  cardName: { color: C.fg, fontSize: 13, fontWeight: 700, marginBottom: 3 },
  cardDesc: { color: C.fg3, fontSize: 11.5, lineHeight: 1.45 },
  toggle: {
    width: 40, height: 24, borderRadius: 12, border: `1px solid ${C.border}`,
    background: C.surface3 ?? C.bg, cursor: 'pointer', position: 'relative', flexShrink: 0, padding: 0,
  },
  toggleOn: { background: C.accent, border: `1px solid ${C.accent}` },
  knob: {
    position: 'absolute', top: 2, left: 2, width: 18, height: 18, borderRadius: 9,
    background: C.fg, transition: 'left 120ms ease',
  },
  knobOn: { left: 18, background: C.onAccent },
}
```

Adjust theme token names (`C.danger`, `C.surface3`, `C.onAccent`) to whatever `src/theme.ts` actually exports — check the file and use the closest existing tokens; do not add new theme tokens.

- [ ] **Step 2: Add the tab to `ToolsView.tsx`**

```tsx
// import
import { PluginsTab } from './PluginsTab'

// type
type Tab = 'skills' | 'playbooks' | 'plugins'

// TABS array — add:
  { key: 'plugins', label: 'Plugins', icon: 'tools', description: 'Optional agent capabilities' },

// body — add:
        {tab === 'plugins' && <PluginsTab />}
```

(If `'tools'` is not a valid `IconName`, pick an existing one from `UIIcons.tsx` — e.g. `'sparkle'`-adjacent hardware/plug icon; check the union type.)

- [ ] **Step 3: Verify compile and run the app**

Run: `npm run build -w codey-mac`
Expected: clean. Then launch the dev app (see `codey-mac/package.json` scripts, typically `npm run dev -w codey-mac`), open Tools → Plugins, toggle Browser on, and confirm `gateway.json` gains `"plugins": { "browser": { "enabled": true } }`.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/PluginsTab.tsx codey-mac/src/components/ToolsView.tsx
git commit -m "feat(mac): Plugins tab with Browser plugin toggle"
```

---

### Task 11: End-to-end verification and cleanup sweep

**Files:**
- Verify only (no planned edits; fix what the sweep finds)

- [ ] **Step 1: Stale-reference sweep**

Run: `grep -rn "codey_browser_tools\|addCodeyBrowserTools\|BROWSER_PROMPT_MARKER" packages codey-mac --include="*.ts" --include="*.tsx" --include="*.cjs"`
Expected: zero hits outside `dist/` build artifacts. If `codey-mac` or gateway code references the old function, fix those sites to compile against the new API.

Also verify the old CLI remains intact but un-advertised: `browser-agent-cli.cjs` is still shipped (it powers nothing agent-facing now; leaving it is deliberate per spec).

- [ ] **Step 2: Full test suite + builds**

```bash
export PATH="$HOME/.nvm/versions/node/v22.17.1/bin:$PATH"
npm run build -w @codey/core && npm run build -w @codey/gateway && npm test
```

Expected: every workspace green.

- [ ] **Step 3: Manual smoke test (requires the Mac app)**

1. `npm run dev -w codey-mac`, enable Tools → Plugins → Browser.
2. In a chat, ask the agent: "Open example.com in the browser and tell me the page title."
3. Confirm: the in-app browser opens, the agent's tool calls appear as `mcp__codey-browser__browser_open` / `browser_read` (claude-code), and the reply contains real page content.
4. Toggle the plugin off, repeat the ask, and confirm the agent reports it has no browser access.

- [ ] **Step 4: Commit any sweep fixes**

```bash
git add -A
git commit -m "chore: cleanup after browser MCP plugin migration"
```

(Skip the commit if the sweep found nothing.)
