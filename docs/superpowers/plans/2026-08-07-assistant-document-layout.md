# Assistant Document Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant messages in the Mac app's chat tab as document flow instead of chat bubbles, so long replies stop reading as a dense wall.

**Architecture:** Two changes. `Markdown.tsx` gains a `layout` prop selecting between two typographic metric sets (`compact`, today's values, stays the default so no other surface moves; `roomy`, looser, for the main assistant turn). `ChatTab.tsx` splits its message container on `isUser`: user messages keep the bubble untouched, assistant messages lose background/border/shadow/radius, gain a `ch`-based width cap, and replace the bubble's selected-state border with a left accent rail.

**Tech Stack:** React 18 + TypeScript, inline styles, `react-markdown` + `remark-gfm`, Vite, Vitest, Electron.

**Spec:** `docs/superpowers/specs/2026-08-07-assistant-document-layout-design.md`

**Node version:** this repo needs nvm's v22.17.1. Run `nvm use 22.17.1` before any npm command; the system default v16 cannot run vitest or tsc here.

---

## A note on tests

This change is presentation-only. There is no branching logic, no data transformation, and no
new pure function — the entire diff is style objects and one prop. A unit test here would
assert that a constant equals itself, which is worse than no test because it implies coverage
that does not exist. So this plan uses TDD's verification discipline without fabricating unit
tests: every task ends with a typecheck and the existing suite, and Task 6 is a real visual
verification against both themes that must be performed, not assumed.

Do not add tests asserting the contents of `METRICS`.

## File Structure

- **Modify** `codey-mac/src/components/Markdown.tsx` — add the `layout` prop and the `METRICS`
  table; replace hardcoded typographic values with lookups. Responsibility unchanged: render a
  Markdown string with app theming.
- **Modify** `codey-mac/src/components/ChatTab.tsx:1971-1994` — split the message container on
  `isUser`; pass `layout="roomy"` at the assistant body call site (currently line 2012).
- **Modify** `codey-mac/src/App.tsx:365` — add one CSS rule to the existing global `<style>`
  block, zeroing the top margin of a turn's first block.

No new files. `ChatTab.tsx` is 3265 lines and doing too much, but splitting it is unrelated to
this goal and out of scope.

---

### Task 1: Two typographic densities in Markdown

**Files:**
- Modify: `codey-mac/src/components/Markdown.tsx:6-9` (props), `:160-201` (metrics use)

- [ ] **Step 1: Add the `layout` prop**

Replace lines 6-9:

```tsx
interface MarkdownProps {
  children: string
  variant?: 'user' | 'assistant'
  layout?: 'compact' | 'roomy'
}
```

- [ ] **Step 2: Add the METRICS table**

Insert directly below the `interface MarkdownProps` block, above the `MONO` constant on line 11:

```tsx
/** Two typographic densities. `compact` is the historical chat metric and stays
 *  the default, so every secondary surface (team panels, automation, quick
 *  question) is untouched. `roomy` is for the main assistant turn, which renders
 *  as a document rather than a bubble: at 13px/1.55 a paragraph's bottom margin
 *  (8px) was barely larger than the gap between its own lines (~7px), so the
 *  paragraph stopped reading as a unit. Heading margins are deliberately
 *  asymmetric — a heading belongs to the text below it, not midway between two
 *  blocks. */
const METRICS = {
  compact: {
    fontSize: 13,
    lineHeight: 1.55,
    block: 8,
    li: 2,
    hr: '10px 0',
    h1: { fontSize: 17, margin: '8px 0 6px' },
    h2: { fontSize: 15, margin: '8px 0 6px' },
    h3: { fontSize: 14, margin: '8px 0 4px' },
    h4: { fontSize: 13, margin: '6px 0 4px' },
  },
  roomy: {
    // 1.7 rather than 1.55: Chinese has a high character-face ratio and no
    // ascenders or descenders, so identical leading reads tighter than it does
    // for Latin text.
    fontSize: 14,
    lineHeight: 1.7,
    block: 14,
    li: 5,
    hr: '18px 0',
    h1: { fontSize: 20, margin: '22px 0 8px' },
    h2: { fontSize: 17, margin: '20px 0 8px' },
    h3: { fontSize: 15, margin: '18px 0 6px' },
    h4: { fontSize: 14, margin: '16px 0 6px' },
  },
} as const
```

- [ ] **Step 3: Read the metrics in the component**

Change the signature on line 160 from:

```tsx
const MarkdownInner: React.FC<MarkdownProps> = ({ children, variant = 'assistant' }) => {
  const onUser = variant === 'user'
```

to:

```tsx
const MarkdownInner: React.FC<MarkdownProps> = ({ children, variant = 'assistant', layout = 'compact' }) => {
  const onUser = variant === 'user'
  const M = METRICS[layout]
```

- [ ] **Step 4: Apply the metrics to the wrapper and block elements**

Change the wrapper `div` on line 174 from:

```tsx
    <div style={{ minWidth: 0, maxWidth: '100%', fontSize: 13, lineHeight: 1.55, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
```

to (the `className` is consumed by the CSS rule added in Task 2):

```tsx
    <div
      className={layout === 'roomy' ? 'md-roomy' : undefined}
      style={{ minWidth: 0, maxWidth: '100%', fontSize: M.fontSize, lineHeight: M.lineHeight, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
```

Then replace these six component overrides. Line 178:

```tsx
          p: ({ children }) => <p style={{ margin: `0 0 ${M.block}px 0` }}>{children}</p>,
```

Lines 194-197:

```tsx
          h1: ({ children }) => <h1 style={{ fontSize: M.h1.fontSize, fontWeight: 700, margin: M.h1.margin }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: M.h2.fontSize, fontWeight: 700, margin: M.h2.margin }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: M.h3.fontSize, fontWeight: 700, margin: M.h3.margin }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: M.h4.fontSize, fontWeight: 700, margin: M.h4.margin }}>{children}</h4>,
```

Lines 198-201:

```tsx
          ul: ({ children }) => <ul style={{ margin: `0 0 ${M.block}px 0`, paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: `0 0 ${M.block}px 0`, paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: M.li }}>{children}</li>,
          hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${ruleColor}`, margin: M.hr }} />,
