# ASK_USER Choice Buttons

Date: 2026-05-10
Status: Draft

## Problem

When a worker (or any agent run) needs user confirmation — a Yes/No, a permission-like accept/reject, or a pick-one-of-few decision — the only way for the user to answer today is to type free text. The marker `[ASK_USER]: <question>` pauses the team and waits for a textual reply.

This is needlessly slow for the common case. The user knows exactly which option they want; they should be able to tap a button instead of typing.

## Goals

- Let workers express that a question is a closed-choice question (Yes/No, A/B/C).
- Render those questions as native click-to-answer UI in channels that support it (Mac app, Telegram, Discord).
- Degrade gracefully on channels without button affordances (iMessage, TUI): show a numbered list, accept the digit as the answer.
- Continue accepting free-text replies in all cases — buttons are a shortcut, not a constraint.
- Cover both the team pause flow and any plain-chat agent output that contains the marker.

## Non-Goals

- Intercepting CLI-level permission prompts (Claude Code / Codex / OpenCode). Those are owned by the agent process and not visible to the gateway.
- Multi-select questions. v1 is single-select only.
- Rich UI beyond labelled buttons (no images, no menu groups).
- Persistent UI state after the question is answered (buttons should be ephemeral; the chat record stores the answer as plain text).

## Protocol

New marker:

```
[ASK_USER:choice]: <question> | <option 1> | <option 2> [| <option N>]
```

Rules:

- The marker still occupies a single line, same as `[ASK_USER]:` and `[ASK: name]:`.
- The question is the text after `:` and before the first ` | `.
- Options are everything after, split on `|` and trimmed.
- **At least 2 non-empty options** are required. If a parser sees the `:choice` suffix but ends up with fewer than 2 valid options, it falls back to treating the line as a plain `[ASK_USER]:` with the entire payload as the question (graceful degradation).
- Options containing a literal `|` are not supported; workers are instructed to rephrase. We do not invent an escape syntax in v1.
- Maximum 8 options. Beyond that, the parser keeps the first 8 and drops the rest (logged at debug).
- Empty / whitespace-only options are skipped.

Worker prompts (`packages/core/src/workers.ts`, three locations: solo worker, sequential team member, auto-routed worker) gain one sentence:

> When the question is a yes/no or pick-one of a small set of explicit options, use `[ASK_USER:choice]: <question> | <option 1> | <option 2>`. For open-ended questions keep using `[ASK_USER]: <question>`.

## Architecture

### Parsing (`packages/core/src/utils/ask-user.ts`)

Extend the `AskUser` type:

```ts
export interface AskUser {
  preamble: string;
  question: string;
  options?: string[];     // present only for choice variants; at least 2 entries when present
}
```

`AskMarker` keeps the same shape; the `'user'` variant carries the optional `options`.

Update both regexes to accept an optional `:choice` suffix:

```
/^\s*\[ASK_USER(?::choice)?\]\s*:\s*(.*)$/
```

When `:choice` is present:
1. Split the captured payload on `|`.
2. First segment = question.
3. Remaining segments = options. Trim each; drop empties; cap at 8.
4. If fewer than 2 options remain, drop the `options` field (downgrade to plain text question).

The `[ASK: <teammate>]:` regex is unchanged and does not gain a choice variant in v1 — workers cannot offer buttons when delegating to peers (the recipient is another LLM, not a user).

### Render payload (`packages/gateway/src/team-pause.ts`)

`renderQuestionMessage` keeps returning a `string` (the visible message body). A new helper exports the choices alongside it so callers can pass both to the channel:

```ts
export interface QuestionRender {
  text: string;
  choices?: string[];   // present when worker emitted choice options
}

export function renderQuestion(
  workerName: string,
  preamble: string,
  question: string,
  options?: string[],
  truncate = 500,
): QuestionRender;
```

`renderQuestionMessage` becomes a thin wrapper that returns `.text` for code paths that don't yet thread choices through.

### Channel transport

`ChannelAdapter.send(route, payload)` today accepts a string. Extend the signature to:

```ts
type SendPayload = string | { text: string; choices?: string[] };
send(route: ChatRoute, payload: SendPayload): Promise<void>;
```

Default behaviour for any handler that doesn't override: stringify and send `text` only. Telegram / Discord / Mac app override to render buttons.

Gateway call sites that currently do `channel.send(route, renderQuestionMessage(...))` change to `channel.send(route, renderQuestion(...))`. Five call sites exist (`gateway.ts:2016, 2152, 2253, 2341, 2436, 2489`); all five are pause-emitting paths and all should pass the new payload.

### Pending state and plain-chat coverage

Two flows now parse `[ASK_USER:choice]`:

1. **Team / worker flow** (existing) — pauses via `PendingTeamState`. Both variants gain `options?: string[]`, persisted alongside the question so resume logging and digit-mapping fallback can resolve the option text.
2. **Plain chat flow** (new) — when an agent's response in a non-team chat contains the marker, the gateway parses it and forwards the choices to the channel, but does **not** create a `pendingTeam`. The user's next message (button tap or typed text) is just a normal next turn for the agent. To support digit mapping in this flow, persist `lastAskedOptions?: { options: string[]; messageId: string }` on the `Chat` record; clear it whenever the user sends any new message.

