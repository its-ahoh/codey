# Agent media output (images + diagrams) — design

Date: 2026-10-21
Status: approved in chat, not implemented

## Problem

All four agents (Claude Code, Codex, OpenCode, pi) return Markdown text only.
Codey passes that text through unchanged:

- Mac app renders Markdown (GFM tables, code highlight) but has no `img`
  handling for local files (the `codey-asset://` protocol only serves
  `.codey/uploads/`) and no diagram rendering.
- Telegram / Discord / iMessage send text only. `GatewayResponse` has only
  `text` and `choices`; no channel calls a photo/file send API.

Email output is out of scope for this version.

## Decisions

1. **How an agent emits an image:** standard Markdown image syntax,
   `![alt](path)`, pointing at a file the agent saved. No new tool / MCP
   server, so all four agents work with only a prompt hint.
2. **Charts:** images work everywhere. Additionally, ` ```mermaid ` blocks are
   rendered as diagrams in the Mac app.
3. **Prompt by surface:** if the chat is reachable from a chat channel —
   the turn came from Telegram/Discord/iMessage **or the chat has any linked
   channel route** (`Chat.routes` non-empty) — the agent is told to draw
   charts/diagrams as PNG images, not mermaid. Otherwise (Mac-only chat) it
   is told mermaid blocks render as diagrams.

## Design

### 1. Image extraction (core)

New module `packages/core/src/output-media.ts`:

```ts
extractOutputImages(text: string, opts: { workingDir: string; now?: () => number })
  : { text: string; images: FileAttachment[] }
```

- Finds Markdown images `![alt](target)` (also `<target>` angle form).
- Accepts a target only if it is a **local** path (relative → resolved against
  `workingDir`; absolute; `file://` URL), with an image extension
  (png, jpg, jpeg, gif, webp, svg), the file exists, is a regular file,
  is ≤ 10 MB, and its realpath is inside `workingDir` or `os.tmpdir()`.
- Accepted files are **copied** to
  `<workingDir>/.codey/uploads/outputs/<timestamp>-<rand>-<basename>`, so
  later edits by the agent do not change chat history, and so the Mac app can
  serve them through the existing `codey-asset://` rule.
- The returned `text` has each accepted target rewritten to the snapshot path.
  Rejected targets and `http(s)` URLs are left untouched.
- Same source path referenced twice → one snapshot, one attachment.

The extractor runs once per completed assistant turn, before the message is
persisted and before it is sent to any channel. Assistant messages reuse the
existing `ChatMessage.attachments` field. `GatewayResponse` gains
`attachments?: FileAttachment[]`.

### 2. Mac app

- `Markdown.tsx` gets an `img` component: a path under `.codey/uploads/`
  renders via `codey-asset://`; `http(s)` images are **not** auto-loaded
  (a remote image can track when the chat is opened) — they render as a link;
  anything else shows the alt text. While a reply is still streaming the path
  is not yet rewritten, so the alt text shows until the turn completes. Images
  are max-width 100%.
- `code` blocks with `language-mermaid` lazy-load `mermaid`
  (`securityLevel: 'strict'`) and render SVG. On parse/render error, fall back
  to the normal code block. Theme follows light/dark.

### 3. Channels

Text first, then images. In the text, each `![alt](snapshot)` becomes
`[Image: alt]` (or `[Image]` when alt is empty).

- **Telegram:** `sendPhoto` for png/jpg/gif/webp ≤ 10 MB; `sendDocument` for
  svg.
- **Discord:** `channel.send({ files: [...] })`, one message with all images.
- **iMessage:** AppleScript `send POSIX file "<path>" to buddy "<recipient>"`,
  one per image.
- Both paths are covered: `sendMessage(response)` and the linked-chat fan-out
  `sendToRoute(route, text)` (gains an attachments argument).
- Long text is chunked (2000 chars). Images go out once, after the last chunk
  — both in `sendResponseWithChunking` and in `fanOutToOtherRoutes`.
- Every assistant message that reaches a channel is covered: solo replies,
  fan-out mirrors, and the team's final Aide summary. Images that only appear
  in an individual worker message (not forwarded to channels since #419) are
  lost on channels unless the Aide summary repeats the `![alt](path)`; the
  Aide summary prompt is told to keep image references it wants to show.
- Telegram `sendPhoto` recompresses images, which can blur charts. Charts are
  usually small, so photo stays the default for inline preview.
- Any single image failing → the text is still delivered and a follow-up line
  `Image failed to send: <name>` is sent. Failures are logged, never thrown up
  to the turn.

### 3b. Mermaid fallback link (channels)

Prompt hints reduce mermaid in channel-linked chats but cannot prevent it.
Mermaid can still reach a channel through: an agent ignoring the hint, the
Aide team summary (also an LLM), and the prior-history summary pushed by
`linkChat`. So the channel send layer — the single choke point all of these
pass through — adds a link for every ` ```mermaid ` block:

- New pure helper `mermaidLiveUrl(code)` in core: JSON
  `{"code": <source>, "mermaid": "{\"theme\":\"default\"}"}` →
  `zlib.deflateSync` → base64url → `https://mermaid.live/view#pako:<data>`.
  Node built-ins only, no new dependency. The diagram lives in the URL
  fragment, which browsers do not send to the mermaid.live server.
- The code block stays in the text. Each link is sent as its **own message**
  after the text (so chunking can never split a URL), labelled
  `Diagram preview: <url>`.
- If a URL is longer than the channel's message limit (Telegram 4096,
  Discord 2000; iMessage uses 2000), that link is skipped; the code block
  remains.
- Applies to `sendMessage`, `sendResponseWithChunking`, and every
  `sendToRoute` caller (fan-out, `linkChat` summary).

### 4. Prompt hint

A short block added to **every turn's prompt** (not only at session start).
Agent sessions are resumed across turns, so a chat that gets linked to a
channel mid-session must see the PNG rule on its very next turn.

- Always: "To show an image, save it as a file in the project (or a temp dir)
  and reference it with `![description](path)`."
- Chat reachable from a channel (see Decision 3): "Draw charts and diagrams as
  PNG image files; do not use mermaid."
- Mac-only chat: "` ```mermaid ` blocks render as diagrams."

### 5. Error handling

- Missing / too large / outside allowed dirs / non-image → left as text, debug
  log only.
- Copy failure → treated as rejected (text unchanged).
- mermaid render failure → code block.

### 6. Testing

- `output-media.test.ts`: relative/absolute/`file://` paths, outside-dir
  rejection (incl. symlink escaping), size cap, non-image ext, http untouched,
  duplicate references, snapshot copy, alt-text edge cases.
- Telegram / Discord / iMessage handler tests with mocked clients: photo vs
  document choice, text-then-image order, `[图：alt]` replacement, failure note.
- Prompt hint test: channel turn, Mac turn with linked route, Mac-only turn.
- `mermaidLiveUrl` round-trip test (inflate → same source); over-limit link skipped.
- Mac `Markdown` test: mermaid fallback on invalid source; `img` src mapping.

## Out of scope

- Email output.
- Downloading remote images to forward to channels.
- Server-side mermaid rendering.
