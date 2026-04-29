# File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image and file upload support to the macOS Electron app's Chat tab with drag-drop, attachment preview, and structured prompt injection for coding agents.

**Architecture:** Files are uploaded via a new IPC channel, saved to the workspace's `.codey/uploads/` directory, and their paths are injected into the agent prompt via a structured `[Attachments]` section. The frontend adds drag-drop and a "+" button with preview chips.

**Tech Stack:** TypeScript, React, Electron IPC, Node.js fs

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/types/chat.ts` | Modify | Add `FileAttachment` interface, add `attachments` to `ChatMessage` |
| `packages/gateway/src/chat-runner.ts` | Modify | Add `attachments` param to `buildChatPrompt`, format structured prompt |
| `packages/gateway/src/gateway.ts` | Modify | Pass `attachments` through `sendToChat` |
| `codey-mac/electron/preload.ts` | Modify | Add `chats:upload` IPC bridge |
| `codey-mac/electron/main.ts` | Modify | Add `chats:upload` handler, modify `chats:send` handler |
| `codey-mac/src/services/api.ts` | Modify | Add `uploadFile` method, update `chats.send` signature |
| `codey-mac/src/components/ChatTab.tsx` | Modify | Add attachment button, drag-drop, preview chips, message display |
| `codey-mac/src/hooks/useChats.tsx` | Modify | Add `pendingAttachments` state, update `sendMessage` |

---

### Task 1: Add FileAttachment type to core

**Files:**
- Modify: `packages/core/src/types/chat.ts`

- [ ] **Step 1: Add FileAttachment interface and update ChatMessage**

Open `packages/core/src/types/chat.ts` and add the `FileAttachment` interface before `ChatMessage`, then add the `attachments` field to `ChatMessage`:

```typescript
export interface FileAttachment {
  id: string;
  name: string;        // original filename
  path: string;        // absolute path on disk after save
  mimeType: string;    // e.g. "image/png", "text/typescript"
  size: number;        // bytes
}

export interface ToolCallEntry {
  id: string;
  type: 'tool_start' | 'tool_end' | 'info';
  tool?: string;
  message: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: FileAttachment[];
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
  /** Total tokens for the assistant response, set when the turn completes. */
  tokens?: number;
  /** Wall-clock seconds the agent took to produce the response. */
  durationSec?: number;
}

// ... rest of file unchanged
```

- [ ] **Step 2: Build core package**

Run from the monorepo root:

```bash
npm run build:core
```

Expected: Compiles without errors. Verify `packages/core/dist/types/chat.d.ts` now includes `FileAttachment`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/chat.ts packages/core/dist/
git commit -m "feat(core): add FileAttachment type to ChatMessage"
```

---

### Task 2: Update buildChatPrompt to handle attachments

**Files:**
- Modify: `packages/gateway/src/chat-runner.ts`

- [ ] **Step 1: Update buildChatPrompt signature and logic**

Open `packages/gateway/src/chat-runner.ts`. Replace the `buildChatPrompt` function:

```typescript
import { Chat, ChatMessage, FileAttachment, ToolCallEntry } from '@codey/core';

// ... existing MAX_CONCURRENT_AGENTS, CHAT_CONTEXT_WINDOW, ChatStreamEvent, ChatStreamSink unchanged ...

function formatAttachmentList(attachments: FileAttachment[]): string {
  const lines = attachments.map(a => {
    let desc = `- ${a.path} (${a.mimeType})`;
    if (a.mimeType.startsWith('image/')) {
      desc += ' [IMAGE - use vision to analyze]';
    }
    return desc;
  });
  return [
    '[Attachments]',
    ...lines,
    '',
    'Please review the attached files before responding.',
    ...(
      attachments.some(a => a.mimeType.startsWith('image/'))
        ? ['For image files, analyze the visual content carefully.']
        : []
    ),
    '',
  ].join('\n');
}

/** Build the prompt string from the tail of the chat's message history + new user message. */
export function buildChatPrompt(
  chat: Chat,
  userText: string,
  attachments?: FileAttachment[],
  windowSize = CHAT_CONTEXT_WINDOW,
): string {
  const tail = chat.messages.slice(-windowSize);
  const lines: string[] = [];

  // Prepend attachment context if present
  if (attachments && attachments.length > 0) {
    lines.push(formatAttachmentList(attachments));
  }

  for (const m of tail) {
    const tag = m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${tag}: ${m.content}`);
  }
  lines.push(`User: ${userText}`);
  return lines.join('\n\n');
}