Mac app render condition (covers both flows): render the button row on a message whose `choices` is present **iff** that message is the latest assistant message AND no user message has been sent after it. This decouples rendering from `pendingTeam` and works uniformly for team pauses and plain chat.

Digit-mapping condition (gateway-side, channel-agnostic): if the incoming user text matches `/^\s*(\d+)\s*$/` and `chat.pendingTeam?.options` OR `chat.lastAskedOptions?.options` is present and in range, replace the text with the resolved option before continuing normal handling. After resolution (or after any non-matching message), clear `lastAskedOptions`.

### Channel implementations

| Channel | Behaviour |
|---|---|
| **Mac app** (`codey-mac/src/components/ChatTab.tsx`) | Messages carry an optional `choices: string[]` field, persisted alongside text. Render the button row only when the message is the most recent assistant message AND the chat still has `pendingTeam` set (i.e., the question hasn't been answered yet). Clicking a button sends the option text as a normal user message; once the answer is consumed and `pendingTeam` clears, the buttons stop rendering on subsequent re-renders / reloads. |
| **Telegram** (`packages/gateway/src/channels/telegram.ts`) | When `choices` is present, attach `reply_markup: { inline_keyboard: [[{ text, callback_data: text }, ...]] }`. Wrap rows at 3 buttons. Subscribe to `callback_query`; on event, emit a `UserMessage` with the button text as `text`, then call `answerCallbackQuery` to dismiss the loading spinner. |
| **Discord** (`packages/gateway/src/channels/discord.ts`) | Build `ActionRowBuilder<ButtonBuilder>` with up to 5 buttons per row (Discord cap). `customId` = stable hash so we can correlate; button label = option text. On `InteractionCreate` of type `Button`, emit a `UserMessage` and call `interaction.update({ components: [] })` to disable. |
| **iMessage** (`packages/gateway/src/channels/imessage.ts`) | Append `\n\n1) <option1>\n2) <option2>\n...` to the text. No native buttons. |
| **TUI** (`packages/gateway/src/channels/tui.ts`) | Same as iMessage. |

### Digit mapping for text-fallback channels

When a chat has `pendingTeam` set AND `pendingTeam.options` is present:

- If the incoming user message text matches `/^\s*(\d+)\s*$/` and the number is in range `[1, options.length]`, replace the text with `options[n-1]` before invoking `resumeTeamFromAnswer`.
- Otherwise pass the text through unchanged (free-text reply still works).

This mapping lives in the gateway (channel-agnostic), so it works for any channel that doesn't render buttons.

### Worker-prompt update

In `packages/core/src/workers.ts`, the three prompt templates that already mention `[ASK_USER]:` (solo worker, sequential team member, auto-routed worker) each gain the additional sentence described above in the Protocol section.

## Data Flow

1. Worker (LLM) emits `[ASK_USER:choice]: 要合并到 main 吗？ | 是 | 否 | 让我看 diff` as its final output.
2. Gateway's `parseAsk` returns `{ kind: 'user', question, options: ['是','否','让我看 diff'], preamble }`.
3. Gateway persists `PendingTeamState` (including `options`) and calls `channel.send(route, renderQuestion(...))`.
4. Channel adapter renders text + buttons (Telegram/Discord/Mac app) or text + numbered list (iMessage/TUI).
5. User taps button → channel emits a `UserMessage` whose text is the option label.
   User types `2` on iMessage → gateway maps digit to `options[1]` ("否") before resume.
   User types "actually let's hold off" → passed through unchanged (free text).
6. `resumeTeamFromAnswer` runs as today; no changes to the resume logic itself.

## Testing

- **`ask-user.test.ts`** — add cases:
  - basic choice parse with 2 / 3 / 8 options
  - degradation when `:choice` is present but no `|`
  - degradation when only 1 valid option after trim
  - cap at 8
  - `|` whitespace tolerance
  - `[ASK: name]:` unaffected
- **`team-pause` rendering** — verify `renderQuestion` returns both text and choices, that choices are absent for plain ASK_USER.
- **Gateway digit mapping** — unit test mapping `"2"` → `options[1]`, out-of-range left as-is, no mapping when `options` absent.
- **Manual** — verify Mac app button render+click, Telegram inline keyboard, Discord buttons end-to-end on a real team with a choice question.

## Risks / Open Questions

- **`|` in option text**: workers are instructed to rephrase. We accept that a small fraction of malformed markers will degrade to plain text rather than introducing an escape grammar.
- **Telegram callback_data 64-byte limit**: option text longer than 64 bytes won't fit in `callback_data`. Mitigation: when an option exceeds 60 bytes, fall back to indexed callback data (`"opt:0"`, `"opt:1"`) and resolve via the persisted `pendingTeam.options` on the gateway side. Implement only if/when we hit this in practice — v1 caps option labels at 60 visible chars by convention in the prompt instruction.
- **Discord 5-buttons-per-row + 5-row cap (25 max)**: our 8-option cap is well under.
- **Race between button click and free-text reply**: both arrive as `UserMessage`s; existing single-flight + `pendingTeam` consumption handles this — whichever lands first resumes, the other is treated as a new turn.

## Out of Scope (deferred)

- Multi-select.
- Rich UI (icons, descriptions).
- Intercepting CLI permission prompts.
- Choice variant for `[ASK: <teammate>]:` (workers don't ask other workers via buttons).
