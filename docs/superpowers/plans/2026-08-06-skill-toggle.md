# Skill On/Off Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user switch any agent skill off and back on from the Codey Mac app's Skills tab, where "off" means the agent CLI no longer loads it.

**Architecture:** Codey does not load skills — each agent CLI scans its own roots for directories containing `SKILL.md`. Disabling therefore renames `SKILL.md` to `SKILL.md.disabled`; enabling renames it back. The disk is the only state. The scanner learns to recognize both filenames so a disabled skill still shows up in Codey's own list (flagged `enabled: false`), while the chat slash-command palette filters it out.

**Tech Stack:** TypeScript, Electron (main + preload + IPC), React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-skill-toggle-design.md`

**Before you start — Node version.** This repo's default `node` (v16) cannot run Vitest or `tsc`. Use nvm's v22.17.1 in every shell:

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
node -v   # must print v22.17.1
```

All test commands below are run from the `codey-mac/` directory.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `codey-mac/electron/skills.ts` | Pure skill discovery + on-disk mutation helpers. No Electron imports; `fs`/`path` are injected so it is unit-testable. | Modify: add `enabled` to `ScannedSkill`, teach `scanSkillsDir` about `SKILL.md.disabled`, add `setSkillEnabled`. |
| `codey-mac/electron/skills.test.ts` | Vitest suite for the above, using real temp directories. | Modify: update three existing assertions, add five cases. |
| `codey-mac/electron/main.ts` | IPC handlers. | Modify: add `skills:setEnabled`; filter disabled skills out of `agents:slashCommands`. |
| `codey-mac/electron/preload.ts` | Renderer-facing bridge. | Modify: add `skills.setEnabled`. |
| `codey-mac/src/codey-api.d.ts` | Renderer type declarations. | Modify: add `enabled` to `SkillEntry`, declare `skills.setEnabled`. |
| `codey-mac/src/components/SkillsTab.tsx` | Skills tab UI. | Modify: `Toggle` component, card toggle, modal toggle, disabled styling. |

---

## Task 1: Scanner recognizes a disabled skill

**Files:**
- Modify: `codey-mac/electron/skills.ts:6-13` (the `ScannedSkill` interface), `codey-mac/electron/skills.ts:63-109` (`scanSkillsDir`), `codey-mac/electron/skills.ts:111-139` (`scanClaudePluginSkills` — no logic change, but its spread must carry the new field, which it already does)
- Test: `codey-mac/electron/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two cases inside the existing `describe('agent skill discovery', ...)` block in `codey-mac/electron/skills.test.ts`:

```ts
  it('lists a disabled skill and stops descending into it', () => {
    const root = temp()
    const skill = path.join(root, 'noisy')
    fs.mkdirSync(path.join(skill, 'references'), { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md.disabled'), '---\nname: noisy\ndescription: Too chatty\n---\n')
    fs.writeFileSync(path.join(skill, 'references', 'SKILL.md'), '---\nname: wrong\n---\n')

    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      { name: 'noisy', qualifiedName: 'noisy', description: 'Too chatty', scope: 'user', dir: skill, enabled: false },
    ])
  })

  it('prefers the active SKILL.md when a stale disabled copy is left behind', () => {
    const root = temp()
    const skill = path.join(root, 'both')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: both\ndescription: Live\n---\n')
    fs.writeFileSync(path.join(skill, 'SKILL.md.disabled'), '---\nname: both\ndescription: Stale\n---\n')

    expect(scanSkillsDir(fs, path, root, 'user')).toEqual([
      { name: 'both', qualifiedName: 'both', description: 'Live', scope: 'user', dir: skill, enabled: true },
    ])
  })
```

The three existing tests assert whole objects with `toEqual`, so they now need the new field. Make exactly these edits:

- In `'finds nested configured skills and treats a skill as a boundary'`, change the expected object to:
  ```ts
      { name: 'Image Gen', qualifiedName: 'Image Gen', description: 'Makes images', scope: 'user', dir: skill, enabled: true },
  ```
- In `'keeps a nested skill collection prefix in its command name'`, add `enabled: true,` as the last property of the expected object (after `dir: skill,`).
- In `'uses the Claude plugin id as the skill collection namespace'`, add `enabled: true,` as the last property of the expected object (after `dir: skill,`).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd codey-mac && npx vitest run electron/skills.test.ts
```

