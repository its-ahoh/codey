# iMessage Receive via SQLite Polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable iMessage as a full input channel by polling the macOS Messages SQLite database for incoming messages.

**Architecture:** Poll `~/Library/Messages/chat.db` every 3 seconds for new rows in the `message` table, filter by an allowlist of sender handles, and emit `UserMessage` events through the existing channel handler infrastructure. Sending remains via AppleScript.

**Tech Stack:** `better-sqlite3` for synchronous readonly SQLite access, existing `child_process.exec` for AppleScript sends.

---

### Task 1: Add `better-sqlite3` dependency

**Files:**
- Modify: `packages/gateway/package.json`

- [ ] **Step 1: Install better-sqlite3**

```bash
cd packages/gateway && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/jackou/Documents/projects/codey && npm run build
```

Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/package.json ../../package-lock.json
git commit -m "chore(gateway): add better-sqlite3 for iMessage SQLite polling"
```

---

### Task 2: Extend iMessage config type

**Files:**
- Modify: `packages/gateway/src/config.ts:15` — extend type
- Modify: `packages/gateway/src/config.ts:389` — update `enableChannel`
- Modify: `packages/gateway/src/config.ts:477` — update default config
- Modify: `packages/gateway/src/index.ts:50` — pass config fields to gateway

- [ ] **Step 1: Update the config type**

In `packages/gateway/src/config.ts`, change the imessage config type from:

```typescript
imessage?: { enabled: boolean };
```

to:

```typescript
imessage?: { enabled: boolean; allowedSenders?: string[]; pollIntervalMs?: number };
```

- [ ] **Step 2: Update `enableChannel` to preserve existing fields**

In `packages/gateway/src/config.ts`, change the `enableChannel` method's imessage branch from:

```typescript
else if (channel === 'imessage') this.config.channels.imessage = { enabled: true };
```

to:

```typescript
else if (channel === 'imessage') {
  if (this.config.channels.imessage) this.config.channels.imessage.enabled = true;
  else this.config.channels.imessage = { enabled: true };
}
```

- [ ] **Step 3: Update default config**

In `packages/gateway/src/config.ts`, change the imessage default from:

```typescript
imessage: { enabled: false },
```

to:

```typescript
imessage: { enabled: false, allowedSenders: [] },
```

- [ ] **Step 4: Pass full imessage config to gateway**

In `packages/gateway/src/index.ts`, change:

```typescript
imessage: config.channels.imessage?.enabled ? { enabled: true } : undefined,
```

to:

```typescript
imessage: config.channels.imessage?.enabled ? config.channels.imessage : undefined,
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/jackou/Documents/projects/codey && npm run build
```

Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config.ts packages/gateway/src/index.ts
git commit -m "feat(gateway): extend iMessage config with allowedSenders and pollIntervalMs"
```

---

### Task 3: Rewrite iMessage handler with SQLite polling

**Files:**
- Modify: `packages/gateway/src/channels/imessage.ts` — full rewrite

- [ ] **Step 1: Rewrite `imessage.ts`**

Replace the entire contents of `packages/gateway/src/channels/imessage.ts` with:

```typescript
import { exec } from 'child_process';
import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import { BaseChannelHandler, formatChoicesAsText } from './base';
import { UserMessage, GatewayResponse, ChatRoute } from '@codey/core';

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const CORE_DATA_EPOCH_OFFSET = 978307200;
const DEFAULT_POLL_INTERVAL_MS = 3000;

interface IMessageConfig {
  enabled: boolean;
  allowedSenders?: string[];
  pollIntervalMs?: number;
}

function coreDataToUnixMs(coreDataTimestamp: number): number {
  return (coreDataTimestamp / 1e9 + CORE_DATA_EPOCH_OFFSET) * 1000;
}

export class IMessageHandler extends BaseChannelHandler {
  name = 'imessage';
  private db?: Database.Database;
  private pollInterval?: ReturnType<typeof setInterval>;
  private lastSeenRowId = 0;
  private allowedSenders: Set<string> = new Set();

  async start(config: IMessageConfig): Promise<void> {
    const senders = config.allowedSenders ?? [];
    if (senders.length === 0) {
      console.log('[iMessage] No allowedSenders configured — receive disabled, send-only mode');
    }
    this.allowedSenders = new Set(senders.map(s => s.toLowerCase()));

    try {
      this.db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (err: any) {
      if (err.code === 'SQLITE_CANTOPEN' || err.message?.includes('unable to open')) {
        console.error(
          '[iMessage] Cannot open chat.db. Grant Full Disk Access to this process:\n' +
          '  System Settings → Privacy & Security → Full Disk Access\n' +
          '  Add: Terminal / iTerm / Node.js'
        );
      } else {
        console.error('[iMessage] Failed to open chat.db:', err.message);
      }
      console.log('[iMessage] Handler started (send-only mode, database unavailable)');
      return;
    }

    const row = this.db.prepare('SELECT MAX(ROWID) AS maxId FROM message').get() as { maxId: number | null } | undefined;
    this.lastSeenRowId = row?.maxId ?? 0;

    const intervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollInterval = setInterval(() => this.poll(), intervalMs);

    console.log(`[iMessage] Handler started — polling every ${intervalMs}ms, ${senders.length} allowed sender(s)`);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  private poll(): void {
    if (!this.db) return;

    try {
      const rows = this.db.prepare(
        `SELECT m.ROWID, m.text, m.date, h.id AS handle
         FROM message m
         JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL AND m.text != ''
         ORDER BY m.ROWID ASC`
      ).all(this.lastSeenRowId) as Array<{ ROWID: number; text: string; date: number; handle: string }>;

      for (const row of rows) {
        this.lastSeenRowId = row.ROWID;

        if (this.allowedSenders.size > 0 && !this.allowedSenders.has(row.handle.toLowerCase())) {
          continue;
        }

        const message: UserMessage = {
          id: String(row.ROWID),
          channel: 'imessage',
          userId: row.handle,
          username: row.handle,
          chatId: row.handle,
          text: row.text,
          timestamp: coreDataToUnixMs(row.date),
        };

        this.emitMessage(message);
      }
    } catch (err: any) {
      console.error('[iMessage] Poll error:', err.message);
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    const text = formatChoicesAsText(response.text, response.choices);
    await this.runAppleScript(response.chatId, text);
  }

  async sendToRoute(route: ChatRoute, text: string): Promise<void> {
    if (route.channel !== 'imessage') return;
    await this.runAppleScript(route.channelChatId, text);
  }

  private runAppleScript(recipient: string, text: string): Promise<void> {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}"`;
    return new Promise((resolve, reject) => {
      exec(`osascript -e '${script}'`, (error) => {
        if (error) {
          console.error('[iMessage] Send error:', error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/jackou/Documents/projects/codey && npm run build
```

Expected: Clean compilation.

- [ ] **Step 3: Manual smoke test**

Start gateway with iMessage enabled and verify:

```bash
npm run dev
```

Check console output for one of:
- `[iMessage] Handler started — polling every 3000ms, N allowed sender(s)` (success)
- `[iMessage] Cannot open chat.db. Grant Full Disk Access...` (expected if no permission yet)
- `[iMessage] No allowedSenders configured — receive disabled, send-only mode` (if no senders set)

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/channels/imessage.ts
git commit -m "feat(gateway): iMessage receive via SQLite polling with sender allowlist"
```
