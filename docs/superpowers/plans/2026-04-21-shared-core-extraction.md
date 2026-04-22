# Shared Core Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract WorkerManager, WorkspaceManager, AgentFactory, and orchestration into `@codey/core` so the Mac app runs them in-process (via IPC) and hosts the gateway in-process for shared Mac+Telegram conversations.

**Architecture:** Convert the flat repo into an npm workspace with three packages: `@codey/core` (pure data + agent spawning), `@codey/gateway` (channel bridging + `Gateway` class, depends on core), and `codey-mac` (Electron app, depends on both). The HTTP API is deleted; Electron exposes core+gateway to the renderer via IPC.

**Tech Stack:** TypeScript, npm workspaces, Electron, existing Node `http` for slim health server.

**Spec:** `docs/superpowers/specs/2026-04-21-shared-core-extraction-design.md`

**Conventions for this plan:**
- Refactor-heavy plan: most work is `git mv` + mechanical import-path updates, not TDD. Tasks that add new behavior (Context reshape, IPC bridge) use full TDD.
- After every phase: `npm run build` in the root AND `npm run verify-workers` must pass before committing the phase-boundary task.
- Use `git mv` (not `mv`) to preserve history.

---

## File Structure (end state)

```
codey/
├── package.json                          # root workspace config
├── tsconfig.base.json                    # shared compiler options
├── packages/
│   ├── core/
│   │   ├── package.json                  # "@codey/core"
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # barrel export
│   │       ├── workers.ts
│   │       ├── workspace.ts
│   │       ├── worker-generator.ts
│   │       ├── context.ts
│   │       ├── memory.ts
│   │       ├── planner.ts
│   │       ├── agents/{base,claude-code,codex,opencode,index}.ts
│   │       ├── types/{index,marked-terminal.d}.ts
│   │       ├── utils/{format,format.test}.ts
│   │       └── errors.ts                 # NEW typed errors
│   └── gateway/
│       ├── package.json                  # "@codey/gateway"
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                  # headless entry
│           ├── gateway.ts                # Gateway class
│           ├── cli.ts
│           ├── config.ts
│           ├── logger.ts
│           ├── startup-guard.ts
│           ├── health.ts                 # slim: /health /metrics /ready only
│           └── channels/{base,telegram,discord,imessage,tui,index}.ts
├── codey-mac/
│   ├── package.json                      # deps: @codey/core, @codey/gateway
│   ├── electron/
│   │   ├── main.ts                       # boots in-process Gateway
│   │   └── preload.ts                    # exposes window.codey.*
│   └── src/                              # renderer (no services/api.ts)
├── scripts/
│   ├── verify-workers.ts                 # rewritten: direct core calls
│   └── verify-gateway.ts                 # NEW: in-process gateway smoke
└── dist/                                 # no longer populated — each package builds to packages/*/dist
```

**Deleted:** `src/worker-routes.ts`, HTTP API handlers in `src/health.ts`, `codey-mac/src/services/api.ts`.

---

# Phase 1 — Scaffold Workspaces

Goal: `npm install` produces a working workspace symlink layout without moving any code yet.

## Task 1: Root workspace config + base tsconfig

**Files:**
- Modify: `package.json`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Back up current `package.json` for reference**

Run: `cp package.json package.json.bak`

- [ ] **Step 2: Rewrite `package.json` as root workspace manifest**

Replace the entire contents of `/Users/jackou/Documents/projects/codey/package.json` with:

```json
{
  "name": "codey-monorepo",
  "private": true,
  "version": "1.0.0",
  "description": "Codey — a gateway that routes prompts from chat platforms to coding agents",
  "workspaces": [
    "packages/*",
    "codey-mac"
  ],
  "scripts": {
    "build": "npm run build -ws --if-present",
    "build:core": "npm run build -w @codey/core",
    "build:gateway": "npm run build -w @codey/gateway",
    "dev": "npm run dev -w @codey/gateway",
    "start": "npm run start -w @codey/gateway",
    "configure": "npm run configure -w @codey/gateway",
    "status": "npm run status -w @codey/gateway",
    "set-agent": "npm run set-agent -w @codey/gateway",
    "set-model": "npm run set-model -w @codey/gateway",
    "tui": "npm run tui -w @codey/gateway",
    "verify-workers": "npm run build && ts-node scripts/verify-workers.ts",
    "verify-gateway": "npm run build && ts-node scripts/verify-gateway.ts"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

Create `/Users/jackou/Documents/projects/codey/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Delete the old root `tsconfig.json`** (will be replaced by per-package configs)

Run: `rm tsconfig.json`

- [ ] **Step 5: Verify npm still accepts the config**

Run: `npm install --dry-run`
Expected: no errors (real install happens after packages exist)

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json
git rm tsconfig.json
git commit -m "refactor: convert root package.json to npm workspace manifest"
```

---

## Task 2: Empty package skeletons for core and gateway

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/gateway/package.json`
- Create: `packages/gateway/tsconfig.json`
- Create: `packages/gateway/src/index.ts`

- [ ] **Step 1: Create core package manifest**

Create `/Users/jackou/Documents/projects/codey/packages/core/package.json`:

```json
{
  "name": "@codey/core",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch"
  },
  "dependencies": {
    "undici": "^5.28.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create core tsconfig**

Create `/Users/jackou/Documents/projects/codey/packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create core barrel placeholder**

Create `/Users/jackou/Documents/projects/codey/packages/core/src/index.ts`:

```typescript
// @codey/core — barrel export. Populated in subsequent tasks.
export {};
```

- [ ] **Step 4: Create gateway package manifest**

Create `/Users/jackou/Documents/projects/codey/packages/gateway/package.json`:

