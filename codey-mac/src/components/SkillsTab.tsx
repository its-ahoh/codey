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
          {skill.qualifiedName}
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
          <span style={{ color: C.fg, fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{skill.qualifiedName}</span>
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
          {!skill.managedBy && (
            <button
              onClick={() => { const s = skill; setSelected(null); void handleRemove(s) }}
              style={{ ...pillButton('ghost'), color: C.red }}
            ><UIIcon name="trash" size={14} />Remove</button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div style={styles.root}>
      {selected && renderDetail(selected)}
      <div style={styles.agentHeader}>
        <div style={{ minWidth: 0 }}>
          <div style={styles.eyebrow}>Coding agent</div>
          <div style={styles.agentSwitcher} role="tablist" aria-label="Coding agent">
            {AGENTS.map(a => {
              const isSelected = agentFilter === a.key
              const isActive = activeAgent === a.key
              return (
                <button
                  key={a.key}
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => setAgentFilter(a.key)}
                  style={{ ...styles.agentButton, ...(isSelected ? styles.agentButtonSelected : undefined) }}
                >
                  {isActive && <span style={styles.activeDot} title="Default agent" />}
                  {a.label}
                </button>
              )
            })}
          </div>
        </div>
        <div style={styles.agentMeta}>
          <span>{loading ? 'Scanning…' : `${data.skills.length} skill${data.skills.length === 1 ? '' : 's'}`}</span>
          <button
            onClick={() => void reload(agentFilter)}
            disabled={loading}
            style={{ ...styles.iconButton, opacity: loading ? 0.5 : 1 }}
            title="Rescan skills"
            aria-label="Rescan skills"
          ><UIIcon name="refresh" size={14} /></button>
        </div>
      </div>

      {error && (
        <div style={styles.errorBanner}>
          {error}
        </div>
      )}

      {adding ? (
        <section style={styles.installCard} aria-label="Install skill">
          <div style={styles.installHeader}>
            <div>
              <div style={styles.installTitle}>Install a skill</div>
              <div style={styles.installSubtitle}>Add it to {AGENTS.find(a => a.key === agentFilter)?.label}</div>
            </div>
            <button
              onClick={() => { setAdding(false); setAddInput(''); setError(null) }}
              style={styles.iconButton}
              title="Cancel"
              aria-label="Cancel"
            ><UIIcon name="close" size={15} /></button>
          </div>

          <div style={styles.optionRow}>
            <div style={styles.optionGroup}>
              <span style={styles.optionLabel}>Install to</span>
              <div style={styles.smallSwitcher}>
                {(['user', 'project'] as const).map(s => {
                  const unavailable = s === 'project' && !data.projectDir
                  return (
                    <button
                      key={s}
                      onClick={() => setAddScope(s)}
                      style={{
                        ...styles.smallSwitchButton,
                        ...(addScope === s ? styles.smallSwitchButtonSelected : undefined),
                        opacity: unavailable ? 0.38 : 1,
                      }}
                      disabled={unavailable}
                      title={unavailable ? 'No active workspace' : s === 'user' ? 'Available across projects' : 'Only this project'}
                    >
                      {s === 'user' ? 'User' : 'Project'}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={styles.optionGroup}>
              <span style={styles.optionLabel}>Source</span>
              <div style={styles.smallSwitcher}>
                {(['localDir', 'gitUrl'] as const).map(src => (
                  <button
                    key={src}
                    onClick={() => { setAddSource(src); setAddInput('') }}
                    style={{ ...styles.smallSwitchButton, ...(addSource === src ? styles.smallSwitchButtonSelected : undefined) }}
                  >
                    {src === 'localDir' ? 'Local folder' : 'Git URL'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label style={styles.pathLabel} htmlFor="skill-source-input">
            {addSource === 'localDir' ? 'Skill folder' : 'Repository URL'}
          </label>
          <div style={styles.installInputRow}>
            <div style={styles.pathInputShell}>
              <span style={styles.pathIcon}><UIIcon name={addSource === 'localDir' ? 'folder' : 'link'} size={15} /></span>
              <input
                id="skill-source-input"
                type="text"
                placeholder={addSource === 'localDir' ? '~/.claude/skills/my-skill' : 'https://github.com/user/my-skill.git'}
                value={addInput}
                onChange={e => setAddInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleInstall() }}
                style={styles.pathInput}
                autoFocus
              />
              {addSource === 'localDir' && (
                <button onClick={handleBrowse} style={styles.browseButton}>Choose…</button>
              )}
            </div>
            <button
              onClick={handleInstall}
              style={{ ...styles.installButton, opacity: installing || !addInput.trim() ? 0.45 : 1 }}
              disabled={installing || !addInput.trim()}
            >
              {installing ? 'Installing…' : <><UIIcon name="add" size={14} />Install skill</>}
            </button>
          </div>
          <div style={styles.destinationHint}>
            Destination: <code style={styles.inlineCode}>{addScope === 'project' && data.projectDir ? data.projectDir : AGENT_SKILL_HINTS[agentFilter]}</code>
          </div>
        </section>
      ) : null}

      {loading ? (
        <div style={styles.loadingState}><span style={styles.loadingDot} />Scanning skill directories…</div>
      ) : data.skills.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={{ width: 52, height: 52, margin: '0 auto 12px', borderRadius: 16, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent }}><UIIcon name="sparkle" size={24} /></div>
          <div style={{ fontWeight: 650, color: C.fg, marginBottom: 5 }}>No skills found for {AGENTS.find(a => a.key === agentFilter)?.label}</div>
          <div style={{ fontSize: 12, lineHeight: 1.55 }}>
            Add a skill or place one in <code style={styles.inlineCode}>{AGENT_SKILL_HINTS[agentFilter]}</code>
          </div>
        </div>
      ) : (
        <div style={styles.skillGrid}>
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

const styles: Record<string, React.CSSProperties> = {
  root: { height: '100%', overflowY: 'auto', position: 'relative' },
  agentHeader: {
    display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
    gap: 16, marginBottom: 18, flexWrap: 'wrap',
  },
  eyebrow: {
    color: C.fg3, fontSize: 10, fontWeight: 750, letterSpacing: 0.75,
    textTransform: 'uppercase', marginBottom: 7,
  },
  agentSwitcher: {
    display: 'inline-flex', alignItems: 'center', padding: 3, gap: 2,
    borderRadius: 10, background: C.surface, border: `1px solid ${C.border}`,
  },
  agentButton: {
    minHeight: 32, padding: '6px 12px', borderRadius: 7, border: 'none',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    color: C.fg3, background: 'transparent', cursor: 'pointer',
    fontSize: 12, fontWeight: 650,
  },
  agentButtonSelected: {
    color: C.fg, background: C.surface3, boxShadow: `inset 0 0 0 1px ${C.border2}`,
  },
  activeDot: {
    width: 6, height: 6, borderRadius: '50%', background: C.accent,
    boxShadow: `0 0 0 3px ${C.accentDim}`, flexShrink: 0,
  },
  agentMeta: {
    display: 'flex', alignItems: 'center', gap: 8, color: C.fg3,
    fontSize: 11, paddingBottom: 1,
  },
  iconButton: {
    width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`,
    display: 'inline-grid', placeItems: 'center', padding: 0,
    color: C.fg3, background: C.surface, cursor: 'pointer', flexShrink: 0,
  },
  errorBanner: {
    background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`,
    padding: '9px 11px', borderRadius: 9, marginBottom: 14, fontSize: 12,
  },
  installCard: {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
    padding: 16, marginBottom: 18, boxShadow: '0 8px 28px rgba(0,0,0,0.08)',
  },
  installHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: 12, marginBottom: 15,
  },
  installTitle: { color: C.fg, fontSize: 13, fontWeight: 720, marginBottom: 3 },
  installSubtitle: { color: C.fg3, fontSize: 11 },
  optionRow: { display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap', marginBottom: 14 },
  optionGroup: { display: 'flex', alignItems: 'center', gap: 9 },
  optionLabel: { color: C.fg3, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' },
  smallSwitcher: {
    display: 'inline-flex', alignItems: 'center', padding: 2, gap: 2,
    borderRadius: 8, background: C.bg, border: `1px solid ${C.border}`,
  },
  smallSwitchButton: {
    minHeight: 27, border: 'none', borderRadius: 6, padding: '4px 10px',
    background: 'transparent', color: C.fg3, cursor: 'pointer',
    fontSize: 11, fontWeight: 650,
  },
  smallSwitchButtonSelected: { background: C.accentDim, color: C.accent },
  pathLabel: {
    display: 'block', color: C.fg3, fontSize: 10, fontWeight: 700,
    letterSpacing: 0.25, marginBottom: 6,
  },
  installInputRow: { display: 'flex', gap: 9, alignItems: 'stretch', flexWrap: 'wrap' },
  pathInputShell: {
    display: 'flex', alignItems: 'center', flex: '1 1 420px', minWidth: 220,
    border: `1px solid ${C.border2}`, borderRadius: 9, background: C.bg,
    overflow: 'hidden', minHeight: 38,
  },
  pathIcon: { display: 'inline-flex', color: C.fg3, marginLeft: 11, flexShrink: 0 },
  pathInput: {
    flex: 1, minWidth: 80, border: 'none', outline: 'none', background: 'transparent',
    color: C.fg, fontSize: 12, padding: '9px 10px', fontFamily: 'inherit',
  },
  browseButton: {
    alignSelf: 'stretch', border: 'none', borderLeft: `1px solid ${C.border}`,
    padding: '0 12px', background: C.surface3, color: C.fg2,
    fontSize: 11, fontWeight: 650, cursor: 'pointer', flexShrink: 0,
  },
  installButton: {
    minHeight: 38, border: 'none', borderRadius: 9, padding: '8px 14px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: C.accent, color: C.onAccent, cursor: 'pointer',
    fontSize: 12, fontWeight: 750, flexShrink: 0,
  },
  destinationHint: { marginTop: 8, color: C.fg3, fontSize: 10, lineHeight: 1.5 },
  inlineCode: {
    background: C.surface3, color: C.fg2, padding: '2px 5px',
    borderRadius: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    wordBreak: 'break-all',
  },
  loadingState: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    color: C.fg3, fontSize: 12, padding: '42px 20px',
  },
  loadingDot: { width: 7, height: 7, borderRadius: '50%', background: C.accent },
  emptyState: {
    textAlign: 'center', padding: '44px 20px', color: C.fg3,
    fontSize: 13, border: `1px dashed ${C.border2}`, borderRadius: 12,
    background: C.surface,
  },
  skillGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 },
}
