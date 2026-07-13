import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
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

export const SkillsTab: React.FC<{ addRequest?: number }> = ({ addRequest = 0 }) => {
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
  const [selected, setSelected] = useState<SkillEntry | null>(null)
  const [copyState, setCopyState] = useState<{ label: string; status: 'copying' | 'done' | 'error'; msg?: string } | null>(null)
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const copyRef = useRef<HTMLDivElement>(null)
  const initDone = useRef(false)

  // The primary action lives in the parent Tools tab bar; this counter gives
  // that button a clean way to open the existing install form without a second
  // competing "Add Skill" control in the content area.
  useEffect(() => {
    if (addRequest > 0) {
      setAdding(true)
      setAddInput('')
    }
  }, [addRequest])

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

  useEffect(() => {
    if (!copyMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (copyRef.current && !copyRef.current.contains(e.target as Node)) setCopyMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [copyMenuOpen])

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

  const handleCopyTo = async (skill: SkillEntry, targets: AgentFilter[], label: string) => {
    setCopyMenuOpen(false)
    setCopyState({ label, status: 'copying' })
    const failures: string[] = []
    for (const target of targets) {
      try {
        unwrap(await window.codey.skills.install({ agent: target, scope: 'user', localDir: skill.dir }))
      } catch (e: any) {
        const tgt = AGENTS.find(a => a.key === target)?.label ?? target
        failures.push(`${tgt}: ${e?.message ?? String(e)}`)
      }
    }
    if (targets.includes(agentFilter)) await reload(agentFilter)
    if (failures.length) setCopyState({ label, status: 'error', msg: failures.join('  •  ') })
    else setCopyState({ label, status: 'done' })
  }

  const renderCard = (skill: SkillEntry) => (
    <button
      key={skill.dir}
      onClick={() => { setSelected(skill); setCopyState(null); setCopyMenuOpen(false) }}
      style={cardStyle}
      title={skill.description || skill.name}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, width: '100%' }}>
        <span style={{
          color: C.fg, fontSize: 13, fontWeight: 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1,
        }}>
          {skill.name}
        </span>
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: 0.3,
          padding: '2px 6px', borderRadius: 4, flexShrink: 0,
          background: skill.scope === 'user' ? C.accentDim : C.surface3,
          color: skill.scope === 'user' ? C.accent : C.fg3,
        }}>
          {skill.scope === 'user' ? 'User' : 'Project'}
        </span>
      </div>
      {skill.description && (
        <div style={{
          color: C.fg3, fontSize: 12, lineHeight: '1.5', width: '100%',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {skill.description}
        </div>
      )}
    </button>
  )

  const renderDetail = (skill: SkillEntry) => (
    <div
      onClick={() => setSelected(null)}
      style={{
        position: 'absolute', inset: 0, zIndex: 10,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
          padding: 20, width: '100%', maxWidth: 440, maxHeight: '100%', overflowY: 'auto',
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ color: C.fg, fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{skill.name}</span>
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            padding: '2px 6px', borderRadius: 4,
            background: skill.scope === 'user' ? C.accentDim : C.surface3,
            color: skill.scope === 'user' ? C.accent : C.fg3,
          }}>
            {skill.scope === 'user' ? 'User' : 'Project'}
          </span>
          <button onClick={() => setSelected(null)} style={{ ...iconBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Close" aria-label="Close"><UIIcon name="trash" size={14} /></button>
        </div>

        {skill.description && (
          <div style={{ color: C.fg2, fontSize: 13, lineHeight: '1.55', marginBottom: 16, whiteSpace: 'pre-wrap' }}>
            {skill.description}
          </div>
        )}

        <div style={{ color: C.fg3, fontSize: 11, marginBottom: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 2, opacity: 0.7 }}>Location</div>
          <div style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>{skill.dir}</div>
        </div>

        {copyState && (
          <div style={{
            fontSize: 11, marginBottom: 12,
            color: copyState.status === 'error' ? C.red : copyState.status === 'done' ? C.accent : C.fg3,
          }}>
            {copyState.status === 'copying' && `Copying to ${copyState.label}…`}
            {copyState.status === 'done' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><UIIcon name="check" size={14} />Copied to {copyState.label}</span>}
            {copyState.status === 'error' && copyState.msg}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div ref={copyRef} style={{ position: 'relative', display: 'flex' }}>
            <button
              onClick={() => handleCopyTo(skill, AGENTS.filter(a => a.key !== agentFilter).map(a => a.key), 'all agents')}
              disabled={copyState?.status === 'copying'}
              style={{ ...pillButton('primary'), borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            >
              Copy to all
            </button>
            <button
              onClick={() => setCopyMenuOpen(o => !o)}
              disabled={copyState?.status === 'copying'}
              title="Copy to a specific agent"
              style={{
                ...pillButton('primary'),
                borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                borderLeft: '1px solid rgba(0,0,0,0.25)',
                paddingLeft: 8, paddingRight: 8,
              }}
            >
              ▾
            </button>
            {copyMenuOpen && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 1,
                background: C.surface2 ?? C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
                padding: 4, minWidth: 180, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              }}>
                <div style={{ color: C.fg3, fontSize: 10, fontWeight: 600, opacity: 0.7, padding: '4px 10px 2px' }}>
                  COPY TO
                </div>
                {AGENTS.filter(a => a.key !== agentFilter).map(a => (
                  <button key={a.key} onClick={() => handleCopyTo(skill, [a.key], a.label)} style={menuItem}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={() => handleReveal(skill.dir)} style={{ ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6 }}><UIIcon name="folder" size={14} />Reveal in Finder</button>
          <button
            onClick={() => { const s = skill; setSelected(null); void handleRemove(s) }}
            style={{ ...pillButton('ghost'), color: C.red }}
          ><UIIcon name="trash" size={14} />Remove</button>
        </div>
      </div>
    </div>
  )

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflowY: 'auto', position: 'relative' }}>
      {selected && renderDetail(selected)}
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
      ) : null}

      {loading ? (
        <div style={{ color: C.fg3, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>Loading…</div>
      ) : data.skills.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '36px 20px',
          color: C.fg3, fontSize: 13,
        }}>
          <div style={{ width: 52, height: 52, margin: '0 auto 12px', borderRadius: 16, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent }}><UIIcon name="sparkle" size={24} /></div>
          <div style={{ fontWeight: 500, color: C.fg2, marginBottom: 4 }}>No skills installed</div>
          <div style={{ fontSize: 12 }}>
            Skills are loaded from <code style={{ background: C.surface3, padding: '1px 5px', borderRadius: 4 }}>{AGENT_SKILL_HINTS[agentFilter]}</code>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
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
  padding: '18px 18px',
  minHeight: 128,
  transition: 'border-color 0.15s',
  cursor: 'pointer',
  textAlign: 'left',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  font: 'inherit',
}

const menuItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '7px 10px', borderRadius: 6, border: 'none',
  background: 'transparent', color: C.fg, fontSize: 12, cursor: 'pointer',
}

const iconBtn: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 6,
  border: 'none', cursor: 'pointer',
  background: 'transparent', color: C.fg3,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 13, fontWeight: 600,
}