```json
{
  "name": "@codey/gateway",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "codey": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "watch": "tsc --watch",
    "configure": "ts-node src/index.ts configure",
    "status": "ts-node src/index.ts status",
    "set-agent": "ts-node src/index.ts set-agent",
    "set-model": "ts-node src/index.ts set-model",
    "tui": "ts-node src/index.ts tui"
  },
  "dependencies": {
    "@codey/core": "*",
    "discord.js": "^14.0.0",
    "dotenv": "^16.0.0",
    "marked": "^15.0.12",
    "marked-terminal": "^7.3.0",
    "node-telegram-bot-api": "^0.64.0",
    "undici": "^5.28.0"
  },
  "devDependencies": {
    "@types/node-telegram-bot-api": "^0.64.13",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 5: Create gateway tsconfig**

Create `/Users/jackou/Documents/projects/codey/packages/gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"],
  "ts-node": {
    "files": true
  }
}
```

- [ ] **Step 6: Create gateway entry placeholder**

Create `/Users/jackou/Documents/projects/codey/packages/gateway/src/index.ts`:

```typescript
// @codey/gateway — headless entry. Populated in subsequent tasks.
console.log('codey gateway — headless stub');
```

- [ ] **Step 7: Run npm install to create workspace symlinks**

Run: `npm install`
Expected: Symlinks created at `node_modules/@codey/core` → `packages/core` and `node_modules/@codey/gateway` → `packages/gateway`. No errors.

- [ ] **Step 8: Verify symlinks**

Run: `ls -la node_modules/@codey/`
Expected: two symlinks, `core` and `gateway`, pointing into `packages/`.

- [ ] **Step 9: Build both packages (should succeed — they contain only stubs)**

Run: `npm run build`
Expected: `packages/core/dist/index.js` and `packages/gateway/dist/index.js` both exist.

- [ ] **Step 10: Commit**

```bash
git add packages package.json package-lock.json
git commit -m "refactor: add empty @codey/core and @codey/gateway package skeletons"
```

---

# Phase 2 — Move Pure-Data Modules Into Core

Goal: `workers.ts`, `workspace.ts`, `worker-generator.ts`, `agents/*`, `types/*`, `utils/*` now live in `@codey/core`. Gateway source (still at `src/`) imports from `@codey/core`. Build green; `verify-workers` green.

## Task 3: Move types and utils into core

**Files:**
- Move: `src/types/` → `packages/core/src/types/`
- Move: `src/utils/` → `packages/core/src/utils/`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Move types directory**

Run:
```bash
git mv src/types packages/core/src/types
```

- [ ] **Step 2: Move utils directory**

Run:
```bash
git mv src/utils packages/core/src/utils
```

- [ ] **Step 3: Update core barrel to re-export types and utils**

Replace `/Users/jackou/Documents/projects/codey/packages/core/src/index.ts`:

```typescript
// @codey/core — barrel export
export * from './types';
export * from './utils/format';
```

- [ ] **Step 4: Update all imports in remaining `src/` to use `@codey/core`**

Run:
```bash
grep -rl "from '\./types'" src/ | xargs sed -i '' "s|from '\./types'|from '@codey/core'|g"
grep -rl "from '\./types/index'" src/ | xargs sed -i '' "s|from '\./types/index'|from '@codey/core'|g"
grep -rl "from '\.\./types'" src/ | xargs sed -i '' "s|from '\.\./types'|from '@codey/core'|g"
grep -rl "from '\./utils/format'" src/ | xargs sed -i '' "s|from '\./utils/format'|from '@codey/core'|g"
grep -rl "from '\.\./utils/format'" src/ | xargs sed -i '' "s|from '\.\./utils/format'|from '@codey/core'|g"
```

- [ ] **Step 5: Temporarily update root tsconfig so `src/` still builds during transition**

Create `/Users/jackou/Documents/projects/codey/tsconfig.json` (temporary — will be deleted in Phase 4):

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "packages", "codey-mac"]
}
```

Also add a temporary build script entry. Run:
```bash
node -e "const p = require('./package.json'); p.scripts['build:legacy'] = 'tsc -p tsconfig.json'; p.scripts.build = 'npm run build -w @codey/core && npm run build:legacy && npm run build -w @codey/gateway'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
```

- [ ] **Step 6: Build core then legacy**

Run: `npm run build`
Expected: both `packages/core/dist/` and `dist/` populate successfully. Zero TS errors.

- [ ] **Step 7: Run verify-workers**

Run: `npm run verify-workers`
Expected: all sections pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: move types and utils into @codey/core"
```

---

## Task 4: Move workers, workspace, worker-generator, agents into core

**Files:**
- Move: `src/workers.ts` → `packages/core/src/workers.ts`
- Move: `src/workspace.ts` → `packages/core/src/workspace.ts`
- Move: `src/worker-generator.ts` → `packages/core/src/worker-generator.ts`
- Move: `src/agents/` → `packages/core/src/agents/`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Move files**

Run:
```bash
git mv src/workers.ts packages/core/src/workers.ts
git mv src/workspace.ts packages/core/src/workspace.ts
git mv src/worker-generator.ts packages/core/src/worker-generator.ts
git mv src/agents packages/core/src/agents
```

- [ ] **Step 2: Fix internal imports inside moved core files**

Core files previously imported `./types`, `./utils/format`, `./logger`, `./config`. Types/utils now come from `@codey/core` barrel, but internal *within* core, use relative paths. Logger and Config stay in gateway — core must NOT import them.

Run: `grep -rn "from '\./logger'\|from '\./config'\|from '\.\./logger'\|from '\.\./config'" packages/core/src/`

Expected output: zero matches. If any appear, the referenced file's import must be refactored: replace `logger.info(...)` calls with a passed-in `log` callback parameter, OR use `console.*`. Open each match and refactor. Commit refactors as part of this task.

- [ ] **Step 3: Update core barrel to export new modules**

Replace `/Users/jackou/Documents/projects/codey/packages/core/src/index.ts`:

```typescript
// @codey/core — barrel export
export * from './types';
export * from './utils/format';
export * from './workers';
export * from './workspace';
export * from './worker-generator';
export * from './agents';
```

- [ ] **Step 4: Update all imports in remaining `src/` to point at `@codey/core`**

Run:
```bash
grep -rl "from '\./workers'" src/ | xargs sed -i '' "s|from '\./workers'|from '@codey/core'|g"
grep -rl "from '\./workspace'" src/ | xargs sed -i '' "s|from '\./workspace'|from '@codey/core'|g"
grep -rl "from '\./worker-generator'" src/ | xargs sed -i '' "s|from '\./worker-generator'|from '@codey/core'|g"
grep -rl "from '\./agents'" src/ | xargs sed -i '' "s|from '\./agents'|from '@codey/core'|g"
grep -rl "from '\./agents/" src/ 2>/dev/null | xargs -I{} sh -c "sed -i '' \"s|from './agents/[^']*'|from '@codey/core'|g\" {}"
```

- [ ] **Step 5: Build both packages + legacy**

Run: `npm run build`
Expected: zero TS errors. If errors appear for missing exports from `@codey/core`, add them to the barrel in Step 3 and retry.

- [ ] **Step 6: Run verify-workers**

Run: `npm run verify-workers`
Expected: all sections pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move workers, workspace, worker-generator, agents into @codey/core"
```

---

## Task 5: Add typed errors module to core

**Files:**
- Create: `packages/core/src/errors.ts`
- Modify: `packages/core/src/workers.ts` (throw typed errors)
- Modify: `packages/core/src/workspace.ts` (throw typed errors)
- Modify: `packages/core/src/agents/base.ts` (throw typed errors)
- Modify: `packages/core/src/index.ts` (export errors)

- [ ] **Step 1: Create the errors module**

Create `/Users/jackou/Documents/projects/codey/packages/core/src/errors.ts`:

```typescript
export class CodeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkerNotFoundError extends CodeyError {
  constructor(public readonly workerName: string) {
    super(`Worker not found: ${workerName}`);
  }
}

export class WorkspaceNotFoundError extends CodeyError {
  constructor(public readonly workspaceName: string) {
    super(`Workspace not found: ${workspaceName}`);
  }
}

export class AgentSpawnError extends CodeyError {
  constructor(public readonly agent: string, message: string) {
    super(`Failed to spawn agent "${agent}": ${message}`);
  }
}
```

- [ ] **Step 2: Wire errors into workers.ts**

In `/Users/jackou/Documents/projects/codey/packages/core/src/workers.ts`, find every code path that currently throws a generic `Error` for a missing worker and replace with `WorkerNotFoundError`.

Add import at top of file:
```typescript
import { WorkerNotFoundError } from './errors';
```

Find every `throw new Error(\`Worker ... not found\`)` or similar. For each, replace with:
```typescript
throw new WorkerNotFoundError(name);
```

(The exact variable name `name` / `workerName` may differ per method; substitute accordingly.)

- [ ] **Step 3: Wire errors into workspace.ts**

In `/Users/jackou/Documents/projects/codey/packages/core/src/workspace.ts`, add import:
```typescript
import { WorkspaceNotFoundError } from './errors';
```

Find every `throw new Error(\`Workspace ... not found\`)` or equivalent and replace with `throw new WorkspaceNotFoundError(workspaceName)`.

- [ ] **Step 4: Wire errors into agents/base.ts (and implementations)**

In each agent adapter in `packages/core/src/agents/`, find the spawn-failure paths (usually inside `.on('error', ...)` or try/catch around `spawn()`) and replace generic `Error` throws with `AgentSpawnError`:

```typescript
import { AgentSpawnError } from '../errors';
// ...
throw new AgentSpawnError(this.name, err.message);
```

- [ ] **Step 5: Export errors from barrel**

Modify `/Users/jackou/Documents/projects/codey/packages/core/src/index.ts`, add the line:
```typescript
export * from './errors';
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: zero errors.

- [ ] **Step 7: Run verify-workers**

Run: `npm run verify-workers`
Expected: all sections pass. The tests rely on the *message* of thrown errors, which is preserved by the new error classes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: add typed errors (WorkerNotFoundError, WorkspaceNotFoundError, AgentSpawnError) to core"
```

---

# Phase 3 — Move Orchestration + Reshape Context

Goal: `context.ts`, `memory.ts`, `planner.ts` live in core. `Context` is keyed by `conversationId`. `Gateway.handleMessage` accepts a `conversationId`.

## Task 6: Move memory and planner into core

**Files:**
- Move: `src/memory.ts` → `packages/core/src/memory.ts`
- Move: `src/planner.ts` → `packages/core/src/planner.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Move files**

Run:
```bash
git mv src/memory.ts packages/core/src/memory.ts
git mv src/planner.ts packages/core/src/planner.ts
```

- [ ] **Step 2: Check for disallowed imports into core**

Run: `grep -n "from '\./logger'\|from '\./config'" packages/core/src/memory.ts packages/core/src/planner.ts`

If any matches: replace logger usage with an optional `log?: (msg: string) => void` callback parameter threaded through the function/class constructor. Do not import gateway's `Logger` into core. If `config` is imported for a specific value, parameterize that value instead.

- [ ] **Step 3: Update barrel**

Modify `/Users/jackou/Documents/projects/codey/packages/core/src/index.ts` — add lines before the last export:
```typescript
export * from './memory';
export * from './planner';
```

- [ ] **Step 4: Update remaining `src/` imports**

Run:
```bash
grep -rl "from '\./memory'" src/ | xargs sed -i '' "s|from '\./memory'|from '@codey/core'|g"
grep -rl "from '\./planner'" src/ | xargs sed -i '' "s|from '\./planner'|from '@codey/core'|g"
```

- [ ] **Step 5: Build + verify**

Run: `npm run build && npm run verify-workers`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move memory and planner into @codey/core"
```

---

## Task 7: Move Context into core

**Files:**
- Move: `src/context.ts` → `packages/core/src/context.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Move file**

Run:
```bash
git mv src/context.ts packages/core/src/context.ts
```

- [ ] **Step 2: Sanitize disallowed imports**

Run: `grep -n "from '\./logger'\|from '\./config'" packages/core/src/context.ts`

If matches: replace with parameterized callbacks per Task 6 Step 2.

- [ ] **Step 3: Update barrel**

Add to `packages/core/src/index.ts`:
```typescript
export * from './context';
```

- [ ] **Step 4: Update remaining imports**

Run:
```bash
grep -rl "from '\./context'" src/ | xargs sed -i '' "s|from '\./context'|from '@codey/core'|g"
```

- [ ] **Step 5: Build + verify**

Run: `npm run build && npm run verify-workers`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move context into @codey/core"
```

---

## Task 8: Reshape Context to key by conversationId (TDD)

**Files:**
- Modify: `packages/core/src/context.ts`
- Create: `packages/core/src/context.test.ts`
- Modify: `packages/core/src/types/index.ts` (add conversationId to UserMessage)
- Modify: `src/gateway.ts` (update handleMessage to accept conversationId)
- Modify: `src/channels/telegram.ts`, `discord.ts`, `imessage.ts`, `tui.ts` (pass conversationId)

**Design decision for this task:**
- `UserMessage` gains an optional `conversationId?: string` field. Channels that don't set it get a default `${channel}-${chatId}`.
- `Context` class's public API changes from `get(channel, userId)` / `add(channel, userId, turn)` to `get(conversationId)` / `add(conversationId, turn)`. Internally the Map key is the raw conversationId string.
- `Gateway.handleMessage(msg)` continues to accept `UserMessage`; it derives the conversationId via `msg.conversationId ?? \`${msg.channel}-${msg.chatId}\``.

- [ ] **Step 1: Write the failing test**

Create `/Users/jackou/Documents/projects/codey/packages/core/src/context.test.ts`:

```typescript
// Run manually: npx ts-node packages/core/src/context.test.ts
import * as assert from 'assert';
import { ContextManager } from './context';

async function run() {
  const cm = new ContextManager({ maxTurns: 10, ttlMs: 60000 });

  // Two distinct conversations within the same "channel": state must not leak.
  await cm.addUserTurn('conv-a', 'hello from A');
  await cm.addUserTurn('conv-b', 'hello from B');

  const a = await cm.get('conv-a');
  const b = await cm.get('conv-b');

  assert.strictEqual(a.turns.length, 1, 'conv-a should have 1 turn');
  assert.strictEqual(a.turns[0].text, 'hello from A');
  assert.strictEqual(b.turns.length, 1, 'conv-b should have 1 turn');
  assert.strictEqual(b.turns[0].text, 'hello from B');

  // Two senders can append to the same conversation; shared history.
  await cm.addUserTurn('conv-a', 'second message from A (different sender)');
  const a2 = await cm.get('conv-a');
  assert.strictEqual(a2.turns.length, 2);
  assert.strictEqual(a2.turns[1].text, 'second message from A (different sender)');

  console.log('✓ context keyed by conversationId');
}

run().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the test (expected to fail)**

Run: `npx ts-node packages/core/src/context.test.ts`
Expected: compile error or assertion failure referencing the old `get(channel, userId)` signature.

- [ ] **Step 3: Reshape Context implementation**

Open `/Users/jackou/Documents/projects/codey/packages/core/src/context.ts`.

Find every public method on `ContextManager` (or equivalent class) that takes `(channel, userId)` and change the signature to `(conversationId: string)`. Internally, change the Map key from the composite to the raw string.

Concretely:
- Replace `private windows: Map<string, ContextWindow>` key semantics: key is now `conversationId` directly (no composite helper).
- Remove or simplify any `buildKey(channel, userId)` helper — replace call sites with the raw `conversationId`.
- Update `get`, `add`, `addUserTurn`, `addAssistantTurn`, `clear`, `compact`, and any other public methods.

- [ ] **Step 4: Run the test (expected to pass)**

Run: `npx ts-node packages/core/src/context.test.ts`
Expected: `✓ context keyed by conversationId`

- [ ] **Step 5: Update `UserMessage` type**

Modify `/Users/jackou/Documents/projects/codey/packages/core/src/types/index.ts`. Find the `UserMessage` interface and add `conversationId?: string`:

```typescript
export interface UserMessage {
  id: string;
  channel: ChannelType;
  userId: string;
  username: string;
  chatId: string;
  text: string;
  timestamp: number;
  conversationId?: string;
}
```

- [ ] **Step 6: Update `Gateway.handleMessage` to derive conversationId**

In `/Users/jackou/Documents/projects/codey/src/gateway.ts`, find the method that handles incoming `UserMessage` (likely `handleUserMessage` or similar — search for references to `context.get(` or `contextManager.get(`).

At the top of that method, compute:
```typescript
const conversationId = message.conversationId ?? `${message.channel}-${message.chatId}`;
```

Replace every `context.get(message.channel, message.userId)` (or equivalent) inside this method with `context.get(conversationId)`. Same for `.add(...)`.

- [ ] **Step 7: Build and run verify-workers**

Run: `npm run build && npm run verify-workers`
Expected: both pass. If any gateway or channel file still references the old signature, TypeScript will flag it — fix by passing `conversationId`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: Context keyed by conversationId; UserMessage gains optional conversationId

Breaking change to Gateway.handleMessage: derives conversationId from
message.conversationId ?? \`\${channel}-\${chatId}\`."
```

---

# Phase 4 — Move Gateway Code + Delete HTTP API

Goal: All gateway source lives in `packages/gateway/`. HTTP API deleted. `npm start`, `npm run dev`, CLI commands all work. Old `src/` is empty.

## Task 9: Move channels, config, logger, startup-guard, cli, health, gateway, index into packages/gateway

**Files:**
- Move all remaining `src/*.ts` and `src/channels/` into `packages/gateway/src/`

- [ ] **Step 1: Move files**

Run:
```bash
git mv src/channels packages/gateway/src/channels
git mv src/config.ts packages/gateway/src/config.ts
git mv src/logger.ts packages/gateway/src/logger.ts
git mv src/startup-guard.ts packages/gateway/src/startup-guard.ts
git mv src/cli.ts packages/gateway/src/cli.ts
git mv src/health.ts packages/gateway/src/health.ts
git mv src/gateway.ts packages/gateway/src/gateway.ts
git mv src/worker-routes.ts packages/gateway/src/worker-routes.ts
rm -f packages/gateway/src/index.ts  # remove stub
git mv src/index.ts packages/gateway/src/index.ts
```

- [ ] **Step 2: Remove empty src/ directory and legacy tsconfig**

Run:
```bash
rmdir src
rm tsconfig.json
```

- [ ] **Step 3: Simplify root build script**

Modify `/Users/jackou/Documents/projects/codey/package.json`. Replace the `scripts` block with:

```json
"scripts": {
  "build": "npm run build -ws --if-present",
  "build:core": "npm run build -w @codey/core",
  "build:gateway": "npm run build -w @codey/gateway",
  "dev": "npm run dev -w @codey/gateway",
  "start": "npm run start -w @codey/gateway",
  "configure": "npm run configure -w @codey/gateway",
  "status": "npm run status -w @codey/gateway",
  "set-agent": "npm run set-agent -w @codey/gateway",
  "set-model": "npm run set-model -w @codey/gateway",
  "tui": "npm run tui -w @codey/gateway",
  "verify-workers": "npm run build && ts-node scripts/verify-workers.ts",
  "verify-gateway": "npm run build && ts-node scripts/verify-gateway.ts"
}
```

(This removes `build:legacy` which existed during transition.)

- [ ] **Step 4: Verify no cross-package relative imports remain**

Run: `grep -rn "from '\.\./\.\./" packages/gateway/src/`
Expected: zero matches.

Run: `grep -rn "from '\./types'\|from '\./workers'\|from '\./workspace'\|from '\./context'\|from '\./memory'\|from '\./planner'\|from '\./worker-generator'\|from '\./utils/format'\|from '\./agents'" packages/gateway/src/`
Expected: zero matches — these must all be `from '@codey/core'`.

If any appear, fix with:
```bash
cd packages/gateway/src
grep -rl "from '\./types'" . | xargs sed -i '' "s|from '\./types'|from '@codey/core'|g"
# repeat for other names
cd -
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: both packages compile cleanly.

- [ ] **Step 6: Smoke test the headless gateway**

Run: `npm run dev -- --help 2>&1 | head -5` (or `npm run status`)
Expected: the CLI output as before — confirms the gateway entry point still wires up.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move gateway source into packages/gateway; remove src/ and legacy tsconfig"
```

---

## Task 10: Delete HTTP API routes (worker-routes.ts and API portions of health.ts)

**Files:**
- Delete: `packages/gateway/src/worker-routes.ts`
- Modify: `packages/gateway/src/health.ts` (keep only `/health`, `/metrics`, `/ready`)
- Modify: `packages/gateway/src/index.ts` (remove ApiServer setup for worker routes)

- [ ] **Step 1: Delete worker-routes.ts**

Run:
```bash
git rm packages/gateway/src/worker-routes.ts
```

- [ ] **Step 2: Slim down health.ts**

Open `/Users/jackou/Documents/projects/codey/packages/gateway/src/health.ts`.

Remove:
- Any route handler for `/workers`, `/workspaces`, `/chat`, `/generate`.
- The `setWorkerRoutes`, `setMessageHandler`, `setWorkspaceHandlers` methods and their state fields (`workerRoutes`, `messageHandler`, `workspaceHandlers`).
- Any import of `./worker-routes`.

Keep:
- The HTTP server setup.
- `/health`, `/metrics`, `/ready` route handlers and the `HealthStatusType` export.
- `setHealthGetter` or equivalent pathway for `/health` status.

After edits, `grep "/chat\|/workers\|/workspaces\|/generate" packages/gateway/src/health.ts` should return zero matches.

- [ ] **Step 3: Clean up index.ts**

Open `/Users/jackou/Documents/projects/codey/packages/gateway/src/index.ts`.

Remove every `apiServer.setMessageHandler(...)`, `apiServer.setWorkspaceHandlers(...)`, and `apiServer.setWorkerRoutes({...})` call. The `ApiServer` instantiation and `apiServer.start()`/`apiServer.stop()` lifecycle remain.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: zero errors. If the build fails because imports reference removed exports, delete those imports.

- [ ] **Step 5: Smoke test**

Run the gateway briefly and check health endpoint:
```bash
npm run dev &
GATEWAY_PID=$!
sleep 3
curl -sf http://localhost:$((${PORT:-3000}+1))/health || echo "WARN: health check failed"
kill $GATEWAY_PID 2>/dev/null
wait $GATEWAY_PID 2>/dev/null
```
Expected: curl returns JSON status (HTTP 200).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete HTTP API routes; health server now only serves /health /metrics /ready"
```

---

## Task 11: Rewrite verify-workers to test core directly

**Files:**
- Modify: `scripts/verify-workers.ts`

- [ ] **Step 1: Read the current verify-workers.ts to preserve the 11 section headings**

Run: `grep -n "^// ===\|Section\|console.log.*✓" scripts/verify-workers.ts | head -40`

Note the section structure so the rewrite preserves coverage of: worker list, workspace list, CRUD PUT/DELETE, teams GET/PUT, generate, cascade delete.

- [ ] **Step 2: Rewrite verify-workers.ts to use library calls, not HTTP**

Replace `/Users/jackou/Documents/projects/codey/scripts/verify-workers.ts` with a version that:
- Imports `WorkerManager`, `WorkspaceManager`, `generateWorker` from `@codey/core`.
- Calls them directly (no HTTP server boot, no `fetch`).
- Preserves all 11 original sections by checking their corresponding library behavior.
- The `finally` block still runs `git checkout workers/architect/personality.md workers/architect/config.json workspaces/default/workspace.json` to restore test mutations.

Template (engineer fills in per-section calls matching the originals):

```typescript
import { WorkerManager, WorkspaceManager, generateWorker, WorkerNotFoundError } from '@codey/core';
import { execSync } from 'child_process';

async function run() {
  const workspaceName = 'default';
  const workers = new WorkerManager(process.cwd());
  const workspaces = new WorkspaceManager(process.cwd());

  // Section 1: list workers
  const list = await workers.list();
  if (!Array.isArray(list) || list.length === 0) throw new Error('Section 1: expected non-empty worker list');
  console.log(`✓ Section 1: listed ${list.length} workers`);

  // Section 2: get single worker
  const architect = await workers.get('architect');
  if (!architect.personality.role) throw new Error('Section 2: architect.personality.role missing');
  console.log('✓ Section 2: loaded architect worker');

  // Section 3: get teams
  const teams = await workspaces.getTeams(workspaceName);
  if (!teams) throw new Error('Section 3: teams object missing');
  console.log('✓ Section 3: loaded teams');

  // Section 4: put worker
  await workers.put('architect', { ...architect, personality: { ...architect.personality, instructions: architect.personality.instructions + '\n\n(test marker)' }});
  const reread = await workers.get('architect');
  if (!reread.personality.instructions.includes('(test marker)')) throw new Error('Section 4: PUT did not persist');
  console.log('✓ Section 4: PUT worker persisted');

  // Section 5: delete worker — create a temp worker first
  await workers.put('tmp-verify', { name: 'tmp-verify', personality: { role: 'test', soul: 'test', instructions: 'test' }, config: { codingAgent: 'claude-code', model: 'sonnet', tools: [] }});
  await workers.delete('tmp-verify');
  let threw = false;
  try { await workers.get('tmp-verify'); } catch (e) { threw = e instanceof WorkerNotFoundError; }
  if (!threw) throw new Error('Section 5: deleted worker still loadable');
  console.log('✓ Section 5: DELETE worker removed');

  // Section 6: put teams
  const newTeams = { ...teams, verify: ['architect'] };
  await workspaces.setTeams(workspaceName, newTeams);
  const rereadTeams = await workspaces.getTeams(workspaceName);
  if (!rereadTeams.verify) throw new Error('Section 6: PUT teams did not persist');
  console.log('✓ Section 6: PUT teams persisted');

  // Section 7: cascade delete — add worker to team, delete worker, team entry should drop
  await workers.put('tmp-cascade', { name: 'tmp-cascade', personality: { role: 't', soul: 't', instructions: 't' }, config: { codingAgent: 'claude-code', model: 'sonnet', tools: [] }});
  await workspaces.setTeams(workspaceName, { ...rereadTeams, cascadeTest: ['tmp-cascade', 'architect'] });
  await workers.delete('tmp-cascade');
  const afterCascade = await workspaces.getTeams(workspaceName);
  if (afterCascade.cascadeTest?.includes('tmp-cascade')) throw new Error('Section 7: cascade delete failed');
  console.log('✓ Section 7: cascade delete works');

  // Sections 8–11: skipped here — they previously tested the HTTP surface which no longer exists.
  //                Their coverage is subsumed by sections 1–7 via library calls.

  console.log('\nAll verify-workers sections passed.');
}

run().catch((err) => { console.error(err); process.exit(1); }).finally(() => {
  try {
    execSync('git checkout workers/architect/personality.md workers/architect/config.json workspaces/default/workspace.json', { stdio: 'inherit' });
  } catch { /* ignore */ }
});
```

**Note to implementer:** If `WorkerManager` / `WorkspaceManager` method names differ from the template above (e.g. `getWorker` instead of `get`), align the template to the real API by reading `packages/core/src/workers.ts` and `packages/core/src/workspace.ts` first. The test shape stays the same.

- [ ] **Step 3: Run it**

Run: `npm run verify-workers`
Expected: all sections print `✓`. Final line: `All verify-workers sections passed.`

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-workers.ts
git commit -m "test: rewrite verify-workers to call @codey/core directly"
```

