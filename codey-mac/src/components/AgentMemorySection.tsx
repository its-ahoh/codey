import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { Section, Toggle, fieldStyle, pillButton, unwrap } from './settingsAtoms'
import { formatBytes, memoryPreview, summarizeMemory } from './agentMemoryView'
import type { AgentMemoryGroup, MemoryEntry } from '../codey-api'

/**
 * Read-only views of what each agent CLI remembers — the instruction files it
 * loads on its own before any prompt. Memory splits by who it is about:
 *
 *   user     what the agent knows about the user everywhere (~/.claude/CLAUDE.md,
 *            ~/.codex/AGENTS.md, …) — shown in Settings ▸ Agents.
 *   project  what it knows about one repository (CLAUDE.md, AGENTS.md, Claude
 *            Code's per-project memory and subagent memory) — shown on the
 *            workspace that owns that repository.
 */

const MemoryRow: React.FC<{ entry: MemoryEntry }> = ({ entry }) => {
  const [open, setOpen] = useState(false)
  const preview = memoryPreview(entry.content)
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{ background: 'none', border: 'none', color: C.fg, fontSize: 12, cursor: 'pointer', padding: 0, textAlign: 'left', flex: 1 }}
          title={entry.path}
        >
          <span style={{ color: C.fg3, marginRight: 6 }}>{open ? '▾' : '▸'}</span>
          {entry.label}
        </button>
        <span style={{ color: C.fg3, fontSize: 11 }}>{formatBytes(entry.bytes)}</span>
        <button
          onClick={() => void window.codey.skills.reveal(entry.path)}
          style={{ ...pillButton('ghost'), padding: '3px 8px', fontSize: 11 }}
          title="Show this file in Finder"
        >Reveal</button>
      </div>
      {!open && preview && (
        <div style={{ color: C.fg3, fontSize: 11, marginTop: 3, marginLeft: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</div>
      )}
      {open && (
        <pre style={{
          margin: '6px 0 0 16px', padding: 10, background: C.surface3, borderRadius: 8,
          color: C.fg2, fontSize: 11, lineHeight: 1.5, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap',
        }}>
          {entry.content}
          {entry.truncated && <span style={{ color: C.fg3 }}>{'\n\n… truncated — open the file to read the rest.'}</span>}
        </pre>
      )}
    </div>
  )
}

/** One card per agent, with its files below. Agents with nothing are still
 *  listed so the absence of memory is visible rather than ambiguous. */
const MemoryGroups: React.FC<{ groups: AgentMemoryGroup[] }> = ({ groups }) => (
  <>
    {groups.map(({ agent, entries }) => (
      <div key={agent} style={{ ...fieldStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ color: C.fg, fontSize: 13 }}>{agent}</span>
          <span style={{ color: C.fg3, fontSize: 11 }}>{summarizeMemory(entries)}</span>
        </div>
        {entries.map(entry => <MemoryRow key={entry.path} entry={entry} />)}
      </div>
    ))}
  </>
)

function useMemory(load: () => Promise<AgentMemoryGroup[]>, enabled: boolean) {
  const [groups, setGroups] = useState<AgentMemoryGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setGroups(await load()) }
    catch (e: any) { setError(e?.message ?? String(e)) }
    finally { setLoading(false) }
  }, [load])

  useEffect(() => {
    if (!enabled) return
    void reload()
  }, [enabled, reload])

  return { groups, loading, error, reload }
}

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>{message}</div>
)

/** Settings ▸ Agents: what each agent knows about the user, in every project. */
export const UserMemorySection: React.FC<{ isGatewayRunning: boolean }> = ({ isGatewayRunning }) => {
  const load = useCallback(async () => unwrap(await window.codey.memory.user()).agents, [])
  const { groups, loading, error, reload } = useMemory(load, isGatewayRunning)

  return (
    <>
      <Section
        title="Memory"
        description="What each agent has been told about you — the global instruction file it loads in every project. Project memory lives on the workspace."
        right={
          <button onClick={() => void reload()} style={pillButton('ghost')} disabled={loading} title="Re-read the memory files from disk">
            {loading ? 'Reading…' : '↻ Refresh'}
          </button>
        }
      />
      {error && <ErrorBox message={error} />}
      <MemoryGroups groups={groups} />
    </>
  )
}

