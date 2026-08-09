# Assistant turn header + document flow

**Date:** 2026-08-07
**Surface:** `codey-mac` chat tab
**Supersedes:** `2026-08-07-assistant-document-layout-design.md`, whose implementation
(PR #205, commit `3845b7a`) was reverted by PR #208.

## Why this exists

The previous design removed the assistant bubble so long replies would read as a document.
The typography half of it was right. The structural half was not: the bubble had been carrying
information, and only two of its three jobs were replaced.

What went wrong, precisely:

- The design preserved the horizontal text inset exactly (row 6 + rail 3 + padding 12 = 21px,
  matching the old row 6 + border 1 + bubble padding 14) but silently dropped **10px of
  vertical padding** when `padding: '10px 14px'` became `'0 0 0 12px'`.
- A turn's first element is often 11px `C.fg3` secondary chrome — the collapsed "Show thinking"
  toggle. With no background and no space above it, it sat flush against the previous message.
- Message boundaries were left to `marginBottom: 20`. Spacing alone is a weak boundary; it
  competes with the paragraph spacing inside the reply, which the same change had just
  increased to 14px.

Reported symptom: the collapsed "Show thinking" toggle disappeared **entirely**. That is not
explained by the diff — `git diff e35e536..3845b7a -- ChatTab.tsx` matches no line containing
"thinking", and the `ThinkingBlock` render path was untouched. **This discrepancy is
unresolved.** See "Open question" below; the design does not depend on the answer, but the
implementation must not assume the answer either.

## Decision

Keep the document flow. Give each assistant turn an explicit header — a metadata row above a
hairline rule — and let that header be the boundary the bubble used to provide.

This is not decoration. Spacing is an implicit boundary that competes with the content's own
spacing; a rule is an explicit one that does not. The previous design's weakest point becomes
the new design's structural element.

The header also gives the thinking disclosure a permanent home. Previously it was a floating
11px line above the reply with nothing to anchor it.

## Design

### 1. Anatomy

```
claude-code · opus  ▸                    12s · 3.4k tok
──────────────────────────────────────────────────────
(thinking body, when expanded)

Reply body, 14px / 1.7, capped at 78ch

                                                 10:42
```

- **Header left:** `agent · model`, then the disclosure chevron immediately to its right.
  The chevron renders only when the message has thinking.
- **Header right:** `durationSec` and `tokens`, plus the fallback badge when present.
- **Rule:** 1px `C.border2`, spanning the text column (the same 78ch cap as the body).
- **Timestamp:** stays in the footer, where it is today. It is not part of the header.

### 2. The empty case

The rule renders for every assistant turn. The metadata row renders only when it has something
to show.

A message with no model, no thinking, no duration and no tokens therefore produces a bare
hairline rather than an empty text line. The boundary still exists — which is the invariant that
matters, and the one the previous design failed to hold — but there is no blank row.

### 3. What moves out of the footer

`ChatTab.tsx:2156` currently renders `tsLabel`: timestamp on the left, and in `tsRight` the
model badge, the fallback badge, and `tokens · duration`. Every item in `tsRight` is
assistant-only. The whole span moves to the header.

The footer therefore becomes timestamp-only for both roles — a simplification, not just a move.
Nothing is shown in two places; duplicated metadata reads as two different facts.

### 4. Streaming

`durationSec` and `tokens` are set when the turn completes. During streaming the header shows
`agent · model` and nothing on the right; the values appear on completion. Both live on the
right edge and grow leftward, so the left side never shifts.

`LiveActivity` (`ChatTab.tsx:1996`) moves from the top of the container to **below** the rule.
It is content belonging to the turn, not identification of it.

### 5. Container

The assistant container is as the reverted design specified, with the padding bug fixed:

- no background, border, shadow, or radius
- `maxWidth: 'min(100%, 78ch)'` — `ch` resolves against the container's 13px font, so 78ch
  ≈ 562px ≈ 72 characters of 14px body text, or ~43 Chinese characters
- `padding: '6px 0 0 12px'` — the 6px top is the previously-dropped vertical padding
- selected state: 3px left accent rail, always present and transparent when unselected, so
  selecting a turn does not shift the text column

User messages keep the bubble untouched.

### 6. Typography

Unchanged from the reverted design, which was not the problem: `Markdown.tsx` gains
`layout?: 'compact' | 'roomy'`, `compact` stays the default so the other sixteen call sites do
not move, and only the main assistant body passes `roomy`. That work is recoverable verbatim
from commits `81cd2d1`, `1203888`, `483eb23`, `81519e9` on the reverted branch, including the
`tableGap` fix and the `Metrics` interface.

## Components

**New file** `codey-mac/src/components/TurnHeader.tsx`. `ChatTab.tsx` is 3265 lines and already
does too much; new code has no reason to go into it.

It exports two things:

- `turnHeaderMeta(msg)` — a **pure function** producing the right-side items from a
  `ChatMessage`. This is the part with real failure modes: a missing field must not leave an
  orphaned `·` separator, `durationSec` may be `undefined` or non-finite, `tokens` may be
  absent, and the fallback badge is conditional.
- `TurnHeader` — the presentational component.

## Testing

Unlike the previous change, this one has genuinely testable logic, and it gets real tests:
`turnHeaderMeta` is pure, and its failure modes are concrete (orphaned separators, non-finite
duration, all-fields-absent producing an empty row rather than a stray `·`).

The layout itself remains presentation-only and is verified by typecheck, the existing suite as
a regression check, and human visual review. No tests will be written asserting that a style
constant equals itself.

**Visual review must actually be performed this time.** The previous round shipped on
"typecheck clean, 322 tests passing", which proved only that nothing else broke — and the
change was reverted a few hours later for a defect no automated check could have caught.

## Open question

Why the "Show thinking" toggle vanished completely under #205 is not established. The two
possibilities:

- **Layout.** Then it is fixed by construction here: the chevron lives in a header that is
  always rendered, not in a floating unanchored line.
- **Data** — `msg.thinking` is empty. Then the chevron will never appear and this design
  changes nothing about it. The path to check is `useChats.tsx:225` (`thinkingToken`) through
  to persistence; `thinking` is declared on `ChatMessage` (`packages/core/src/types/chat.ts:57`)
  so it is expected to survive a reload.

The implementation must verify which, and must not treat an absent chevron during review as
"working as designed".

## Risks

- Removing the assistant background reduces figure/ground separation against the chat backdrop.
  The header rule now provides most of that structure. If it still reads flat, the fallback is
  a very subtle background on the assistant column — not restoring the bubble.
- The header adds chrome to every turn, including one-line replies where it may outweigh the
  content. This is the case to look at hardest during visual review.
- Nested Markdown inside team and thinking blocks stays `compact` while the surrounding turn is
  `roomy`, so a size step is visible at that boundary. Accepted: those blocks are deliberately
  secondary.