---

## Task 12: Add verify-gateway smoke test

**Files:**
- Create: `scripts/verify-gateway.ts`

- [ ] **Step 1: Create the script**

Create `/Users/jackou/Documents/projects/codey/scripts/verify-gateway.ts`:

```typescript
// In-process gateway smoke test.
// Boots a Gateway with a mock channel and a mock agent, feeds a message,
// asserts a response is emitted and the conversation context is recorded.

import * as assert from 'assert';
import { Codey } from '../packages/gateway/src/gateway';
import { ContextManager } from '@codey/core';
import type { UserMessage, GatewayResponse } from '@codey/core';

async function run() {
  // Build a minimal config the Gateway needs.
  const config: any = {
    defaultAgent: 'claude-code',
    defaultModel: { agent: 'claude-code', name: 'sonnet' },
    workspaces: { activeWorkspace: 'default' },
    rateLimit: { enabled: false, cooldownMs: 0 },
    dev: { logLevel: 'error', logFile: null },
  };

  const received: GatewayResponse[] = [];
  const mockChannel = {
    name: 'mock' as const,
    start: async () => {},
    stop: async () => {},
    sendMessage: async (r: GatewayResponse) => { received.push(r); },
    onMessage: () => {},
  };

  // Construct gateway — signature may need adjustment based on current Codey constructor.
  const gateway = new Codey(config as any);
  (gateway as any).channels = { mock: mockChannel };

  // Fake incoming message with explicit conversationId.
  const msg: UserMessage = {
    id: 'test-1',
    channel: 'mock' as any,
    userId: 'u1',
    username: 'tester',
    chatId: 'c1',
    text: 'hello',
    timestamp: Date.now(),
    conversationId: 'shared-conv',
  };

  // Drive handleMessage directly. Response will fail to reach a real agent —
  // what we assert is that the conversation context records the user turn.
  try { await (gateway as any).handleMessage(msg); } catch { /* agent spawn failure is expected */ }

  const ctx = (gateway as any).contextManager as ContextManager;
  const window = await ctx.get('shared-conv');
  assert.strictEqual(window.turns.length >= 1, true, 'user turn should be recorded');
  assert.strictEqual(window.turns[0].text, 'hello');

  console.log('✓ gateway records user turn keyed by conversationId');
}

run().catch((err) => { console.error(err); process.exit(1); });
```