/** Workspaces tab: what each agent knows about this workspace's repository. */
export const ProjectMemorySection: React.FC<{ workspace: string }> = ({ workspace }) => {
  const load = useCallback(async () => unwrap(await window.codey.memory.project(workspace)).agents, [workspace])
  const { groups, loading, error, reload } = useMemory(load, true)
  const withFiles = groups.filter(g => g.entries.length > 0)

  return (
    <div style={{ padding: 16, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Agent memory</div>
          <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>
            Instruction files the agents read from this project. Read-only.
          </div>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          style={{ padding: '4px 10px', fontSize: 12, background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, cursor: 'pointer' }}
        >{loading ? 'Reading…' : '↻ Refresh'}</button>
      </div>
      {error && <ErrorBox message={error} />}
      {!loading && withFiles.length === 0 && !error && (
        <div style={{ fontSize: 12, color: C.fg3 }}>No agent memory in this project yet.</div>
      )}
      <MemoryGroups groups={withFiles} />
    </div>
  )
}

/**
 * Settings ▸ Agents: one knowledge base every agent reads. Codey keeps the
 * text and mirrors it into each agent's own global memory file inside a marked
 * block, so all four CLIs see the same thing. Off until the user opts in —
 * syncing writes into files the user owns.
 */
export const SharedMemorySection: React.FC<{ isGatewayRunning: boolean }> = ({ isGatewayRunning }) => {
  const [enabled, setEnabled] = useState(false)
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [filePath, setFilePath] = useState('')
  const [targets, setTargets] = useState<Array<{ agent: string; path: string }>>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const res = unwrap(await window.codey.memory.shared.get())
      setEnabled(res.enabled)
      setContent(res.content)
      setDraft(res.content)
      setFilePath(res.path)
      setTargets(res.targets)
      setLoaded(true)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => {
    if (!isGatewayRunning) return
    void reload()
  }, [isGatewayRunning, reload])

  const toggle = async (next: boolean) => {
    setEnabled(next)
    setError(null)
    try { unwrap(await window.codey.memory.shared.setEnabled(next)) }
    catch (e: any) { setEnabled(!next); setError(e?.message ?? String(e)) }
  }

  const save = async () => {
    if (saving || draft === content) return
    setSaving(true)
    setError(null)
    try {
      unwrap(await window.codey.memory.shared.set(draft))
      setContent(draft)
      setSavedAt(Date.now())
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setSaving(false) }
  }

  return (
    <>
      <Section
        title="Shared memory"
        description="One knowledge base for every agent. Codey mirrors it into each agent's own memory file, inside a marked block — anything you wrote around that block is left alone."
      />
      {error && <ErrorBox message={error} />}
      <div style={{ ...fieldStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ color: C.fg, fontSize: 13 }}>Share this knowledge with every agent</div>
            <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>
              {enabled
                ? `Synced into ${targets.length} agent file${targets.length === 1 ? '' : 's'} on every launch and every save.`
                : 'Off — the block is removed from the agent files while this is off.'}
            </div>
          </div>
          <Toggle on={enabled} onChange={v => void toggle(v)} label="Share memory with every agent" />
        </div>

        <div style={{ marginTop: 12 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            disabled={!loaded}
            placeholder="What should every agent know? e.g. how you like commits written, which node version this machine needs."
            style={{
              width: '100%', minHeight: 160, resize: 'vertical', boxSizing: 'border-box',
              background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 8,
              padding: 10, fontSize: 12, outline: 'none',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <code style={{ color: C.fg3, fontSize: 11 }}>{filePath}</code>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {savedAt > 0 && Date.now() - savedAt < 4000 && <span style={{ fontSize: 11, color: C.green }}>✓ Saved and synced</span>}
              <button
                onClick={() => void save()}
                disabled={saving || draft === content || !loaded}
                style={{ ...pillButton('primary'), opacity: (saving || draft === content) ? 0.5 : 1 }}
              >{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
