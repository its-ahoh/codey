# File Upload in macOS Chat

## Overview

Add image and file upload support to the macOS Electron app's Chat tab. Users can drag-and-drop files or click an attachment button to attach files to chat messages. Files are saved to the workspace directory and coding agents are explicitly instructed to review them.

**Platform:** macOS App only (codey-mac)
**File types:** Images (png, jpg, gif, webp) and text files (code, logs, configs, etc.)
**Agent interaction:** Files saved to disk, paths included in structured prompt

## Data Model

### FileAttachment (new interface)

```typescript
// packages/core/src/types/chat.ts
export interface FileAttachment {
  id: string;
  name: string;        // original filename
  path: string;        // absolute path on disk after save
  mimeType: string;    // e.g. "image/png", "text/typescript"
  size: number;        // bytes
}
```

### ChatMessage (modified)

Add optional `attachments` field:

```typescript
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: FileAttachment[];  // NEW
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
  tokens?: number;
  durationSec?: number;
}
```

## Frontend (ChatTab.tsx)

### UI Components

1. **Attachment button** ("+") to the left of the input textarea. Opens a native file picker supporting multiple selection. Filter: images + text files.

2. **Drag-and-drop zone** over the entire messages area. On dragenter, show a dashed-border overlay with "Drop files here" text. On drop, process files.

3. **Attachment preview chips** above the input textarea:
   - Image files: thumbnail preview + filename
   - Text files: file icon + filename + size
   - Each chip has an "x" button to remove before sending
   - Max display: 5 chips, "+N more" for overflow

4. **Attachment display in user message bubbles:**
   - Images: inline thumbnail (max 200x200, click to expand)
   - Text files: filename + line count label

### Interaction Flow

1. User drags files or clicks "+" to select files
2. Files are read as ArrayBuffer in the renderer
3. Files are sent via `chats:upload` IPC to the main process
4. Main process saves files to `{workspaceDir}/.codey/uploads/`
5. Returns `FileAttachment` metadata
6. Chips appear above input; user types message (optional) and sends
7. `chats:send` payload includes both `text` and `attachments`

### State Management

In `useChats.tsx`, add a `pendingAttachments` state per chat:

```typescript
// Track files being staged before send
const [pendingAttachments, setPendingAttachments] = useState<Record<string, FileAttachment[]>>({})
```

## IPC Layer

### New: `chats:upload`

**Preload (preload.ts):**
```typescript
chats: {
  upload: (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('chats:upload', chatId, fileName, mimeType, data),
  // ... existing methods
}
```

**Main process (main.ts):**
```typescript
ipcMain.handle('chats:upload', async (_e, chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
  wrap(async () => {
    // 1. Resolve workspace workingDir from chatId
    // 2. Create .codey/uploads/ directory
    // 3. Generate unique filename: {timestamp}-{random}-{originalName}
    // 4. Write file
    // 5. Return FileAttachment
  })
)
```

### Modified: `chats:send`

**Payload change:**
```typescript
// Before
{ chatId: string; text: string }

// After
{ chatId: string; text: string; attachments?: FileAttachment[] }
```

**Main process:** Pass attachments to `sendToChat`.

## Backend (Gateway)

### sendToChat (gateway.ts)

Modify signature to accept optional attachments:

```typescript
async sendToChat(
  chatId: string,
  userText: string,
  sink: ChatStreamSink,
  attachments?: FileAttachment[],
): Promise<{...}>
```

Pass attachments to `buildChatPrompt` and persist them in the `ChatMessage`.

### buildChatPrompt (chat-runner.ts)

When attachments are present, prepend a structured section:

```
[Attachments]
- /path/to/screenshot.png (image/png)
- /path/to/code.ts (text/typescript, 142 lines)

Please review the attached files before responding to the user's message.
For image files, use your vision capabilities to analyze them.

User: <actual user message>
```

For image files, include a note about vision capabilities.
For text files, include line count if detectable.

### File Save Location

Files are saved to `{workspaceWorkingDir}/.codey/uploads/`:
- Hidden directory (prefixed with `.`) so it doesn't pollute the project
- Unique filenames prevent collisions
- No automatic cleanup (user can manually delete)

## API Service (api.ts)

```typescript
// New method
uploadFile: async (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer): Promise<FileAttachment> =>
  unwrap(await window.codey.chats.upload(chatId, fileName, mimeType, data)),

// Modified method
chats: {
  send: async (chatId: string, text: string, attachments?: FileAttachment[]): Promise<{...}> =>
    unwrap(await window.codey.chats.send({ chatId, text, attachments })),
}
```

## File Type Detection

Use MIME type from the file input / drag event. Supported categories:

| Category | MIME patterns | Agent behavior |
|----------|---------------|----------------|
| Images | image/* | Prompt notes vision capability |
| Code | text/*, application/json, application/typescript | Line count included in prompt |
| Other | * | Generic file reference |

## Error Handling

- File too large (>10MB): show error toast, don't upload
- Upload fails: show error in attachment chip, allow retry
- Workspace not found: disable attachment button
- Unsupported file type: show warning, allow override

## Failure Behavior

- If `chats:send` fails after attachments are staged, pending attachments are preserved so the user can retry
- If `chats:upload` fails (e.g. disk full), show error state on the chip and allow retry
- Files already saved to disk are not rolled back on send failure (they remain in `.codey/uploads/`)

## Compatibility

- `attachments` is optional in all interfaces; existing callers (HTTP API, channel handlers) are unaffected
- `processPromptHttp` is not changed — file upload is only available through the multi-chat `sendToChat` path
- Telegram/Discord handlers continue to work with text-only messages

## Limits

- Max file size: 10MB per file
- Max attachments per message: 10
- No automatic cleanup of uploads directory