```

Lines 202-213, the `blockquote` margin only — leave `borderLeft`, `paddingLeft`, and `color` as they are:

```tsx
                margin: `0 0 ${M.block}px 0`,
```

Leave `preserveLineBreaks` on line 292 alone. It exists because LLM output relies on single
newlines; changing its semantics is out of scope. At 14px × 1.7 the line gap is ~10px, so a
14px paragraph margin now reads as a real break even with hard breaks present.

- [ ] **Step 5: Typecheck**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: exits 0, no output.

If `tsc` reports that `M.h1.margin` is not assignable to `margin`, the `as const` on `METRICS`
made it a string literal type — that is compatible with `React.CSSProperties['margin']` and the
real error is elsewhere. Read the message rather than deleting `as const`.

- [ ] **Step 6: Run the existing suite**

Run: `cd codey-mac && npm test`
Expected: PASS. Nothing tests `Markdown.tsx`; this confirms no unrelated breakage.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/Markdown.tsx
git commit -m "feat(mac): add roomy typographic density to Markdown"
```

---

### Task 2: Zero the top margin of a turn's first block

**Files:**
- Modify: `codey-mac/src/App.tsx:390` (inside the existing global `<style>` block)

Roomy headings carry a 16-22px top margin to open a section. When a reply *starts* with a
heading — which is common — that margin adds dead space above the first line, because there is
nothing above it to separate from. Inline styles cannot express `:first-child`, so this needs a
real CSS rule.

- [ ] **Step 1: Add the rule**

In `App.tsx`, immediately after the line:

```
  html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
```

add:

```
  /* Roomy headings open a section with a large top margin. The first block in a
     turn has nothing above it to separate from, so that margin is dead space. */
  .md-roomy > :first-child { margin-top: 0 !important; }
```

`!important` is required: the margin it overrides is an inline style, which otherwise wins.

- [ ] **Step 2: Typecheck**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/App.tsx
git commit -m "style(mac): collapse leading heading margin in roomy markdown"
```

---

### Task 3: Assistant messages render as document flow

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx:1971-1994`

- [ ] **Step 1: Widen the gap between assistant turns**

Without bubbles, consecutive assistant turns merge into each other. Spacing is what separates
them now. In the outer row style at line 1971-1979, change:

```tsx
                marginBottom: 12,
```

to:

```tsx
                marginBottom: isUser ? 12 : 20,
```

Leave everything else in that style object — including `transform` and `paddingLeft` — as is.

- [ ] **Step 2: Split the container style on `isUser`**

Replace the whole inner `div` opening tag at lines 1981-1994 (it starts with the line
`minWidth: 0, maxWidth: '72%', padding: '10px 14px',`):

```tsx
              <div style={isUser ? {
                minWidth: 0, maxWidth: '72%', padding: '10px 14px',
                borderRadius: '16px 16px 4px 16px',
                background: C.userBg,
                color: C.onAccent, fontSize: 13, lineHeight: 1.55,
                overflowWrap: 'anywhere', wordBreak: 'break-word',
              } : {
                // No bubble: the bubble marks "what the user said", and an
                // assistant reply of any length reads better as a document.
                // `ch` resolves against this element's 13px font, so 78ch is
                // ~562px — about 72 characters of the 14px roomy body text, or
                // ~43 Chinese characters. Unlike the old 72%, it does not grow
                // with the window.
                minWidth: 0, width: '100%', maxWidth: 'min(100%, 78ch)',
                // The rail is always 3px, transparent when unselected, so
                // selecting a turn never shifts the text column sideways.
                // 6 (row) + 3 (rail) + 12 = 21px, exactly today's inset of
                // 6 (row) + 1 (border) + 14 (bubble padding).
                padding: '0 0 0 12px',
                borderLeft: `3px solid ${isSelected ? C.accent : 'transparent'}`,
                background: isSelected ? C.accentDim : 'transparent',
                // fontSize/lineHeight stay at the compact values: non-Markdown
                // children (LiveActivity, tool chips) inherit them. The roomy
                // metrics apply inside <Markdown layout="roomy"> only.
                color: C.fg, fontSize: 13, lineHeight: 1.55,
                overflowWrap: 'anywhere', wordBreak: 'break-word',
                transition: 'border-color 0.18s ease, background 0.18s ease',
              }}>
```

Three things are deliberately gone from the assistant branch: `boxShadow` (it needed a surface
to cast from), `border` (replaced by the rail), and `borderRadius` (nothing to round). The
user branch is byte-for-byte equivalent to what the ternaries produced before — verify that in
review by reading the old and new user styles side by side.

- [ ] **Step 3: Typecheck**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 4: Run the existing suite**

Run: `cd codey-mac && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): render assistant messages as document flow"
```

---

### Task 4: Use the roomy metrics for the assistant body

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx:2012`

- [ ] **Step 1: Pass the prop**

Change line 2012 from:

```tsx
                      <Markdown variant="assistant">{text}</Markdown>
```

to:

```tsx
                      <Markdown variant="assistant" layout="roomy">{text}</Markdown>
```

This is the only call site that changes. The other twelve `<Markdown variant="assistant">` uses
— `AutomationOnePager.tsx:288,418`, `TeamRunFlow.tsx:99`, `ChatTab.tsx:307,325,341,345,409,697,707`,
`AutomationChatCreate.tsx:283`, `QuickQuestionView.tsx:168` — keep the `compact` default and must
not be edited. Confirm with:

Run: `cd codey-mac/src && grep -rn 'layout="roomy"' components/`
Expected: exactly one line, `components/ChatTab.tsx`.

- [ ] **Step 2: Typecheck**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): use roomy typography for assistant replies"
```

