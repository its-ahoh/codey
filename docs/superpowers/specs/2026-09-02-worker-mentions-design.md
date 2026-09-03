# @worker mentions in chat

## Goal

Let a chat message address workers directly with `@name`. One mention runs that
worker alone. Two or more mentions form an ad-hoc team from exactly those
workers. The user may say how the work is split; when they do not, the Advisor
splits it, exactly as an `auto` team does today.

## Behaviour

- `@alice fix the tests` runs worker `alice` on the message.
- `@alice @bob ship the login page` builds a temporary team `{alice, bob}` in
  `auto` mode. The Advisor picks who works next and can loop back.
- `@alice write the API, @bob write the UI for it` is the same team. The
  Advisor is told the user named these workers on purpose and must honour any
  assignment written in the message. No heuristic tries to detect assignments;
  the Advisor reads them.
- Both `@alice` and `@worker:alice` are accepted. The Mac composer inserts the
  namespaced form (like `@skill:x`); channels can type the short form.
- Unknown `@tokens` are left alone (they may be files or skills).
- Mentions are replaced by the bare worker name in the task text, so
  "@alice writes tests" reads as "alice writes tests" to the workers.
- Ad-hoc runs pause/resume like normal teams (`[ASK_USER]`). The pending state
  carries the member list because the team is not in the registry.
- A chat that has a team selected keeps running that team; mentions are not
  parsed there. Slash turns and paused-team answers are also untouched.

## Design

- `packages/core/src/worker-mentions.ts`: pure `parseWorkerMentions(text,
  isWorker)` → `{ workers, task }`. Deduped, in order of first mention.
- `packages/core/src/types/pending-team.ts`: optional `members` on the
  sequential and auto variants of `PendingTeamState`.
- `packages/gateway/src/gateway.ts`:
  - `sendToChat`: after slash/pending handling and before the prompt is built,
    parse mentions. When any resolve, set an ad-hoc `TeamConfig` (one member →
    `all`, several → `auto`) and treat the turn as a team turn (no session
    resume, team branch). Append an "[Addressed workers]" note to the prompt.
  - `runTeamForChat` / sequential pause: persist `members` with the pending
    state. `resumeTeamFromAnswer`: fall back to `pending.members` when the
    registry has no team of that name.
- `codey-mac/src/components/mentions.ts`: new `worker` kind; `RESOURCE_KINDS`
  gains `'worker'`; `appendMentionContext` skips workers (they route, they are
  not hints).
- `codey-mac/src/components/ChatTab.tsx`: load workers into the mention index
  with their dispatch hint as detail; render with the `users` icon.

## Out of scope

- Mentioning a team (`@team:x`).
- Parsing mentions in the channel slash-command parser (`handleMessage`) —
  plain channel text already reaches `sendToChat`, so channels get this too.
- Persisting an ad-hoc team as a named team.

## Testing

- Core: unit tests for `parseWorkerMentions`.
- Mac: `mentions.test.ts` covers the worker kind and the skipped context.
- Gateway: no `sendToChat` test harness exists; routing verified by `tsc` and
  a manual run.