// assistantPrefixForSelection, RunSemaphore unchanged
```

- [ ] **Step 2: Build gateway package**

```bash
npm run build:gateway
```

Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chat-runner.ts packages/gateway/dist/
git commit -m "feat(gateway): support attachments in buildChatPrompt"
```

---

### Task 3: Update sendToChat to accept attachments

**Files:**
- Modify: `packages/gateway/src/gateway.ts`

- [ ] **Step 1: Update sendToChat signature**

Open `packages/gateway/src/gateway.ts`. Find the `sendToChat` method (around line 1783) and update its signature and the call to `buildChatPrompt`:

Change the method signature from:
```typescript
async sendToChat(
  chatId: string,
  userText: string,
  sink: ChatStreamSink,
): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> {
```

To:
```typescript
async sendToChat(
  chatId: string,
  userText: string,
  sink: ChatStreamSink,
  attachments?: import('@codey/core').FileAttachment[],
): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> {
```

- [ ] **Step 2: Update buildChatPrompt call**

Find this line inside `sendToChat` (around line 1826):
```typescript
const prompt = assistantPrefixForSelection(chat) + buildChatPrompt(chat, userText);
```

Replace with:
```typescript
const prompt = assistantPrefixForSelection(chat) + buildChatPrompt(chat, userText, attachments);
```

- [ ] **Step 3: Persist attachments in user message**

Find the `userMessage` creation (around line 1828):
```typescript
const userMessage: ChatMessage = {
  id: randomUUID(),
  role: 'user',
  content: userText,
  timestamp: started,
  isComplete: true,
};
```

Replace with:
```typescript
const userMessage: ChatMessage = {
  id: randomUUID(),
  role: 'user',
  content: userText,
  timestamp: started,
  isComplete: true,
  attachments: attachments && attachments.length > 0 ? attachments : undefined,
};
```

- [ ] **Step 4: Build gateway package**

```bash
npm run build:gateway
```

Expected: Compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/gateway.ts packages/gateway/dist/
git commit -m "feat(gateway): pass attachments through sendToChat"
```

---

### Task 4: Add IPC channels for file upload

**Files:**
- Modify: `codey-mac/electron/preload.ts`
- Modify: `codey-mac/electron/main.ts`

- [ ] **Step 1: Add chats:upload to preload.ts**

Open `codey-mac/electron/preload.ts`. In the `chats` object, add `upload` before the existing `list` method:

```typescript
chats: {
    upload: (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
      ipcRenderer.invoke('chats:upload', chatId, fileName, mimeType, data),
    list: (workspaceName?: string) => ipcRenderer.invoke('chats:list', workspaceName),
    // ... rest unchanged
```

- [ ] **Step 2: Update chats:send payload in preload.ts**

Change the `send` method in the `chats` object to accept attachments:

```typescript
    send: (payload: { chatId: string; text: string; attachments?: any[] }) =>
      ipcRenderer.invoke('chats:send', payload),
```

- [ ] **Step 3: Add chats:upload handler in main.ts**

Open `codey-mac/electron/main.ts`. Add the upload handler before the `chats:send` handler (before line 585):

```typescript
  ipcMain.handle('chats:upload', async (_e, chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const chat = inProcessGateway.getChatManager().get(chatId)
      if (!chat) throw new Error(`Chat not found: ${chatId}`)

      const fsMod = await import('fs')
      const pathMod = await import('path')
      const cryptoMod = await import('crypto')

      // Resolve workspace working directory
      const workspacesRoot = (inProcessGateway as any).workspaceManager.getWorkspacesRoot()
      const wsConfigPath = pathMod.join(workspacesRoot, chat.workspaceName, 'workspace.json')
      let workingDir = (inProcessGateway as any).workingDir
      if (fsMod.existsSync(wsConfigPath)) {
        try {
          const wsConfig = JSON.parse(fsMod.readFileSync(wsConfigPath, 'utf-8'))
          if (wsConfig.workingDir) workingDir = wsConfig.workingDir
        } catch { /* use default */ }
      }

      // Create .codey/uploads/ directory
      const uploadsDir = pathMod.join(workingDir, '.codey', 'uploads')
      fsMod.mkdirSync(uploadsDir, { recursive: true })

      // Generate unique filename
      const timestamp = Date.now()
      const random = cryptoMod.randomBytes(4).toString('hex')
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      const uniqueName = `${timestamp}-${random}-${safeName}`
      const filePath = pathMod.join(uploadsDir, uniqueName)

      // Write file
      const buffer = Buffer.from(data)
      fsMod.writeFileSync(filePath, buffer)

      const { randomUUID } = cryptoMod
      return {
        id: randomUUID(),
        name: fileName,
        path: filePath,
        mimeType,
        size: buffer.length,
      }
    })
  )
```

- [ ] **Step 4: Update chats:send handler to pass attachments**

Find the `chats:send` handler (line 585) and update it to pass attachments:

```typescript
  ipcMain.handle('chats:send', async (_e, payload: { chatId: string; text: string; attachments?: any[] }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const sink = (ev: any) => {
        sendToRenderer('chats:event', ev)
      }
      return inProcessGateway.sendToChat(payload.chatId, payload.text, sink, payload.attachments)
    })
  )
