# Message Compaction in Mac Chat View

Date: 2026-05-10
Status: Draft

## Problem

Two sources of clutter in the Mac chat view:

1. **Inline tool calls** in every assistant message duplicate what the right Context Panel already shows (added in 2026-05-09).
2. **Team Mode messages** show every worker's full output and every manager step inline, so the screen is dominated by intermediate reasoning rather than the final result. The user wants conclusions front-and-center, with worker detail available on demand.

## Scope

Pure frontend rendering change in `codey-mac/src/components/ChatTab.tsx`. No changes to gateway/core or to other channels (Telegram/Discord/iMessage/TUI) — those channels do not render `toolCalls` and the assistant text they receive stays unchanged.

## Design

### A. Remove inline tool display from messages

- Remove the `msg.toolCalls`-driven block in `ChatTab.tsx:539-605` (the tool-call list, expandable detail, and the `toolCallSep` separator that goes with it).
- Keep the `toolCalls` data on the message — the right Context Panel (`ChatContextPanel.tsx`) still consumes it.
- Remove the now-dead style entries (`toolCallsContainer`, `toolCallRow`, `toolCallInfo`, `toolCallSep`, `toolDetail`) and the `expandedIds` state and `toolFormat` imports if they are no longer referenced after the removal.
- Auto-open of the context panel when tool activity appears (`ChatTab.tsx:193-197`) stays — that behavior is now the only way users see tool activity in the new flow.

### B. Fold worker output in Team Mode

`formatManagerParts` (`gateway.ts:1911`) already produces a deterministic structure:

```
🧭 Manager summary: <final_summary>     (only when finalSummary is non-empty)

### Step 1: <worker>                    (or "<worker> (revision)")

<worker output markdown>

---

### Step 2: <worker>

<worker output markdown>
```

The Mac UI parses any assistant message whose content matches this pattern and renders it as a structured card instead of one big markdown blob.

**Parser:**
- Detect `🧭 Manager summary: ` prefix → extract summary line, strip from body.
- Split remaining body on `\n\n---\n\n`.
- For each chunk, match `^### Step (\d+): (.+?)\n\n([\s\S]*)$`. If any chunk fails to match, fall back to plain Markdown rendering of the whole message (no parsing applied).

**Render:**
- **Manager summary line** (if present): rendered at the top, visually emphasized (slightly larger / accent color). When `final_summary` is missing, nothing is shown in its place.
- **Each Step**: a collapsible card.
  - Collapsed (default for completed steps): one row showing `▶ Step N: <worker> · <preview>`.
    - `<preview>` = a one-sentence excerpt from the last non-empty paragraph of the worker's output. For ASCII text, this is the last sentence of that paragraph (agents typically conclude at the end). For CJK text (no spaces between sentences), this is the first CJK-terminated sentence of the paragraph. If no terminator is present, the whole paragraph is used. Truncated to ~120 chars with `…`.
    - If the worker output is empty, preview shows `(no output)`.
  - Expanded: full worker markdown rendered with the existing `<Markdown>` component.
- **Step status while running**: when a streaming response is in progress, the **last** parsed step is treated as "in progress" and rendered expanded by default; all earlier steps render collapsed. Once streaming completes (message no longer the streaming target), the last step also collapses.
- **Manager `Step X: worker — reason` info messages**: completely removed from the inline view. The right Context Panel's tool timeline already shows worker switches.

**Non-team / single-worker / plain-chat messages**: unchanged. The parser only activates when the content begins with either `🧭 Manager summary:` or `### Step 1:` — anything else falls through to existing `<Markdown>` rendering.

### Out of scope

- Backend changes to `formatManagerParts` output format (the marker `🧭 Manager summary:` and `### Step N:` headings are the contract this depends on).
- Any change to how Telegram/Discord/iMessage/TUI render team output.
- Persisting per-step expand/collapse state across app reloads.

## Edge cases

- **No final summary** (manager fallback paths, mid-run halts): summary line area is omitted entirely. No placeholder text.
- **Truncated step output** (`truncatePerStep` is set in some persisted-team paths in `gateway.ts:2053,2230,2302`): preview takes the last paragraph of the truncated text — acceptable.
- **Message edited via streaming**: parsing re-runs on every render; no caching needed for these short structures.
- **Worker output containing `\n\n---\n\n`**: would split incorrectly. Acceptable risk — agent output rarely contains that exact triple-newline-fenced separator. If a chunk fails the `### Step N:` regex match, the whole message falls back to plain Markdown rendering, so the worst case is graceful degradation.

## Files touched

- `codey-mac/src/components/ChatTab.tsx` — remove inline tool block; add team-message parser and collapsible step card rendering.
- Possibly a small helper extracted to a new file (`teamMessageFormat.ts`) if parser logic exceeds ~40 lines, to keep `ChatTab.tsx` focused.
