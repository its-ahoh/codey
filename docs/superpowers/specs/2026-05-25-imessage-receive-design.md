# iMessage Receive via SQLite Polling

## Problem

The iMessage channel handler is send-only. It can deliver messages via AppleScript but cannot receive incoming messages, making iMessage unusable as a Codey input channel.

## Solution

Poll the macOS Messages SQLite database (`~/Library/Messages/chat.db`) for new incoming messages on a configurable interval, filter by an allowlist of sender handles, and emit `UserMessage` events through the existing channel handler infrastructure.

## Configuration

Extend `channels.imessage` in `gateway.json`:

```jsonc
{
  "channels": {
    "imessage": {
      "enabled": true,
      "allowedSenders": ["+8613800138000", "someone@icloud.com"],
      "pollIntervalMs": 3000
    }
  }
}
```

- `allowedSenders` (required): Array of phone numbers or Apple IDs. Only messages from these handles trigger the agent. Empty array = no messages received.
- `pollIntervalMs` (optional): Polling interval in milliseconds. Default `3000`.

## Architecture

### Message Receive Flow

```
chat.db (SQLite, readonly) ──poll every N ms──> IMessageHandler
  │
  ├─ Query: SELECT m.ROWID, m.text, m.date, h.id AS handle
  │         FROM message m
  │         JOIN handle h ON m.handle_id = h.ROWID
  │         WHERE m.ROWID > lastSeenRowId
  │           AND m.is_from_me = 0
  │         ORDER BY m.ROWID ASC
  │
  ├─ Filter: handle ∈ allowedSenders?
  │
  └─ Emit UserMessage:
       id:        ROWID (string)
       channel:   'imessage'
       userId:    handle
       username:  handle
       chatId:    handle
       text:      message text
       timestamp: coreDataToUnix(m.date)
```

### Key Implementation Details

1. **Dependency**: `better-sqlite3` — synchronous SQLite reader, opened in readonly mode.
2. **Initialization**: On `start()`, open the database and query `MAX(ROWID)` as `lastSeenRowId` so only messages arriving after startup are processed.
3. **Timestamp conversion**: chat.db uses Core Data timestamps (nanoseconds since 2001-01-01). Convert: `(coreDataNanos / 1e9 + 978307200) * 1000` to get Unix ms.
4. **Database open**: `new Database(dbPath, { readonly: true, fileMustExist: true })` — never writes to chat.db.
5. **Permission check**: If the database fails to open, log a clear message directing the user to grant Full Disk Access to Terminal/iTerm/Node in System Settings > Privacy & Security > Full Disk Access.
6. **Send**: Unchanged — continues using AppleScript via `osascript`.
7. **Stop**: Clear the polling interval and close the database connection.

### UserMessage Mapping

| UserMessage field | Source |
|---|---|
| `id` | `message.ROWID` (as string) |
| `channel` | `'imessage'` |
| `userId` | `handle.id` (phone/email) |
| `username` | `handle.id` |
| `chatId` | `handle.id` |
| `text` | `message.text` |
| `timestamp` | Core Data timestamp → Unix ms |

## File Changes

| File | Change |
|---|---|
| `packages/gateway/src/channels/imessage.ts` | Rewrite: add SQLite polling, allowedSenders filtering, permission check |
| `packages/gateway/src/config.ts` | Extend imessage config type with `allowedSenders` and `pollIntervalMs` |
| `packages/gateway/package.json` | Add `better-sqlite3` dependency |

## Prerequisites

- macOS with iMessage enabled
- Full Disk Access granted to the process running Codey (Terminal, iTerm, or Node.js)