Expected: FAIL. The two new cases fail because a directory holding only `SKILL.md.disabled` is not recognized as a skill (the disabled case returns `[]`, or returns the nested `references` skill instead). The three edited cases fail on the missing `enabled` property.

- [ ] **Step 3: Write the implementation**

In `codey-mac/electron/skills.ts`, export the filename constant and add the field. Replace the `ScannedSkill` interface (lines 6-13) with:

```ts
/** Renaming SKILL.md to this hides the skill from every agent CLI's scan. */
export const DISABLED_SKILL_FILE = 'SKILL.md.disabled'

export interface ScannedSkill {
  name: string
  qualifiedName: string
  managedBy?: string
  description: string
  scope: SkillScope
  dir: string
  enabled: boolean
}
```

Then, inside `scanSkillsDir`, replace this block:

```ts
    const skillMdPath = pathMod.join(current, 'SKILL.md')
    if (fsMod.existsSync(skillMdPath)) {
      try {
        const md = fsMod.readFileSync(skillMdPath, 'utf-8')
        const { name, description } = parseSkillFrontmatter(md)
        const resolvedName = name || pathMod.basename(current)
        result.push({
          name: resolvedName,
          qualifiedName: qualifySkillName(pathMod, root, current, resolvedName),
          description,
          scope,
          dir: current,
        })
      } catch { /* skip unreadable skill */ }
      continue
    }
```

with:

```ts
    // A disabled skill is still a skill: it marks the boundary so we neither
    // lose it from the list nor walk its internals as if they were roots.
    const activePath = pathMod.join(current, 'SKILL.md')
    const disabledPath = pathMod.join(current, DISABLED_SKILL_FILE)
    const enabled = fsMod.existsSync(activePath)
    const skillMdPath = enabled ? activePath : disabledPath
    if (enabled || fsMod.existsSync(disabledPath)) {
      try {
        const md = fsMod.readFileSync(skillMdPath, 'utf-8')
        const { name, description } = parseSkillFrontmatter(md)
        const resolvedName = name || pathMod.basename(current)
        result.push({
          name: resolvedName,
          qualifiedName: qualifySkillName(pathMod, root, current, resolvedName),
          description,
          scope,
          dir: current,
          enabled,
        })
      } catch { /* skip unreadable skill */ }
      continue
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd codey-mac && npx vitest run electron/skills.test.ts
```

Expected: PASS. (The file has 6 pre-existing tests, so 8 after this task.)

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/skills.ts codey-mac/electron/skills.test.ts
git commit -m "feat(skills): report enabled state when scanning skill dirs"
```

---

## Task 2: `setSkillEnabled` renames SKILL.md

**Files:**
- Modify: `codey-mac/electron/skills.ts` (append after `scanClaudePluginSkills`, before `samePath`)
- Test: `codey-mac/electron/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `codey-mac/electron/skills.test.ts`, after the closing `})` of `describe('agent skill discovery', ...)`:

```ts
describe('setSkillEnabled', () => {
  const makeSkill = (): string => {
    const root = temp()
    const skill = path.join(root, 'one')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: A skill\n---\n')
    return skill
  }

  it('round-trips a skill from enabled to disabled and back', () => {
    const skill = makeSkill()

    setSkillEnabled(fs, path, skill, false)
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(skill, 'SKILL.md.disabled'))).toBe(true)
    expect(scanSkillsDir(fs, path, skill, 'user')[0]?.enabled).toBe(false)

    setSkillEnabled(fs, path, skill, true)
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(skill, 'SKILL.md.disabled'))).toBe(false)
    expect(scanSkillsDir(fs, path, skill, 'user')[0]?.enabled).toBe(true)
  })

  it('preserves the skill body across the rename', () => {
    const skill = makeSkill()
    setSkillEnabled(fs, path, skill, false)
    expect(fs.readFileSync(path.join(skill, 'SKILL.md.disabled'), 'utf-8'))
      .toBe('---\nname: one\ndescription: A skill\n---\n')
  })

  it('is a no-op when the skill is already in the requested state', () => {
    const skill = makeSkill()
    setSkillEnabled(fs, path, skill, true)
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(true)

    setSkillEnabled(fs, path, skill, false)
    setSkillEnabled(fs, path, skill, false)
    expect(fs.existsSync(path.join(skill, 'SKILL.md.disabled'))).toBe(true)
  })

  it('throws when the directory holds no skill file', () => {
    const root = temp()
    expect(() => setSkillEnabled(fs, path, root, false)).toThrow(/SKILL\.md/)
  })
})
```

