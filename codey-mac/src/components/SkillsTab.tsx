import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import type { SkillEntry, SkillsListResult } from '../codey-api'

type AgentFilter = 'claude-code' | 'opencode' | 'codex'
const AGENTS: { key: AgentFilter; label: string }[] = [
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'opencode',    label: 'OpenCode' },
  { key: 'codex',       label: 'Codex' },
]

const AGENT_SKILL_HINTS: Record<AgentFilter, string> = {
  'claude-code': '~/.claude/skills/',
  'codex': '~/.codex/skills/',
  'opencode': '~/.config/opencode/skills/',
}

export const SkillsTab: React.FC = () => {
  const [data, setData] = useState<SkillsListResult>({ skills: [], projectDir: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addScope, setAddScope] = useState<'user' | 'project'>('user')
  const [addSource, setAddSource] = useState<'localDir' | 'gitUrl'>('localDir')
  const [addInput, setAddInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const [activeAgent, setActiveAgent] = useState<AgentFilter>('claude-code')
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('claude-code')
  const initDone = useRef(false)

  const reload = useCallback(async (agent: AgentFilter) => {
    setLoading(true)
    setError(null)
    try {
      setData(unwrap(await window.codey.skills.list(agent)))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!initDone.current) {
      initDone.current = true
      window.codey.config.get().then(r => {
        if (r.ok) {
          const agent = (r.data as any)?.fallback?.order?.[0]?.agent ?? 'claude-code'
          setActiveAgent(agent)
          setAgentFilter(agent)
        }
      }).catch(() => {})
    }
  }, [])

  useEffect(() => { void reload(agentFilter) }, [agentFilter, reload])

  const handleBrowse = async () => {
    const r = await window.codey.dialog.pickDirectory()
    if (r.ok && r.data) setAddInput(r.data)
  }

  const handleInstall = async () => {
    if (!addInput.trim()) return
    setInstalling(true)
    setError(null)
    try {
      const payload: Parameters<typeof window.codey.skills.install>[0] = { agent: agentFilter, scope: addScope }
      if (addSource === 'localDir') payload.localDir = addInput.trim()
      else payload.gitUrl = addInput.trim()
      unwrap(await window.codey.skills.install(payload))
      setAddInput('')
      setAdding(false)
      await reload(agentFilter)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setInstalling(false)
    }
  }

  const handleRemove = async (skill: SkillEntry) => {
    if (!confirm(`Remove "${skill.name}"? This cannot be undone.`)) return
    setError(null)
    try {
      unwrap(await window.codey.skills.remove(skill.dir))
      await reload(agentFilter)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const handleReveal = (dir: string) => {
    void window.codey.skills.reveal(dir)
  }

  const renderCard = (skill: SkillEntry) => (
    <div key={skill.dir} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: C.fg, fontSize: 13, fontWeight: 600 }}>{skill.name}</span>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
              padding: '2px 6px', borderRadius: 4,
              background: skill.scope === 'user' ? C.accentDim : C.surface3,
              color: skill.scope === 'user' ? C.accent : C.fg3,
            }}>
              {skill.scope === 'user' ? 'User' : 'Project'}
            </span>
          </div>
          {skill.description && (
            <div style={{ color: C.fg3, fontSize: 12, lineHeight: '1.4' }}>{skill.description}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 2 }}>
          <button onClick={() => handleReveal(skill.dir)} style={iconBtn} title="Reveal in Finder">↗</button>
          <button onClick={() => handleRemove(skill)} style={{ ...iconBtn, color: C.red }} title="Remove skill">✕</button>
        </div>
      </div>
      <div style={{ color: C.fg3, fontSize: 11, marginTop: 8, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {skill.dir}
      </div>
    </div>
  )

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto' }}>
      {/* Agent filter bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {AGENTS.map(a => {
          const selected = agentFilter === a.key
          const isActive = activeAgent === a.key
          return (
            <button
              key={a.key}
              onClick={() => setAgentFilter(a.key)}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                border: selected ? `1px solid ${C.accent}` : `1px solid ${C.border2}`,
                cursor: 'pointer',
                background: selected ? C.accentDim : 'transparent',
                color: selected ? C.accent : C.fg3,
                position: 'relative',
              }}
            >
              {a.label}
              {isActive && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>active</span>}
            </button>
          )
        })}
      </div>

      {error && (
        <div style={{ background: C.red + '22', color: C.red, padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Add skill form / button */}
      {adding ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {(['user', 'project'] as const).map(s => (
              <button
                key={s}
                onClick={() => setAddScope(s)}
                style={{ ...pillButton(addScope === s ? 'primary' : 'ghost'), opacity: s === 'project' && !data.projectDir ? 0.4 : 1 }}
                disabled={s === 'project' && !data.projectDir}
                title={s === 'project' && !data.projectDir ? 'No active workspace' : undefined}
              >
                {s === 'user' ? 'User' : 'Project'}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            {(['localDir', 'gitUrl'] as const).map(src => (
              <button
                key={src}
                onClick={() => { setAddSource(src); setAddInput('') }}
                style={pillButton(addSource === src ? 'primary' : 'ghost')}
              >
                {src === 'localDir' ? 'Local Folder' : 'Git URL'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder={addSource === 'localDir' ? '/path/to/skill-folder' : 'https://github.com/user/my-skill'}
              value={addInput}
              onChange={e => setAddInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleInstall() }}
              style={{
                flex: 1, background: 'transparent', border: `1px solid ${C.border2}`,
                borderRadius: 7, color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none',
              }}
              autoFocus
            />
            {addSource === 'localDir' && (
              <button onClick={handleBrowse} style={pillButton('ghost')}>Browse</button>
            )}
            <button onClick={handleInstall} style={pillButton('primary')} disabled={installing || !addInput.trim()}>
              {installing ? 'Installing…' : 'Install'}
            </button>
            <button onClick={() => { setAdding(false); setAddInput(''); setError(null) }} style={pillButton('ghost')}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button onClick={() => setAdding(true)} style={pillButton('primary')}>+ Add Skill</button>
        </div>
      )}

      {loading ? (
        <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>Loading…</div>
      ) : data.skills.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '36px 20px',
          color: C.fg3, fontSize: 13,
        }}>
          <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>✶</div>
          <div style={{ fontWeight: 500, color: C.fg2, marginBottom: 4 }}>No skills installed</div>
          <div style={{ fontSize: 12 }}>
            Skills are loaded from <code style={{ background: C.surface3, padding: '1px 5px', borderRadius: 4 }}>{AGENT_SKILL_HINTS[agentFilter]}</code>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          {data.skills.map(renderCard)}
        </div>
      )}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: '14px 16px',
  transition: 'border-color 0.15s',
}

const iconBtn: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 6,
  border: 'none', cursor: 'pointer',
  background: 'transparent', color: C.fg3,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 13, fontWeight: 600,
}