```

- [ ] **Step 5: Build Electron**

```bash
cd codey-mac && npx tsc -p tsconfig.electron.json --noEmit
```

Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/preload.ts codey-mac/electron/main.ts
git commit -m "feat(mac): add chats:upload IPC for file upload"
```

---

### Task 5: Update API service

**Files:**
- Modify: `codey-mac/src/services/api.ts`

- [ ] **Step 1: Add uploadFile method and update chats.send**

Open `codey-mac/src/services/api.ts`. In the `apiService` object, update the `chats` section:

```typescript
export const apiService = {
  // ... existing methods unchanged ...

  chats: {
    list: async (workspaceName?: string): Promise<Chat[]> =>
      unwrap(await window.codey.chats.list(workspaceName)),
    get: async (id: string): Promise<Chat> =>
      unwrap(await window.codey.chats.get(id)),
    create: async (input: { workspaceName: string; selection?: ChatSelection; title?: string }): Promise<Chat> =>
      unwrap(await window.codey.chats.create(input)),
    rename: async (id: string, title: string): Promise<Chat> =>
      unwrap(await window.codey.chats.rename(id, title)),
    delete: async (id: string): Promise<void> => {
      unwrap(await window.codey.chats.delete(id))
    },
    updateSelection: async (id: string, selection: ChatSelection): Promise<Chat> =>
      unwrap(await window.codey.chats.updateSelection(id, selection)),
    upload: async (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer): Promise<{ id: string; name: string; path: string; mimeType: string; size: number }> =>
      unwrap(await window.codey.chats.upload(chatId, fileName, mimeType, data)),
    send: async (chatId: string, text: string, attachments?: { id: string; name: string; path: string; mimeType: string; size: number }[]): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> =>
      unwrap(await window.codey.chats.send({ chatId, text, attachments })),
    stop: async (chatId: string): Promise<boolean> =>
      unwrap(await window.codey.chats.stop(chatId)),
    onEvent: (handler: (ev: ChatStreamEvent) => void): (() => void) =>
      window.codey.chats.onEvent(handler),
  },
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd codey-mac && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/services/api.ts
git commit -m "feat(mac): add uploadFile API and update chats.send signature"
```

---

### Task 6: Add attachment UI to ChatTab

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Add FileAttachment import and state**

At the top of `ChatTab.tsx`, add the import:

```typescript
import type { ChatSelection, FileAttachment } from '../types'
```

Add state for pending attachments inside the `ChatTab` component, after the existing `useState` declarations (after line 51):

```typescript
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 2: Add file upload handler functions**

Add these functions inside the `ChatTab` component, before the `send` function:

```typescript
  const uploadFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const maxSize = 10 * 1024 * 1024 // 10MB
    const maxAttachments = 10

    for (const file of fileArray) {
      if (pendingAttachments.length >= maxAttachments) break
      if (file.size > maxSize) {
        console.warn(`File ${file.name} exceeds 10MB limit`)
        continue
      }

      try {
        const buffer = await file.arrayBuffer()
        const attachment = await apiService.chats.upload(chatId, file.name, file.type || 'application/octet-stream', buffer)
        setPendingAttachments(prev => [...prev, attachment])
      } catch (err) {
        console.error(`Failed to upload ${file.name}:`, err)
      }
    }
  }

  const removeAttachment = (id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id))
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files)
    }
  }

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadFiles(e.target.files)
      e.target.value = '' // reset so same file can be re-selected
    }
  }