Extend the import on line 5 of the same file so it reads:

```ts
import { qualifySkillName, resolveUserPath, samePath, scanClaudePluginSkills, scanSkillsDir, setSkillEnabled, uniqueSkills } from './skills'
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd codey-mac && npx vitest run electron/skills.test.ts
```

Expected: FAIL with `setSkillEnabled is not a function` (or a TypeScript "no exported member" error) on all four new cases.

- [ ] **Step 3: Write the implementation**

In `codey-mac/electron/skills.ts`, insert this function immediately before `export function samePath(...)`:

```ts
/**
 * Toggle a skill by renaming its SKILL.md. Agent CLIs only load a directory
 * whose skill file is named exactly SKILL.md, so the rename is what actually
 * disables it — there is no separate state to keep in sync.
 */
export function setSkillEnabled(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  dir: string,
  enabled: boolean,
): void {
  const activePath = pathMod.join(dir, 'SKILL.md')
  const disabledPath = pathMod.join(dir, DISABLED_SKILL_FILE)
  const target = enabled ? activePath : disabledPath
  const source = enabled ? disabledPath : activePath
  if (fsMod.existsSync(target)) return
  if (!fsMod.existsSync(source)) throw new Error(`No SKILL.md found in ${dir}`)
  fsMod.renameSync(source, target)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd codey-mac && npx vitest run electron/skills.test.ts
```

Expected: PASS, with four more tests than Task 1 left behind.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/skills.ts codey-mac/electron/skills.test.ts
git commit -m "feat(skills): add setSkillEnabled disk toggle"
```

---

## Task 3: IPC wiring and slash-command filtering

No unit test here: these are thin Electron IPC bindings with no logic of their own (the logic they call is already covered by Tasks 1-2), and the repo has no harness that boots the Electron main process. The verification step is a type check plus the manual smoke test in Task 5.

**Files:**
- Modify: `codey-mac/electron/main.ts:3298` (slash-command mapping), `codey-mac/electron/main.ts:3412` (add handler above `skills:remove`)
- Modify: `codey-mac/electron/preload.ts:126-132`
- Modify: `codey-mac/src/codey-api.d.ts:14-21`

- [ ] **Step 1: Filter disabled skills out of the slash-command palette**

In `codey-mac/electron/main.ts`, inside the `agents:slashCommands` handler, replace:

```ts
      const skills: SlashCommand[] = skillResult.skills.map(skill => ({
        name: skill.qualifiedName,
        description: skill.description || 'Agent skill',
        source: 'skill',
      }))
```

with:

```ts
      const skills: SlashCommand[] = skillResult.skills
        .filter(skill => skill.enabled)
        .map(skill => ({
          name: skill.qualifiedName,
          description: skill.description || 'Agent skill',
          source: 'skill',
        }))
```

- [ ] **Step 2: Add the IPC handler**

In `codey-mac/electron/main.ts`, add this immediately above the existing `ipcMain.handle('skills:remove', ...)` block:

```ts
  ipcMain.handle('skills:setEnabled', async (_e, dir: string, enabled: boolean) =>
    wrap(async () => {
      if (typeof dir !== 'string' || !dir) throw new Error('Invalid path')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      setSkillEnabled(fsMod, pathMod, dir, enabled)
    })
  )
