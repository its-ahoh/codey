# Assistant messages as document flow

**Date:** 2026-08-07
**Surface:** `codey-mac` chat tab

## Problem

Long assistant replies read as a dense wall. Five causes, all located:

1. **Line length.** `ChatTab.tsx:2008` caps the bubble at `maxWidth: '72%'`. On a wide
   window a line reaches 100+ characters; comfortable measure is 45–75. Longer lines
   cost a return sweep on every line.
2. **No paragraph rhythm.** `Markdown.tsx:178` gives `p` a `margin-bottom` of 8px, while
   13px × 1.55 leading already leaves ~7px between lines. Paragraph spacing and line
   spacing are nearly equal, so the paragraph stops being a visual unit.
3. **Hard breaks amplify it.** `Markdown.tsx:292` runs `preserveLineBreaks`, turning the
   single newlines that fill LLM output into hard breaks — a block of evenly packed lines.
4. **No section anchors.** `Markdown.tsx:194-197`: h3 is 14px and h4 is 13px against 13px
   body text, with 6–8px top margins. Nothing signals "new section" when scanning.
5. **CJK is hit harder.** 1.55 leading is acceptable for Latin text but cramped for Chinese,
   which has a high character-face ratio and no ascenders/descenders to create air.

## Decision

The bubble becomes the marker for *what the user said*. Assistant output renders as a
document.

Considered and rejected:

- **Tune typography inside the bubble.** Smallest change, but a very long reply stays one
  enormous bubble.
- **Fork on length.** Short replies keep the bubble, long ones go document. Rejected for the
  threshold: a streaming reply would change shape mid-flight, and the threshold itself is a
  parameter with no principled value.

A single unconditional rule has no threshold, no latch, and no mid-stream reshaping.

## Design

### 1. Structure

Split the message container at `ChatTab.tsx:2007` on `isUser`.

- **User:** unchanged — right-aligned, `maxWidth: '72%'`, `C.userBg`, asymmetric radius.
- **Assistant:** drop `background`, `border`, `boxShadow`, `borderRadius`; padding becomes
  `0 0 0 12px`, which with the 3px rail below reproduces today's text inset exactly
  (row padding 6 + border 1 + bubble padding 14 = 21 → 6 + 3 + 12 = 21), so the text
  column does not move; width becomes `maxWidth: 'min(100%, 78ch)'`.

`ch` resolves against the container's own 13px font, so 78ch ≈ 562px ≈ 72 characters of the
14px roomy body text, or ~43 Chinese characters — both inside the comfortable range.

The `ch` cap is what fixes cause (1): ~640px at 14px, and it does not grow with the window.
Code blocks and tables gain width — today they are squeezed into 72% minus bubble padding.

### 2. Restore what the bubble was carrying

The bubble had two jobs beyond decoration. Both must be replaced or this is a net regression.

- **Selected state.** Today `isSelected` draws an accent border plus glow
  (`ChatTab.tsx:2015-2018`), which needs a bubble to live on. Replace with a left accent
  rail: `borderLeft: 3px solid C.accent`. The unselected state reserves the same 3px as
  transparent so selecting a turn does not shift text horizontally. The existing
  `translateY(-3px)` lift stays.
- **Message boundary.** Without bubbles, consecutive assistant turns merge. Raise the
  assistant row's `marginBottom` from 12 to 20 and let the existing `tsLabel` timestamp row
  act as the divider. No rule element — it would collide with Markdown's own `hr`.

### 3. Typography

Add `layout?: 'compact' | 'roomy'` to `MarkdownProps`, defaulting to `compact`. It is
orthogonal to `variant`, which stays responsible for color only. `roomy` overrides:

| | compact (today) | roomy |
|---|---|---|
| fontSize | 13 | 14 |
| lineHeight | 1.55 | 1.7 |
| `p` margin-bottom | 8 | 14 |
| `li` margin-bottom | 2 | 5 |
| `ul` / `ol` margin-bottom | 8 | 14 |
| h1 | 17, margins 8/6 | 20, margins 22/8 |
| h2 | 15, margins 8/6 | 17, margins 20/8 |
| h3 | 14, margins 8/4 | 15, margins 18/6 |
| h4 | 13, margins 6/4 | 14, margins 16/6 |

Asymmetric heading margins are what make sections legible: a heading should sit against the
body text it governs rather than float midway between two blocks.

At 14px × 1.7 the line gap is ~10px, so a 14px paragraph margin reads as a real break. That
resolves cause (2) without touching `preserveLineBreaks` — it exists for a reason and its
semantics are out of scope here.

### 4. Scope

Only the main chat assistant body (`ChatTab.tsx:2038`) passes `layout="roomy"`. The other
twelve `<Markdown variant="assistant">` call sites — team panels, `AutomationOnePager`,
`TeamRunFlow`, `QuickQuestionView` — keep the `compact` default and are not edited, so the
change cannot leak into surfaces nobody asked about.

## Verification

This is presentation-only; there is no pure logic worth a unit test, and none will be
invented to look thorough. Verification is running the app and reading a long reply, in both
light and dark themes.

One open item to confirm during implementation: `ThinkingBlock`, `LiveActivity`, and the
tool-call chips currently sit on `C.aiBg` supplied by the bubble. Once that background is
gone they land directly on the chat backdrop and may each need their own surface. Check
before deciding whether to add one.

## Risks

- Removing the assistant background reduces figure/ground separation against the chat
  backdrop. Mitigated by the width cap and larger inter-message spacing; if it still reads
  flat, the fallback is a very subtle background on the assistant column rather than
  restoring the bubble.
- Nested Markdown inside team/thinking blocks inherits `compact` while the surrounding turn
  is `roomy`, so a size step is visible at that boundary. Accepted: those blocks are
  deliberately secondary content.
