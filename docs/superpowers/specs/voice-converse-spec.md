# `/voice/converse` — streaming voice conversation endpoint (v1 spec)

Status: **final** (architect, 2026-08-02). Supersedes the separate `/voice/speak`
idea — there is exactly one streaming endpoint for the whole voice round-trip.

## Placement

- Served by the gateway **health server** (`packages/gateway/src/health.ts`,
  port+1), under the existing `/voice/` prefix.
- Reuses the existing `/voice/*` guards as-is: reject browser-origin requests
  (any `Origin` header → 403) and non-darwin platforms.
- Caller is the Swift helper (`voice/Sources/CodeyVoice/GatewayClient.swift`)
  when `VoiceConfig` mode is `converse` (new field, delivered through the
  existing `/voice/config` polling; default stays `inject`).

## Request

```
POST /voice/converse
Content-Type: application/json

{ "transcript": "切换到 codey 工作区", "conversationId": "optional-string" }
```

- `transcript` — final STT text, required, non-empty.
- `conversationId` — optional; reuse the conversation manager's id so
  follow-ups ("说详细点") share context and the digest cache.

## Response

`Transfer-Encoding: chunked`, `Content-Type: application/x-ndjson`.
One JSON object per line. Rationale: `URLSession.bytes` line-parsing is
trivial in Swift; base64 audio overhead is irrelevant on localhost; no
custom binary framing.

### Event order

```
start → ack? → (command | (text/audio pairs)*) → done | error
```

### Events

| type | fields | semantics |
|------|--------|-----------|
| `start` | `tts: "server" \| "client"` | Always first. Declares **once per response** who synthesizes audio. `server`: `audio` events will follow each `text`. `client`: gateway TTS unavailable (no key / synth failure at open) — helper speaks `text` events itself via AVSpeechSynthesizer. |
| `ack` | `text` | Short spoken acknowledgment ("好的，我去处理"), emitted **before** the agent runs, so the user never sits through 30s of silence while a slow agent works. Skipped on the command short-circuit path (the command result itself is immediate). |
| `command` | `action`, `result` | `parseVoiceCommand` matched: the gateway executed the action (workspace switch / notifications / list) and reports the spoken result. Followed directly by `done`; the agent never runs. |
| `text` | `seq`, `text` | One digest sentence. **Always sent regardless of tts mode** — it feeds the HUD, the conversation record, and the client-side TTS fallback. |
| `audio` | `seq`, `format` (`"mp3"`), `dataBase64` | TTS audio for the same-`seq` `text` event. Only when `tts: "server"`. Sentence-aligned; `text` for a given `seq` always precedes its `audio`. |
| `done` | — | Normal termination. |
| `error` | `message` | Terminal failure. If any `text` events were already delivered, the helper should still speak/keep them; `error` only describes what was lost. |

Mid-stream TTS failure (server mode, synth dies after `start`): keep sending
`text` events, stop sending `audio`, and include `ttsDegraded: true` on the
final `done` so the helper knows to speak any `text` seqs that never got audio.

## Gateway-side pipeline (all in `packages/core` / gateway wiring)

1. `parseVoiceCommand(transcript)` → match: execute, emit `command`, `done`.
   Exception: `more-detail` ("说详细点" / "more detail") replays the cached
   pre-digest reply as ordinary `text`/`audio` pairs rather than a one-line
   `command` result — the agent does not re-run. With nothing cached it
   reports so via `command` and stops.
2. No match → emit `ack`, run the agent through the normal conversation path.
3. Agent reply → `needsDigest(reply, verbosity)`; if true, run
   `buildSpeechDigestPrompt`. Cache the **full original reply** per
   `conversationId` first, so step 1's `more-detail` path can read it back.
   The digest runs as a direct streaming API call when the resolved model
   carries credentials (`voice.tts.digestModel`, else the advisor's model),
   falling back to a one-shot API call, then to an agent CLI spawn.
4. Split digest output on sentence boundaries → for each sentence emit `text`,
   then (server mode) synthesize and emit `audio`. Synthesis starts as soon as
   a sentence is complete and runs concurrently; only `audio` emission is
   serialized, so sentence N+1 never waits on sentence N's audio.

`verbosity` (`full | digest | auto`) lives in `VoiceConfig`, editable from the
Mac app settings, delivered via existing `/voice/config`.

## Swift helper contract (CodeyVoice)

- New `VoiceCoordinator` state `.speaking`, entered on receiving `start`;
  `reportStatus("speaking")`.
- Playback via **AVAudioEngine** (not AVAudioPlayer): queue `audio` segments
  in `seq` order; leaves room for v2 echo cancellation.
- `tts: "client"` or missing-audio seqs at `done`: speak the text with
  AVSpeechSynthesizer. The chain must always produce sound.
- Hotkey during `.speaking` = **barge-in**: cancel the URLSession task, stop
  playback, transition straight to `.recording`. This same transition is the
  v2 VAD slot (VAD replaces the hotkey trigger; the state machine is
  unchanged).
- Esc during `.speaking`: cancel task, stop playback, back to `.idle`
  (reuse the existing Esc monitor pattern).
- Gateway unreachable / request fails before `start`: HUD error, back to
  `.idle` — same as today's transcription failure path.

## Explicitly out of scope for v1

- VAD / hands-free continuous conversation (v2; barge-in transition is its slot).
- LLM intent classification for commands (whitelist only; no-match = chat).
- Echo cancellation (moot under push-to-talk).
- Telegram/Discord voice notes (Digest + TTS live in core precisely so this
  can be added later without moving code).