```

Then extend the import on line 13 so `setSkillEnabled` is in scope:

```ts
import { resolveUserPath, samePath, scanClaudePluginSkills, scanSkillsDir, setSkillEnabled, uniqueSkills } from './skills'
```

- [ ] **Step 3: Expose it on the preload bridge**

In `codey-mac/electron/preload.ts`, inside the `skills:` object, add the new method after `remove`:

```ts
    setEnabled: (dir: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', dir, enabled),
```

- [ ] **Step 4: Update the renderer types**

In `codey-mac/src/codey-api.d.ts`, add `enabled` to `SkillEntry`:

```ts
export interface SkillEntry {
  name: string
  qualifiedName: string
  managedBy?: string
  description: string
  scope: 'user' | 'project'
  dir: string
  enabled: boolean
}
```

Then, in the window API declaration further down the same file, add a line to the `skills:` block (`codey-mac/src/codey-api.d.ts:253-258`) directly after `remove`:

```ts
        setEnabled: (dir: string, enabled: boolean) => Promise<IpcResult<void>>
```

For reference, that block should end up reading:

```ts
      skills: {
        list: (agent?: string) => Promise<IpcResult<SkillsListResult>>
        install: (payload: { agent?: string; scope: 'user' | 'project'; localDir?: string; gitUrl?: string }) => Promise<IpcResult<{ name: string; dir: string }>>
        remove: (dir: string) => Promise<IpcResult<void>>
        setEnabled: (dir: string, enabled: boolean) => Promise<IpcResult<void>>
        reveal: (dir: string) => Promise<IpcResult<void>>
      }
```

- [ ] **Step 5: Type check**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd codey-mac && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. If `tsconfig.json` does not cover `electron/`, run `npx tsc --noEmit -p tsconfig.node.json` as well — check which config files exist with `ls codey-mac/tsconfig*.json` and run every one that exists.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/main.ts codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(skills): expose setEnabled over IPC and hide disabled skills from /"
```

---

## Task 4: Toggle in the Skills tab UI

**Files:**
- Modify: `codey-mac/src/components/SkillsTab.tsx`

- [ ] **Step 1: Add the Toggle component**

`SkillsTab.tsx` has no toggle yet. Copy the idiom already used by `PluginsTab.tsx:9-22` — do not import it from there, since it is a private const in that file and the two tabs are otherwise independent. Add this just below the `AGENT_SKILL_HINTS` const (after line 19):

```tsx
// Matches the toggle idiom already used by PluginsTab / AppearanceTab.
const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <div onClick={() => onChange(!on)} style={{
    width: 32, height: 18, borderRadius: 9, flexShrink: 0,
    background: on ? C.accent : C.surface3,
    border: `1px solid ${on ? C.accent : C.border2}`,
    cursor: 'pointer', position: 'relative', transition: 'all 0.2s',
  }}>
    <div style={{
      position: 'absolute', top: 1, left: on ? 15 : 1,
      width: 14, height: 14, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    }}/>
  </div>
)
```

- [ ] **Step 2: Add the toggle handler**

In the `SkillsTab` component, add a `busyDir` state next to the other `useState` calls (after the `copyMenuOpen` state on line 34):

```tsx
  const [busyDir, setBusyDir] = useState<string | null>(null)
```

Then add this handler immediately after `handleRemove` (after line 121). It updates local state optimistically and rolls back on failure, so the toggle never sits in a state the disk does not agree with:

```tsx
  const handleSetEnabled = async (skill: SkillEntry, enabled: boolean) => {
    if (busyDir) return
    setBusyDir(skill.dir)
    setError(null)
    const apply = (value: boolean) => {
      setData(prev => ({
        ...prev,
        skills: prev.skills.map(s => (s.dir === skill.dir ? { ...s, enabled: value } : s)),
      }))
      setSelected(prev => (prev && prev.dir === skill.dir ? { ...prev, enabled: value } : prev))
    }
    apply(enabled)
    try {
      unwrap(await window.codey.skills.setEnabled(skill.dir, enabled))
    } catch (e: any) {
      apply(!enabled)
      setError(e?.message ?? String(e))
    } finally {
      setBusyDir(null)
    }
  }
```

- [ ] **Step 3: Put the toggle on the card**

In `renderCard`, the card is a `<button>`, so the toggle must swallow its own click or it would also open the detail modal. Replace the card's header row (lines 151-166, the `<div>` containing the name span and the scope badge) with:

```tsx
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, width: '100%' }}>
        <span style={{
          color: C.fg, fontSize: 13, fontWeight: 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1,
        }}>
          {skill.qualifiedName}
        </span>
        <span
          onClick={e => { e.stopPropagation(); void handleSetEnabled(skill, !skill.enabled) }}
          style={{ display: 'inline-flex', opacity: busyDir === skill.dir ? 0.5 : 1 }}
          title={skill.enabled ? 'Disable this skill' : 'Enable this skill'}
        >
          <Toggle on={skill.enabled} onChange={() => {}} />
        </span>
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: 0.3,
          padding: '2px 6px', borderRadius: 4, flexShrink: 0,
          background: skill.scope === 'user' ? C.accentDim : C.surface3,
          color: skill.scope === 'user' ? C.accent : C.fg3,
        }}>
          {skill.managedBy ? 'Plugin' : skill.scope === 'user' ? 'User' : 'Project'}
        </span>
      </div>
```

The wrapping `<span>` owns the click; `Toggle`'s own `onChange` is a no-op here so the action fires exactly once.

- [ ] **Step 4: Dim a disabled card and label it**

Still in `renderCard`, change the opening `<button>` tag's `style` prop so a disabled skill reads as off at a glance:

```tsx
      style={{ ...cardStyle, opacity: skill.enabled ? 1 : 0.55 }}
```

Then, directly below the header row `</div>` and above the `{skill.description && (` block, add the off label:

```tsx
      {!skill.enabled && (
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
          padding: '2px 6px', borderRadius: 4, marginBottom: 2,
          background: C.surface3, color: C.fg3,
        }}>
          Off
        </span>
      )}
```

- [ ] **Step 5: Put the toggle in the detail modal**

In `renderDetail`, replace the modal header row (lines 196-207) with a version carrying its own toggle. No `stopPropagation` is needed here — the modal body already stops propagation on its wrapper:

```tsx
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ color: C.fg, fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{skill.qualifiedName}</span>
          <div style={{ opacity: busyDir === skill.dir ? 0.5 : 1 }} title={skill.enabled ? 'Disable this skill' : 'Enable this skill'}>
            <Toggle on={skill.enabled} onChange={value => void handleSetEnabled(skill, value)} />
          </div>
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            padding: '2px 6px', borderRadius: 4,
            background: skill.scope === 'user' ? C.accentDim : C.surface3,
            color: skill.scope === 'user' ? C.accent : C.fg3,
          }}>
            {skill.managedBy ? 'Plugin' : skill.scope === 'user' ? 'User' : 'Project'}
          </span>
          <button onClick={() => setSelected(null)} style={{ ...iconBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Close" aria-label="Close"><UIIcon name="close" size={14} /></button>
        </div>
```

- [ ] **Step 6: Warn that a plugin update can undo the switch**

Still in `renderDetail`, add this directly above the `Location` block (before the `<div style={{ color: C.fg3, fontSize: 11, marginBottom: 18 }}>` on line 215):

```tsx
        {skill.managedBy && !skill.enabled && (
          <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.5, marginBottom: 14 }}>
            Plugin updates may restore this skill.
          </div>
        )}
```

- [ ] **Step 7: Type check and run the full app test suite**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd codey-mac && npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: no type errors, and the whole `codey-mac` Vitest suite passes.

- [ ] **Step 8: Check for non-English characters**

The repo lints against non-English characters in source. All strings added above are English; run the check to confirm nothing slipped in:

```bash
cd .. && npm run lint
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add codey-mac/src/components/SkillsTab.tsx
git commit -m "feat(skills): add on/off switch to skill cards and detail modal"
```

---

## Task 5: Manual smoke test

The renderer has no component-test harness, and the whole point of the feature is an effect on a different process's view of the filesystem. Verify it by hand.

**Files:** none — this task changes nothing.

- [ ] **Step 1: Launch the app**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd codey-mac && npm run dev
```

- [ ] **Step 2: Disable a skill and confirm the disk changed**

Open the Tools → Skills tab, pick a user-scope skill, and click its card toggle off. The card should dim and show an `Off` badge. Then confirm on disk, substituting the skill's own directory:

```bash
ls ~/.claude/skills/<the-skill>/
```

Expected: `SKILL.md.disabled` is present and `SKILL.md` is gone.

- [ ] **Step 3: Confirm it left the slash-command palette**

Open a chat, type `/`, and search for that skill's name. Expected: it is not listed.

- [ ] **Step 4: Re-enable it from the detail modal**

Click the dimmed card to open its detail modal, toggle it back on, and confirm `SKILL.md` is restored:

```bash
ls ~/.claude/skills/<the-skill>/
```

Expected: `SKILL.md` is back and `SKILL.md.disabled` is gone. The card is no longer dimmed, and the skill reappears in the `/` palette.

- [ ] **Step 5: Check a plugin skill**

Switch the toggle off on a `Plugin`-badged skill (for example one under `superpowers:`). Open its detail modal and confirm the line `Plugin updates may restore this skill.` is shown. Toggle it back on.

- [ ] **Step 6: Confirm the count and search still behave**

The header count must still include disabled skills (disabling never removes a skill from its own tab), and typing the disabled skill's name in the Tools search must still find it.