---

### Task 5: Re-seat the blocks that were sitting on the bubble background

**Files:**
- Inspect: `codey-mac/src/components/ChatTab.tsx` — `LiveActivity`, `ThinkingBlock`, `TeamMessage`, tool-call chips
- Modify: only those that turn out to need it

`C.aiBg` was the assistant bubble's background and is now gone from that container. In the
light theme `aiBg` is `#ffffff` against a `bg` of `#f6f7fb`, so anything that relied on sitting
on white now sits on light grey; in dark, `#1b2030` becomes `#10131b`. Sub-blocks that set
their own surface are fine. Ones that assumed the bubble's are not.

This task is an inspection with a conditional fix, not a predetermined edit. Do not guess.

- [ ] **Step 1: Find the sub-blocks' own backgrounds**

Run: `cd codey-mac/src && grep -n 'background' components/ChatTab.tsx | grep -iE 'thinking|activity|toolchip|toolCall|teamRun|teamGroup'`
Expected: a list of style entries. Any entry already setting `background` to a theme surface is fine.

- [ ] **Step 2: Launch the app and look**

Run: `cd codey-mac && nvm use 22.17.1 && npm run dev`

Send a prompt that produces thinking, several tool calls, and a long reply. Check whether the
thinking block, live activity row, and tool chips still read as distinct elements now that the
backdrop behind them changed.

- [ ] **Step 3: Fix only what actually reads wrong**

For any block that now blends into the backdrop, give it `background: C.surface` (dark) /
`C.surface` (light) — the theme's card surface — plus its existing border if it has one. Do not
restore `C.aiBg` on the message container; that reinstates the bubble.

If everything reads fine, change nothing and record that in the commit message.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "style(mac): re-seat assistant sub-blocks after bubble removal"
```

If no change was needed, skip the commit entirely and note it when reporting the task.

---

### Task 6: Visual verification

**Files:** none — this task changes nothing.

The spec's whole justification is readability, which no assertion in this repo can check. This
step is the verification. Do not mark the plan complete without performing it.

- [ ] **Step 1: Run the app**

Run: `cd codey-mac && nvm use 22.17.1 && npm run dev`

- [ ] **Step 2: Check a long reply in the dark theme**

Ask for something that produces 800+ words with headings, a bulleted list, a fenced code block,
and a table. Confirm:
  - Line length stops growing when the window widens past ~600px of text column.
  - Paragraph breaks are visibly larger than line breaks.
  - Headings group with the text below them, not floating between blocks.
  - The code block and table are wider than before, not clipped.

- [ ] **Step 3: Check the light theme**

Switch themes. Confirm assistant text on `#f6f7fb` still has adequate contrast, and that the
loss of the white bubble does not make the column feel unanchored.

- [ ] **Step 4: Check selection and boundaries**

Double-click an assistant turn to select it. Confirm the accent rail appears and the text does
**not** jump sideways. Then confirm two consecutive assistant turns read as separate messages.

- [ ] **Step 5: Check a short reply**

Send something answered in one line. Confirm it does not look stranded without its bubble — this
is the case option C trades away, and it is the one most likely to need a follow-up adjustment.

- [ ] **Step 6: Check the untouched surfaces**

Open a team run panel and the quick-question view. Confirm their text is unchanged in size and
spacing — that is what the `compact` default protects.

- [ ] **Step 7: Report**

Report which of steps 2-6 passed and which did not, with what you saw. If step 3 or step 5 reads
poorly, the spec's stated fallback is a very subtle background on the assistant column — not
restoring the bubble. Raise it rather than applying it unilaterally.

---

## Rollback

Every task is a separate commit touching one file. If the result reads worse than the bubble
did, `git revert` the Task 3 and Task 4 commits to restore bubbles while keeping the `roomy`
metrics available for later use.