```

- [ ] **Step 3: Update send function to include attachments**

Replace the existing `send` function:

```typescript
  const send = async () => {
    if ((!input.trim() && pendingAttachments.length === 0) || !isGatewayRunning || !!flight) return
    const text = input
    const atts = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined
    setInput('')
    setPendingAttachments([])
    if (taRef.current) taRef.current.style.height = 'auto'
    await sendMessage(chatId, text, atts)
  }
```

- [ ] **Step 4: Add drag-drop overlay to messages area**

Replace the messages `<div>` (the one with `style={styles.messages}`) to wrap it with drag-drop handlers:

```tsx
      <div
        style={{ ...styles.messages, position: 'relative' }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div style={styles.dropOverlay}>
            <div style={styles.dropOverlayInner}>Drop files here</div>
          </div>
        )}
        {chat.messages.map(msg => {
```

- [ ] **Step 5: Add attachment display in user message bubbles**

Inside the message rendering loop, after the content `<Markdown>` block and before the timestamp div, add attachment display for user messages:

```tsx
                {msg.content && <Markdown variant={isUser ? 'user' : 'assistant'}>{msg.content}</Markdown>}
                {isUser && msg.attachments && msg.attachments.length > 0 && (
                  <div style={styles.attachmentsContainer}>
                    {msg.attachments.map(att => (
                      <div key={att.id} style={styles.attachmentChip}>
                        {att.mimeType.startsWith('image/') ? (
                          <img
                            src={`file://${att.path}`}
                            alt={att.name}
                            style={styles.attachmentThumb}
                            onClick={() => window.codey?.openPath?.(att.path)}
                          />
                        ) : (
                          <span style={styles.attachmentIcon}>📄</span>
                        )}
                        <span style={styles.attachmentName}>{att.name}</span>
                      </div>
                    ))}
                  </div>
                )}
```

- [ ] **Step 6: Add pending attachment preview chips above input**

Replace the `inputContainer` div to include the attachment preview area and the "+" button:

```tsx
      <div style={styles.inputContainer}>
        {pendingAttachments.length > 0 && (
          <div style={styles.pendingRow}>
            {pendingAttachments.map(att => (
              <div key={att.id} style={styles.pendingChip}>
                {att.mimeType.startsWith('image/') ? (
                  <img src={`file://${att.path}`} alt={att.name} style={styles.pendingThumb} />
                ) : (
                  <span style={{ fontSize: 11 }}>📄</span>
                )}
                <span style={styles.pendingName}>{att.name}</span>
                <button onClick={() => removeAttachment(att.id)} style={styles.removeBtn}>×</button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,text/*,.json,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.md,.yaml,.yml,.toml,.xml,.sh,.bash,.zsh,.log,.csv,.sql"
          style={{ display: 'none' }}
          onChange={handleFilePick}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!isGatewayRunning || isSending}
          style={styles.attachButton}
          title="Attach file"
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={C.fg3} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <textarea
```

- [ ] **Step 7: Add styles**

Add the new styles to the `styles` object at the bottom of the file:

```typescript
  dropOverlay: {
    position: 'absolute' as const, inset: 0, zIndex: 10,
    background: 'rgba(0,0,0,0.6)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, border: `2px dashed ${C.accent}`,
  },
  dropOverlayInner: {
    color: C.accent, fontSize: 16, fontWeight: 600,
  },
  attachmentsContainer: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 8,
  },
  attachmentChip: {
    display: 'flex', alignItems: 'center', gap: 4,
    background: 'rgba(255,255,255,0.08)', borderRadius: 6,
    padding: '4px 8px', fontSize: 11, maxWidth: 180,
  },
  attachmentThumb: {
    width: 32, height: 32, borderRadius: 4, objectFit: 'cover' as const, cursor: 'pointer',
  },
  attachmentIcon: { fontSize: 14 },
  attachmentName: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    color: C.fg2, maxWidth: 120,
  },
  pendingRow: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 6,
    padding: '8px 14px 0', borderTop: `1px solid ${C.border}`,
  },
  pendingChip: {
    display: 'flex', alignItems: 'center', gap: 4,
    background: C.surface3, borderRadius: 6,
    padding: '4px 6px', fontSize: 11,
  },
  pendingThumb: {
    width: 24, height: 24, borderRadius: 3, objectFit: 'cover' as const,
  },
  pendingName: {
    color: C.fg2, maxWidth: 100, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  removeBtn: {
    background: 'none', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1,
  },
  attachButton: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    background: C.surface3, display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
    transition: 'background 0.15s',
  },
```

- [ ] **Step 8: Verify dev build compiles**

```bash
cd codey-mac && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): add file upload UI with drag-drop and attachment chips"
```

---

### Task 7: Update useChats hook to pass attachments

**Files:**
- Modify: `codey-mac/src/hooks/useChats.tsx`

- [ ] **Step 1: Update sendMessage to accept attachments**

In `useChats.tsx`, find the `sendMessage` function in the context value (around line 311). Update it:

```typescript
    async sendMessage(chatId, text, attachments?) {
      const assistantMessageId = `asst-${Date.now()}-${Math.random()}`
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}-${Math.random()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
        isComplete: true,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      }
      pendingAssistantId.current[chatId] = assistantMessageId
      dispatch({ type: 'startSend', chatId, userMessage, assistantMessageId })
      try {
        await apiService.chats.send(chatId, text, attachments)
      } catch (err) {
        dispatch({ type: 'errorSend', chatId, assistantMessageId, error: `Error: ${(err as Error).message}` })
        delete pendingAssistantId.current[chatId]
      }
    },
```

- [ ] **Step 2: Update the ChatsContextValue interface**

Find the `ChatsContextValue` interface and update the `sendMessage` signature:

```typescript
interface ChatsContextValue {
  state: State
  createChat: (workspaceName: string) => Promise<Chat>
  selectChat: (chatId: string | null) => void
  renameChat: (chatId: string, title: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  setSelection: (chatId: string, selection: ChatSelection) => Promise<void>
  sendMessage: (chatId: string, text: string, attachments?: import('../types').FileAttachment[]) => Promise<void>
  stopChat: (chatId: string) => Promise<void>
  toggleWorkspace: (workspaceName: string) => void
  refreshWorkspaces: () => Promise<void>
}
```

- [ ] **Step 3: Add FileAttachment to the type import**

At the top of the file, update the import:

```typescript
import type { Chat, ChatSelection, ChatMessage, ToolCallEntry, FileAttachment } from '../types'
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd codey-mac && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx
git commit -m "feat(mac): pass attachments through useChats sendMessage"
```

---

### Task 8: Update types re-export

**Files:**
- Modify: `codey-mac/src/types/index.ts`

- [ ] **Step 1: Add FileAttachment to re-export**

```typescript
export type { ChatMessage, ToolCallEntry, Chat, ChatSelection, FileAttachment } from '@codey/core';
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd codey-mac && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/types/index.ts
git commit -m "feat(mac): re-export FileAttachment type"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Build all packages from monorepo root**

```bash
cd /Users/jackou/Documents/projects/codey && npm run build
```

Expected: All packages compile without errors.

- [ ] **Step 2: Launch the macOS app in dev mode**

```bash
cd codey-mac && npm run dev
```

Expected: App window opens without crashes.

- [ ] **Step 3: Test file upload flow**

1. Open a chat
2. Click the "+" button — file picker should open
3. Select a text file — preview chip should appear above input
4. Type a message and send — message should include the attachment
5. Verify the agent prompt includes the `[Attachments]` section (check gateway logs)

- [ ] **Step 4: Test drag-and-drop**

1. Drag a file from Finder onto the messages area
2. "Drop files here" overlay should appear
3. Drop the file — preview chip should appear
4. Send the message

- [ ] **Step 5: Test image upload**

1. Upload a PNG image
2. Verify thumbnail preview in the chip
3. Send and verify the agent receives the image path with vision instruction

- [ ] **Step 6: Final commit with all builds**

```bash
git add -A
git commit -m "feat: file upload support in macOS chat — complete implementation"
```
