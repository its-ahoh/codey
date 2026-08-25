import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { selectStyle, Toggle, unwrap } from './settingsAtoms'
import { OpenInEditorButton } from './OpenInEditorButton'
import { MemoryPanel } from './CodeyMemorySection'
import { formatBytes, memoryPreview, summarizeMemory } from './agentMemoryView'
import { UIIcon } from './UIIcons'
import type { AgentMemoryGroup, MemoryEntry } from '../codey-api'

/**
 * Read-only views of what each agent CLI remembers — the instruction files it
 * loads on its own before any prompt. Memory splits by who it is about:
 *
 *   user     what the agent knows about the user everywhere (~/.claude/CLAUDE.md,
 *            ~/.codex/AGENTS.md, …) — shown in Settings ▸ Memory, under "Your memory".
 *   project  what it knows about one repository (CLAUDE.md, AGENTS.md, Claude
 *            Code's per-project memory and subagent memory) — shown in
 *            Settings ▸ Memory, under "Workspace memory".
 */

const MemoryRow: React.FC<{ entry: MemoryEntry; first: boolean }> = ({ entry, first }) => {
  const [open, setOpen] = useState(false)
  const preview = memoryPreview(entry.content)
  return (
    <div style={{ borderTop: first ? 'none' : `1px solid ${C.border}`, padding: '11px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1,
            background: 'none', border: 'none', color: C.fg, fontSize: 12,
            cursor: 'pointer', padding: 0, textAlign: 'left',
          }}
          title={entry.path}
        >
          <span style={{
            width: 20, height: 20, borderRadius: 5, flexShrink: 0,
            display: 'grid', placeItems: 'center', color: C.fg3, background: C.surface3,
            transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease',
          }}>
            <UIIcon name="disclosure" size={11} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 550 }}>
            {entry.label}
          </span>
        </button>
        <span style={{ color: C.fg3, fontSize: 11, whiteSpace: 'nowrap' }}>{formatBytes(entry.bytes)}</span>
        <OpenInEditorButton path={entry.path} />
      </div>
      {!open && preview && (
        <div style={{
          color: C.fg3, fontSize: 11, lineHeight: 1.45, marginTop: 4, marginLeft: 28,
          marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{preview}</div>
      )}
      {open && (
        <pre style={{
          margin: '9px 0 1px 28px', padding: 12, background: C.surface3,
          border: `1px solid ${C.border}`, borderRadius: 8,
          color: C.fg2, fontSize: 11, lineHeight: 1.55, maxHeight: 280,
          overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}>
          {entry.content}
          {entry.truncated && <span style={{ color: C.fg3 }}>{'\n\n… truncated — open the file to read the rest.'}</span>}
        </pre>
      )}
    </div>
  )
}

/** The selected agent is already identified by the picker, so the file list
 *  intentionally contains no second agent heading. */
const MemoryFileList: React.FC<{ entries: MemoryEntry[]; emptyText: string }> = ({ entries, emptyText }) => (
  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
    {entries.length > 0 ? entries.map((entry, index) => (
      <MemoryRow key={entry.path} entry={entry} first={index === 0} />
    )) : (
      <div style={{ color: C.fg3, fontSize: 12, padding: '18px 14px', textAlign: 'center' }}>{emptyText}</div>
    )}
  </div>
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

/** A read-only card showing one agent's instruction files, chosen by a
 *  dropdown that defaults to the gateway's default agent. */
const AgentMemoryFilesCard: React.FC<{
  description: string
  emptyText: string
  groups: AgentMemoryGroup[]
  loading: boolean
  error: string | null
  reload: () => void
}> = ({ description, emptyText, groups, loading, error, reload }) => {
  const [selected, setSelected] = useState<string>('')

  useEffect(() => {
    if (groups.length === 0) { setSelected(''); return }
    void (async () => {
      let defaultAgent = 'claude-code'
      try {
        const fb = unwrap(await window.codey.fallback.get())
        defaultAgent = fb.order?.[0]?.agent ?? 'claude-code'
      } catch { /* keep fallback */ }
      setSelected(prev => {
        if (groups.some(g => g.agent === prev)) return prev
        return groups.some(g => g.agent === defaultAgent) ? defaultAgent : groups[0].agent
      })
    })()
  }, [groups])

  const selectedGroup = groups.find(g => g.agent === selected)

  return (
    <div style={{ padding: 16, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 12,
      }}>
        <div style={{ minWidth: 220, flex: '1 1 280px' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Agent memory files</div>
          <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.45, marginTop: 3 }}>{description}</div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          width: 376, maxWidth: '100%', marginLeft: 'auto',
        }}>
          {groups.length > 1 && (
            <select
              value={selected}
              onChange={e => setSelected(e.target.value)}
              style={{ ...selectStyle, width: 148, paddingTop: 6, paddingBottom: 6 }}
              title="Choose which agent's memory to view"
              aria-label="Agent"
            >
              {groups.map(g => <option key={g.agent} value={g.agent}>{g.agent}</option>)}
            </select>
          )}
          {selectedGroup && (
            <span style={{
              color: C.fg3, fontSize: 11, lineHeight: 1, whiteSpace: 'nowrap',
              width: 112, boxSizing: 'border-box', textAlign: 'center',
              padding: '6px 8px', background: C.surface3, borderRadius: 6,
            }}>
              {summarizeMemory(selectedGroup.entries)}
            </span>
          )}
          <button
            onClick={() => void reload()}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 9px', fontSize: 12,
              background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`,
              borderRadius: 7, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.65 : 1,
            }}
          >
            <UIIcon name="refresh" size={13} />
            {loading ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {!loading && groups.length === 0 && !error && (
        <MemoryFileList entries={[]} emptyText={emptyText} />
      )}
      {selectedGroup && <MemoryFileList entries={selectedGroup.entries} emptyText={emptyText} />}
    </div>
  )
}

/** Your memory: the global instruction file each agent loads in every project. */
export const UserMemorySection: React.FC = () => {
  const load = useCallback(async () => unwrap(await window.codey.memory.user()).agents, [])
  const { groups, loading, error, reload } = useMemory(load, true)

  return (
    <AgentMemoryFilesCard
      description="The global instruction file each agent loads in every project. Read-only."
      emptyText="No agent memory files yet."
      groups={groups}
      loading={loading}
      error={error}
      reload={reload}
    />
  )
}

/** Workspace memory: the instruction files each agent reads from one project. */
export const ProjectMemorySection: React.FC<{ workspace: string }> = ({ workspace }) => {
  const load = useCallback(async () => unwrap(await window.codey.memory.project(workspace)).agents, [workspace])
  const { groups, loading, error, reload } = useMemory(load, true)

  return (
    <AgentMemoryFilesCard
      description="Instruction files the agents read from this project. Read-only."
      emptyText="No agent memory in this project yet."
      groups={groups}
      loading={loading}
      error={error}
      reload={reload}
    />
  )
}

/**
 * Your global memory: the one knowledge base about the user.
 *
 * The entries live in Codey's user-global memory store — the same ones it
 * injects into its own prompts. Turning sharing on also renders them into
 * each agent's own global memory file, inside a marked block, so the CLIs
 * know them when run outside Codey too. One place to type, two ways to
 * deliver; Codey drops its own injection while sharing is on so no fact
 * reaches the model twice.
 */
export const GlobalMemoryPanel: React.FC = () => {
  const [enabled, setEnabled] = useState(false)
  const [targets, setTargets] = useState<Array<{ agent: string; path: string }>>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const res = unwrap(await window.codey.memory.shared.get())
      setEnabled(res.enabled)
      setTargets(res.targets)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = async (next: boolean) => {
    setEnabled(next)
    setError(null)
    try { unwrap(await window.codey.memory.shared.setEnabled(next)) }
    catch (e: any) { setEnabled(!next); setError(e?.message ?? String(e)) }
  }

  return (
    <>
      {error && <ErrorBox message={error} />}
      <MemoryPanel
        scope="global"
        description="Standing facts and preferences about you, used in every project."
        banner={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: `1px solid ${C.border}` }}>
            <div>
              <div style={{ color: C.fg, fontSize: 13 }}>Share with every agent</div>
              <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>
                {enabled
                  ? `Written into ${targets.length} agent memory file${targets.length === 1 ? '' : 's'} below, inside a Codey-managed block.`
                  : 'Off — only Codey itself uses these memories. The block is removed from the agent files below.'}
              </div>
            </div>
            <Toggle on={enabled} onChange={v => void toggle(v)} label="Share memory with every agent" />
          </div>
        }
      />
    </>
  )
}
