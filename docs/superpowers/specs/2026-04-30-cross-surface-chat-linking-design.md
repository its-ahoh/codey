# Cross-Surface Chat Linking

**Date:** 2026-04-30
**Status:** Design approved, awaiting implementation plan

## Goal

Let a single conversation be carried across the Mac app and any chat channel
(Telegram, Discord, iMessage). Users can start a chat in the Mac app and
continue replying from their phone, or start a chat from a channel and pick it
up at their desk. Linking is bidirectional and explicit — chats are not
auto-mirrored.

## Scope

In scope (v1):

- A unified Chat entity owned by the gateway, persisted across restarts.
- Explicit user action to link a Mac chat to a channel and vice versa.
- One channel user maps to one Mac user (single-owner deployment model).
- Channel-side slash commands to create, list, switch, and continue chats.
- Concurrency handling when both surfaces post into the same linked chat.

Out of scope (v1):

- Multi-party chats (a linked chat is one user on two surfaces, not a group).
- Channel-side rich UI (threads, buttons, inline keyboards) beyond plain text
  and slash commands.
- History backfill into the channel beyond a one-shot summary on first link.
- Search or filtering across all chats from a channel.

## Core model

A **Chat** is a gateway-owned entity. It has:

- `id`, `title`, `workspace`, `agentConfig` (existing per-chat agent/model).
- `messages[]` — full conversation history. Linked chats are persisted with
  no TTL and no message-count cap. Unlinked Mac chats keep their current local
  storage in the Mac app.
- `routes[]` — zero or more attached channel routes. Each route is
  `{channel: 'telegram' | 'discord' | 'imessage', channelUserId, channelChatId}`.
- `state` — `idle | running`, plus a `pendingTurn` buffer (see Concurrency).

"Linking" a chat means appending to `routes[]`. "Unlinking" means removing a
route. The Chat itself and its history persist regardless.

Channel-initiated chats are first-class Chats that simply start life with a
route already attached. They appear in the Mac app sidebar automatically.

## Identity and pairing

A new gateway-side store `pairings.json` records the mapping between Mac
identity and channel identity:

```
{
  macUser: "<id>",
  bindings: [
    {
      channel: "telegram",
      channelUserId: "12345",
      prefs: { workspace, agent, model }
    }
  ]
}
```

Pairing flow:

1. Mac app: user clicks "Link to Telegram" on a chat (or in settings).
2. Mac shows a 6-digit code.
3. User on phone: `/pair 482913` to the bot.
4. Gateway records the binding; modal closes; future links to that channel
   are zero-click.

If only one binding exists for a channel, the Mac header button uses it
directly. Multiple bindings → popover.

The `prefs` block hangs per-pairing defaults for channel-initiated chats
(workspace, agent, model). The existing `/workspace`, `/agent`, `/model`
slash commands update these prefs.

## Linking a Mac chat to a channel

Mac → gateway IPC: `chat.link(chatId, {channel, channelUserId})`.

Gateway behavior on link:

1. If the chat is not yet persisted (unlinked Mac chat), promote it from the
   Mac app's local store into the gateway's persistent chat store. From this
   point on the gateway is the source of truth for this chat.
2. Append the route to `chat.routes`.
3. Generate a short summary (3–5 sentences) of prior history via a lightweight
   LLM call.
4. Push the summary to the channel as the first message:
   *"📋 Picking up chat 'Refactor auth': you were in the middle of …"*

From here, channel messages route into this Chat's turn queue. The agent
keeps full context — the channel does not replay history beyond the summary.

Unlink: removes the route. History stays. Channel side gets a one-line
"Unlinked from Mac" notice.

## Channel-initiated chats

Slash commands on the channel side (default is implicit current chat, with
explicit commands as escape hatches):

- `/new [title]` — creates a new Chat using the paired user's stored prefs;
  sets it as the user's "current" chat.
- Plain message — routed to the current chat.
- `/list` — shows recent chats with short IDs and titles.
- `/switch <id>` — changes which chat is current.
- `/workspace <name>`, `/agent <name>`, `/model <name>` — update the
  pairing's stored prefs (already exist; semantics extended).

Channel-initiated chats appear in the Mac app sidebar automatically with a
route icon indicating their origin.

## Concurrency and queueing

Per-chat state machine:

- `idle` → a message arrives → transition to `running`; invoke the agent.
- More messages arrive while `running` → append to `pendingTurn` buffer.
- Agent finishes → if buffer non-empty, immediately start the next turn with
  the concatenated buffer. Light attribution when messages came from different
  surfaces, e.g. `[Mac] foo\n[Telegram] bar`.
- Cooldown moves from per-user (current 10s) to per-chat. Prevents accidental
  flood from one surface; does not penalize the user for typing on two
  devices.

Replies fan out to **all** attached routes plus the Mac app (if open).
Tool-progress events continue to stream to the Mac only; channels receive the
final response, matching today's behavior.

## Mac UI

- **Sidebar:** each chat shows small route icons (one per attached channel).
  Right-click opens a Link/Unlink submenu listing all paired channels.
- **Chat header:** a quick-action button.
  - One channel paired → one-tap link/unlink toggle for that channel.
  - Multiple channels paired → popover with options.
  - No channels paired → opens pairing modal.
- **Notifications:** when a channel message arrives for a linked chat,
  Electron notification fires and the sidebar entry bumps with an unread
  badge.

## Persistence

New `chats/` directory in the gateway data directory, one JSON file per
persisted chat. Linked chats and channel-initiated chats live here. The
existing `ConversationManager` becomes an in-memory cache layer in front of
this store; its 30-minute TTL and 10-message cap apply only to unlinked
ephemeral conversations.

Unlinked Mac chats remain in the Mac app's local Electron storage until the
user links them, at which point they are promoted to the gateway store.

## Component impact summary

- `packages/gateway/src/conversation.ts` — extend or split: add persistent
  layer, per-chat queue + cooldown, pendingTurn buffer.
- `packages/gateway/src/channels/*.ts` — add slash command handlers
  (`/pair`, `/new`, `/list`, `/switch`); route plain messages to current chat.
- New `packages/gateway/src/pairings.ts` — pairing store and code generation.
- New `packages/gateway/src/chats.ts` (or similar) — persistent chat store.
- `codey-mac/electron/main.ts` + preload + `services/api.ts` — IPC for
  link/unlink, pairing modal, route metadata on chat objects.
- `codey-mac/src/components/*` — sidebar route icons, header quick-action,
  pairing modal, route-aware notifications.
- `packages/core` — small Chat type extension for `routes[]`.

## Open implementation questions

These are deferred to the implementation plan, not the design:

- JSON-per-chat vs. SQLite for the persistent chat store. JSON matches the
  existing workspace storage style; SQLite scales better but is heavier.
- Exact summary prompt and token budget.
- Whether iMessage's lack of native reply threading affects `/list` UX
  (probably not; it falls back to plain text).
- Migration path for existing in-memory conversations at the moment this
  feature ships (likely: discard them, since they're ephemeral by design).
