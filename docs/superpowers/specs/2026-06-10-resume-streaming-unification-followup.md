# Resume Streaming Unification — Follow-up Stub

**Date:** 2026-06-10
**Status:** Not started — captured as follow-up from the real-thinking-fold work.

## Why this exists

The real-thinking-fold feature (`2026-06-07-real-thinking-fold-design.md`) wired
extended-thinking through the **primary** team path (`runTeamForChat`:
sequential, manager/auto, parallel) — live step-tagged streaming plus
`thinkingByStep` persisted on the assistant `ChatMessage`.

It does **not** cover the **pause/resume** path (`resumeTeamFromAnswer` +
`runAllMembersInOrder` in `packages/gateway/src/gateway.ts`). That path is a
separate, older mechanism with a different contract:

- Streams via `sendResponse` (channel chunking), not the chat `sink` — so no
  token-level streaming and no `thinking` stream events.
- Emits the legacy `📊 Team {name} results\n\n...` format, **not** the
  `### Step N:` structure that `parseTeamMessage` + the mac `ThinkingBlock`
  rendering depend on.
- Truncates each worker's output to 500 chars.
- Returns `void` and does not build a structured `thinkingByStep`-bearing
  `ChatMessage`.

Because of this, surfacing thinking on resume is blocked on a larger change:
**unifying the resume path onto the same sink + structured-message pipeline as
`runTeamForChat`.** That is a refactor of resume behavior for all surfaces
(Telegram/Discord included), with its own pause-re-pause state edges — out of
scope for the thinking feature and deserving its own brainstorm.

## Goal (when picked up)

Make a resumed team run behave like a fresh one from the UI's perspective:
- stream worker output (and thinking) token-by-token through the chat `sink`,
- emit the `### Step N:` structured format,
- stop truncating output,
- persist a `thinkingByStep`-bearing assistant `ChatMessage` (merging steps
  completed before the pause with steps run after resume).

## Scope notes / open questions

- Does the resume path need to keep the channel-text behavior for non-mac
  surfaces, or can all surfaces move to the unified pipeline?
- How to merge pre-pause steps (currently in `pending.partsSoFar`) with
  post-resume steps into one structured message + one `thinkingByStep` map.
- Re-pause during a resumed run (worker asks again) must round-trip the
  accumulated thinking through `pendingTeam` — which is why the dead
  `pending.thinkingByStep` field would come back, this time actually read.

## Not doing now

This stub is intentionally not a full design. Start with the
`superpowers:brainstorming` skill when this is prioritized.