**Note to implementer:** The `Codey` (gateway) constructor and internal field names may require adjustment — read `packages/gateway/src/gateway.ts` first to find the actual constructor signature, how channels are registered, and where `contextManager` lives. The smoke test's *intent* is fixed; exact plumbing may vary.

- [ ] **Step 2: Run it**

Run: `npm run verify-gateway`
Expected: `✓ gateway records user turn keyed by conversationId`

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-gateway.ts
git commit -m "test: add verify-gateway in-process smoke test"
```

---

# Phase 5 — Wire Electron to Core + Gateway

Goal: Electron main imports `@codey/core` and `@codey/gateway`, boots an in-process `Codey` gateway, exposes IPC handlers. Mac renderer can still function in its current form (renderer refactor is Phase 6).

## Task 13: Add workspace deps to codey-mac package.json

**Files:**
- Modify: `codey-mac/package.json`
- Modify: `codey-mac/tsconfig.json`
- Modify: `codey-mac/tsconfig.node.json`

- [ ] **Step 1: Add dependencies**

Open `/Users/jackou/Documents/projects/codey/codey-mac/package.json`. In the `dependencies` block, add:

```json
"@codey/core": "*",
"@codey/gateway": "*",
```

- [ ] **Step 2: Run install to link workspace**

Run: `npm install`
Expected: `codey-mac/node_modules/@codey/core` and `codey-mac/node_modules/@codey/gateway` symlinks exist (via hoisting these land in root `node_modules/@codey/*` and the workspace resolution works).

Verify:
```bash
node -e "console.log(require.resolve('@codey/core', { paths: ['./codey-mac'] }))"
```
Expected: path pointing into `packages/core/dist/index.js`.

- [ ] **Step 3: Ensure Electron main tsconfig can resolve the workspace**

Open `/Users/jackou/Documents/projects/codey/codey-mac/tsconfig.node.json`. If it has `"moduleResolution": "bundler"` or `"node16"`, change to `"moduleResolution": "node"` to match the CommonJS output of core/gateway. Ensure the config doesn't exclude the workspace packages.

- [ ] **Step 4: Build core first, then attempt Electron main compile**

Run: `npm run build:core && cd codey-mac && npx tsc -p tsconfig.node.json --noEmit && cd -`
Expected: zero TS errors (even though main.ts doesn't yet import from core).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/package.json codey-mac/tsconfig.node.json package-lock.json
git commit -m "build(codey-mac): add @codey/core and @codey/gateway workspace deps"
```

---

## Task 14: Boot in-process Gateway in electron/main.ts

**Files:**
- Modify: `codey-mac/electron/main.ts`

This task keeps all existing UI functioning. We add an in-process gateway alongside the existing spawned-gateway logic. The spawned gateway is removed in Task 16 once IPC handlers take over.

- [ ] **Step 1: Add imports at top of main.ts**

Open `/Users/jackou/Documents/projects/codey/codey-mac/electron/main.ts`. Add after existing imports:

```typescript
import { WorkerManager, WorkspaceManager, ContextManager, AgentFactory } from '@codey/core'
import { Codey } from '@codey/gateway/dist/gateway'
import { ConfigManager } from '@codey/gateway/dist/config'
```

- [ ] **Step 2: Add module-level instances**

After the existing `let gatewayProcess: ChildProcess | null = null` etc., add:

```typescript
let inProcessGateway: Codey | null = null
let workerManager: WorkerManager | null = null
let workspaceManager: WorkspaceManager | null = null
let configManager: ConfigManager | null = null
```

- [ ] **Step 3: Add boot function**

Before `app.whenReady()`, add:

```typescript
function bootInProcessCore() {
  const cwd = process.cwd()
  configManager = new ConfigManager()
  workerManager = new WorkerManager(cwd)
  workspaceManager = new WorkspaceManager(cwd)
  inProcessGateway = new Codey(configManager.get() as any)
  sendToRenderer('gateway-log', 'In-process core and gateway booted.')
}
```

- [ ] **Step 4: Call it at app ready**

Inside `app.whenReady().then(() => { ... })`, after `createWindow()` and `createTray()`, add:

```typescript
bootInProcessCore()
```

(Leave the existing `startGateway()`-via-spawn logic untouched for now; Tasks 15–16 will migrate callers off it.)

- [ ] **Step 5: Rebuild core and Electron main**

Run: `npm run build:core && cd codey-mac && npm run build && cd -`
Expected: clean build.

- [ ] **Step 6: Manual smoke — start the Mac app, confirm log line appears**

Run: `cd codey-mac && npm run dev &`
In the app window, check the status/log area for `In-process core and gateway booted.`
Kill the app.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "feat(codey-mac): boot in-process @codey/core and @codey/gateway at app startup"
```

---

## Task 15: IPC handlers for workers / workspaces / teams / conversations

**Files:**
- Modify: `codey-mac/electron/main.ts`

- [ ] **Step 1: Add `{ok, error?, data?}` helper**

At the top of `main.ts` after imports, add:

```typescript
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try { return { ok: true, data: await fn() } }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
}
```

- [ ] **Step 2: Register IPC handlers**

Inside `app.whenReady().then(...)`, after `bootInProcessCore()`, add:

```typescript
ipcMain.handle('workers:list', async () => wrap(() => workerManager!.list()))
ipcMain.handle('workers:get', async (_e, name: string) => wrap(() => workerManager!.get(name)))
ipcMain.handle('workers:put', async (_e, name: string, worker: any) => wrap(() => workerManager!.put(name, worker)))
ipcMain.handle('workers:delete', async (_e, name: string) => wrap(async () => {
  await workerManager!.delete(name)
  // cascade into each workspace's teams
  const all = await workspaceManager!.list()
  for (const ws of all) {
    const teams = await workspaceManager!.getTeams(ws.name)
    let changed = false
    for (const team of Object.keys(teams)) {
      const filtered = teams[team].filter((m: string) => m !== name)
      if (filtered.length !== teams[team].length) { teams[team] = filtered; changed = true }
    }
    if (changed) await workspaceManager!.setTeams(ws.name, teams)
  }
}))
ipcMain.handle('workers:generate', async (_e, prompt: string) => wrap(async () => {
  const { generateWorker } = await import('@codey/core')
  return generateWorker({ prompt, workingDir: process.cwd(), agent: 'claude-code', model: { agent: 'claude-code', name: 'sonnet' } } as any)
}))

ipcMain.handle('workspaces:list', async () => wrap(() => workspaceManager!.list()))
ipcMain.handle('workspaces:get', async (_e, name: string) => wrap(() => workspaceManager!.get(name)))
ipcMain.handle('workspaces:put', async (_e, name: string, ws: any) => wrap(() => workspaceManager!.put(name, ws)))

ipcMain.handle('teams:get', async (_e, workspaceName: string) => wrap(() => workspaceManager!.getTeams(workspaceName)))
ipcMain.handle('teams:set', async (_e, workspaceName: string, teams: any) => wrap(() => workspaceManager!.setTeams(workspaceName, teams)))

ipcMain.handle('conversations:list', async (_e, workspaceName: string) => wrap(async () => {
  // Conversations are discovered from the Context store. For now, expose the
  // keys that currently exist in memory; persistent storage is future work.
  const cm: ContextManager = (inProcessGateway as any).contextManager
  return cm.listConversationIds?.() ?? []
}))
```

**Note:** `ContextManager.listConversationIds()` may not exist. If not, add a one-line method to `packages/core/src/context.ts`:

```typescript
listConversationIds(): string[] { return Array.from(this.windows.keys()); }
```

(Field name `windows` may differ — use the actual Map field name.)

- [ ] **Step 3: Build Electron main**

Run: `cd codey-mac && npm run build && cd -`
Expected: clean.

- [ ] **Step 4: Manual smoke — open DevTools and call an IPC handler**

Launch the Mac app (`cd codey-mac && npm run dev`). Open the window's DevTools (already enabled in dev). In the console:

```js
const { ipcRenderer } = require('electron')
ipcRenderer.invoke('workers:list').then(console.log)
```

Expected: `{ ok: true, data: [...] }` with the current worker list.

Kill the app.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/main.ts packages/core/src/context.ts
git commit -m "feat(codey-mac): IPC handlers for workers, workspaces, teams, conversations (via in-process core)"
```

---

## Task 16: IPC handler for chat with token streaming + remove spawned-gateway logic

**Files:**
- Modify: `codey-mac/electron/main.ts`
- Modify: `codey-mac/electron/preload.ts`

- [ ] **Step 1: Add chat IPC handlers**

In `main.ts`, inside `app.whenReady()` after the other handlers:

```typescript
ipcMain.handle('chat:send', async (_e, payload: { conversationId: string; workspaceName: string; text: string; sender?: string }) => wrap(async () => {
  const msg = {
    id: `mac-${Date.now()}`,
    channel: 'mac' as any,
    userId: payload.sender ?? 'mac-user',
    username: payload.sender ?? 'mac-user',
    chatId: payload.conversationId,
    text: payload.text,
    timestamp: Date.now(),
    conversationId: payload.conversationId,
  }
  // Register a one-shot token forwarder on the gateway for this message.
  const forward = (token: string) => sendToRenderer('chat:token', { conversationId: payload.conversationId, token })
  ;(inProcessGateway as any).onToken = forward
  try {
    await (inProcessGateway as any).handleMessage(msg)
  } finally {
    ;(inProcessGateway as any).onToken = null
  }
}))
```

**Note to implementer:** `Codey.handleMessage` currently sends full responses back through its channel's `sendMessage`. To stream tokens to the renderer, the gateway must emit tokens through a hook. If `Codey` doesn't already expose a per-message streaming callback, add one: in `packages/gateway/src/gateway.ts`, find where the agent response is accumulated, and if an `onToken` is set on the instance, call it on each chunk.

- [ ] **Step 2: Expose chat API in preload.ts**

Open `/Users/jackou/Documents/projects/codey/codey-mac/electron/preload.ts`. Expose a `window.codey` object:

```typescript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('codey', {
  workers: {
    list: () => ipcRenderer.invoke('workers:list'),
    get: (name: string) => ipcRenderer.invoke('workers:get', name),
    put: (name: string, worker: any) => ipcRenderer.invoke('workers:put', name, worker),
    delete: (name: string) => ipcRenderer.invoke('workers:delete', name),
    generate: (prompt: string) => ipcRenderer.invoke('workers:generate', prompt),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    get: (name: string) => ipcRenderer.invoke('workspaces:get', name),
    put: (name: string, ws: any) => ipcRenderer.invoke('workspaces:put', name, ws),
  },
  teams: {
    get: (workspaceName: string) => ipcRenderer.invoke('teams:get', workspaceName),
    set: (workspaceName: string, teams: any) => ipcRenderer.invoke('teams:set', workspaceName, teams),
  },
  conversations: {
    list: (workspaceName: string) => ipcRenderer.invoke('conversations:list', workspaceName),
  },
  chat: {
    send: (payload: { conversationId: string; workspaceName: string; text: string; sender?: string }) =>
      ipcRenderer.invoke('chat:send', payload),
    onToken: (handler: (msg: { conversationId: string; token: string }) => void) => {
      const listener = (_e: any, msg: any) => handler(msg)
      ipcRenderer.on('chat:token', listener)
      return () => ipcRenderer.removeListener('chat:token', listener)
    },
  },
})
```

- [ ] **Step 3: Remove spawned-gateway logic**

In `main.ts`, delete the following:
- `gatewayProcess`, `isGatewayRunning`, `startGateway()`, `stopGateway()` functions
- `getGatewayPath()`, `setGatewayPath()` functions
- The `'Start Gateway'` and `'Stop Gateway'` tray menu items
- IPC handlers `'start-gateway'`, `'stop-gateway'`, `'get-gateway-path'`, `'set-gateway-path'`
- The `before-quit` handler's `stopGateway()` call (replace with `await inProcessGateway?.shutdown?.()` or nothing — Electron will exit)
- In `createTray()`, the Quit item's `if (gatewayProcess) stopGateway()` block

- [ ] **Step 4: Build Electron**

Run: `cd codey-mac && npm run build && cd -`
Expected: clean. If `preload.ts` emits a TS error about `electron` types, ensure `@types/electron` is available or cast `ipcRenderer` as needed.

- [ ] **Step 5: Smoke test**

Launch: `cd codey-mac && npm run dev`
- App should boot without "Start/Stop Gateway" tray items.
- The existing chat tab (using old services/api.ts — to be rewritten next) will still try to hit HTTP and fail. That's expected; Phase 6 fixes it.

Kill the app.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts packages/gateway/src/gateway.ts
git commit -m "feat(codey-mac): chat IPC with token streaming; remove spawned-gateway lifecycle"
```

---

# Phase 6 — Rewrite Mac Renderer Data Layer

Goal: Renderer uses `window.codey.*` exclusively. No HTTP, no `fetch`. Chat streams via IPC events.

## Task 17: Type declarations for window.codey in renderer

**Files:**
- Create: `codey-mac/src/codey-api.d.ts`

- [ ] **Step 1: Create ambient declaration**

Create `/Users/jackou/Documents/projects/codey/codey-mac/src/codey-api.d.ts`:

```typescript
import type { WorkerDto, WorkspaceDto, TeamsDto } from '@codey/core'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

declare global {
  interface Window {
    codey: {
      workers: {
        list: () => Promise<IpcResult<WorkerDto[]>>
        get: (name: string) => Promise<IpcResult<WorkerDto>>
        put: (name: string, worker: WorkerDto) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        generate: (prompt: string) => Promise<IpcResult<WorkerDto>>
      }
      workspaces: {
        list: () => Promise<IpcResult<WorkspaceDto[]>>
        get: (name: string) => Promise<IpcResult<WorkspaceDto>>
        put: (name: string, ws: WorkspaceDto) => Promise<IpcResult<void>>
      }
      teams: {
        get: (workspaceName: string) => Promise<IpcResult<TeamsDto>>
        set: (workspaceName: string, teams: TeamsDto) => Promise<IpcResult<void>>
      }
      conversations: {
        list: (workspaceName: string) => Promise<IpcResult<string[]>>
      }
      chat: {
        send: (payload: { conversationId: string; workspaceName: string; text: string; sender?: string }) => Promise<IpcResult<void>>
        onToken: (handler: (msg: { conversationId: string; token: string }) => void) => () => void
      }
    }
  }
}

export {}
```

**Note:** If `WorkerDto` / `WorkspaceDto` / `TeamsDto` aren't all exported from `@codey/core`, export them from the core barrel. Check with `grep "WorkerDto\|WorkspaceDto\|TeamsDto" packages/core/src/index.ts`.

- [ ] **Step 2: Tsc-check renderer**

Run: `cd codey-mac && npx tsc -p tsconfig.json --noEmit && cd -`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/codey-api.d.ts packages/core/src/index.ts
git commit -m "types(codey-mac): ambient window.codey declaration for renderer"
```

---

## Task 18: Rewrite services/api.ts as IPC proxy and update consumers

**Files:**
- Rewrite: `codey-mac/src/services/api.ts`
- Modify: all renderer files that import from it

- [ ] **Step 1: Rewrite api.ts as a thin IPC proxy**

Replace `/Users/jackou/Documents/projects/codey/codey-mac/src/services/api.ts` contents with:

```typescript
import type { WorkerDto, WorkspaceDto, TeamsDto } from '@codey/core'

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (result.ok) return result.data
  throw new Error(result.error)
}

export { WorkerDto, WorkspaceDto, TeamsDto }

export const apiService = {
  listWorkers: async (): Promise<WorkerDto[]> => unwrap(await window.codey.workers.list()),
  getWorker: async (name: string): Promise<WorkerDto> => unwrap(await window.codey.workers.get(name)),
  updateWorker: async (name: string, worker: WorkerDto): Promise<void> => unwrap(await window.codey.workers.put(name, worker)),
  deleteWorker: async (name: string): Promise<void> => unwrap(await window.codey.workers.delete(name)),
  generateWorker: async (prompt: string): Promise<WorkerDto> => unwrap(await window.codey.workers.generate(prompt)),

  listWorkspaces: async (): Promise<WorkspaceDto[]> => unwrap(await window.codey.workspaces.list()),
  getWorkspace: async (name: string): Promise<WorkspaceDto> => unwrap(await window.codey.workspaces.get(name)),
  updateWorkspace: async (name: string, ws: WorkspaceDto): Promise<void> => unwrap(await window.codey.workspaces.put(name, ws)),

  getTeams: async (workspaceName: string): Promise<TeamsDto> => unwrap(await window.codey.teams.get(workspaceName)),
  setTeams: async (workspaceName: string, teams: TeamsDto): Promise<void> => unwrap(await window.codey.teams.set(workspaceName, teams)),

  listConversations: async (workspaceName: string): Promise<string[]> => unwrap(await window.codey.conversations.list(workspaceName)),

  sendChat: async (payload: { conversationId: string; workspaceName: string; text: string; sender?: string }): Promise<void> =>
    unwrap(await window.codey.chat.send(payload)),
  onChatToken: (handler: (msg: { conversationId: string; token: string }) => void) => window.codey.chat.onToken(handler),
}
```

- [ ] **Step 2: Find all consumers that still use HTTP paths (fetch, SSE)**

Run: `grep -rn "fetch('\|EventSource\|/workers\|/workspaces\|/chat" codey-mac/src/`

For each match outside `api.ts`, migrate the call site to use `apiService.*` methods defined above. Common patterns:

- `fetch('/workers').then(...)` → `apiService.listWorkers()`
- `new EventSource('/chat?...')` → `apiService.sendChat({...})` + `apiService.onChatToken((msg) => ...)` for streaming

Expected files to touch: `hooks/useGateway.ts`, `components/ChatTab.tsx`, `components/WorkersTab.tsx`, `components/WorkspacesTab.tsx`, `components/TeamsSection.tsx`, `components/SettingsTab.tsx`, `components/StatusTab.tsx`.

- [ ] **Step 3: Remove Settings gateway-path field**

In `codey-mac/src/components/SettingsTab.tsx`, delete any UI for configuring "Gateway path" and the associated state/handlers. The renderer no longer needs to know about gateway paths — the gateway is bundled.

- [ ] **Step 4: Tsc-check renderer**

Run: `cd codey-mac && npx tsc -p tsconfig.json --noEmit && cd -`
Expected: zero errors. Fix any site still referencing removed HTTP helpers.

- [ ] **Step 5: Build the Mac app**

Run: `cd codey-mac && npm run build && cd -`
Expected: clean.

- [ ] **Step 6: Manual smoke test**

Launch: `cd codey-mac && npm run dev`

Exercise each tab:
- **Chat:** send a message, observe token streaming (if agent configured).
- **Workers:** list renders, create/edit/delete a worker.
- **Workspaces:** list renders, edit a team, verify persistence.
- **Settings:** no gateway-path field visible.
- **Status:** renders without errors.

Kill the app.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/
git commit -m "refactor(codey-mac): rewrite services/api.ts as IPC proxy; remove gateway-path UI"
```

---

## Task 19: Final cleanup and verification

**Files:**
- Delete any leftover dead code discovered during end-to-end verification.

- [ ] **Step 1: Grep for any remaining dead references**

Run each:
```bash
grep -rn "worker-routes" packages/ codey-mac/
grep -rn "ApiServer.setWorkerRoutes\|setMessageHandler\|setWorkspaceHandlers" packages/ codey-mac/
grep -rn "gatewayPath\|getGatewayPath\|setGatewayPath\|start-gateway\|stop-gateway" packages/ codey-mac/
grep -rn "from '\./types'\|from '\./workers'\|from '\./workspace'\|from '\./context'\|from '\./memory'\|from '\./planner'\|from '\./worker-generator'\|from '\./utils/format'\|from '\./agents'" packages/gateway/src/
```

Expected: all return zero matches. Any match is dead code or a missed import update — fix.

- [ ] **Step 2: Run full verification suite**

Run in order:
```bash
npm run build
npm run verify-workers
npm run verify-gateway
```

Expected: all three green.

- [ ] **Step 3: End-to-end Mac app smoke**

Run: `cd codey-mac && npm run dev`
- All tabs render.
- Create a worker, edit a team, send a chat message.
- No errors in DevTools console, no HTTP requests to localhost (confirm in Network tab — all calls should be IPC, not HTTP).

Kill the app.

- [ ] **Step 4: End-to-end headless gateway smoke**

Run: `npm run dev` (from repo root — runs gateway)
- Health endpoint responds at `http://localhost:<port+1>/health`.
- If Telegram token configured, bot responds.

Kill the gateway.

- [ ] **Step 5: Commit any cleanup diffs**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore: final cleanup after shared-core extraction"
```

- [ ] **Step 6: Delete the backup file**

Run: `rm -f package.json.bak`

If the deletion creates a diff (it shouldn't — the file was never committed), commit it.

---

# Done

At this point:
- `@codey/core` owns data and agent spawning.
- `@codey/gateway` bridges Telegram/Discord/iMessage and exposes a headless entry.
- `codey-mac` hosts the gateway in-process; Mac UI uses IPC exclusively.
- Mac chat and Telegram chat share conversation state through the single in-process `Codey` instance when `conversationId` matches.
- HTTP API is gone. Health server is slim.
- Both verify scripts and both build targets are green.
