import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { C } from '../theme'
import { pillButton, Toggle, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { matchesToolSearch } from './tools-search'
import { WorkspaceSelect } from './WorkspaceSelect'
import { SKILL_SORT_MODES, sortSkills, usageFor, usageLabel } from './skillsSort'
import type { SkillSortMode } from './skillsSort'
import type { SkillEntry, SkillUsageMap, SkillsListResult } from '../codey-api'

type AgentFilter = 'claude-code' | 'opencode' | 'codex' | 'pi'
const AGENTS: { key: AgentFilter; label: string }[] = [
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'opencode',    label: 'OpenCode' },
  { key: 'codex',       label: 'Codex' },
  { key: 'pi',          label: 'Pi' },
]

/** Codey's own skills are global; a workspace can still hold repo-local ones. */
const CODEY_GLOBAL_SKILLS_HINT = '~/.codey/skills'
const CODEY_PROJECT_SKILLS_HINT = '.codey/skills'

const AGENT_SKILL_HINTS: Record<AgentFilter, string> = {
  'claude-code': '~/.claude/skills/',
  'codex': '~/.codex/skills/',
  'opencode': '~/.config/opencode/skills/',
  'pi': '~/.pi/agent/skills/',
}

export const SkillsTab: React.FC<{ addRequest?: number; searchQuery?: string }> = ({ addRequest = 0, searchQuery = '' }) => {
  // Codey's own skills are the leftmost segment of the same switcher that
  // selects a coding agent: one list, one source picker.
  const [codey, setCodey] = useState(true)
  const [data, setData] = useState<SkillsListResult>({ skills: [], projectDir: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addScope, setAddScope] = useState<'user' | 'project'>('user')
  // Codey installs default to the global root; the project root is offered
  // only when a workspace is open.
  // Which workspace the "Project" scope means. Empty until the workspace list
  // loads, at which point it settles on the active one; the user can point it
  // at any other workspace without switching the whole app over to it.
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [projectWorkspace, setProjectWorkspace] = useState('')
  const [addSource, setAddSource] = useState<'localDir' | 'gitUrl'>('localDir')
  const [addInput, setAddInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const [activeAgent, setActiveAgent] = useState<AgentFilter>('claude-code')
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('claude-code')
  const [selected, setSelected] = useState<SkillEntry | null>(null)
  const [copyState, setCopyState] = useState<{ label: string; status: 'copying' | 'done' | 'error'; msg?: string } | null>(null)
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const [busyDirs, setBusyDirs] = useState<Set<string>>(new Set())
  const [usage, setUsage] = useState<SkillUsageMap>({})
  const [sortMode, setSortMode] = useState<SkillSortMode>('name')
  const copyRef = useRef<HTMLDivElement>(null)
  const initDone = useRef(false)
  const usageToken = useRef(0)
  const filteredSkills = useMemo(
    () => sortSkills(
      data.skills.filter(skill => matchesToolSearch(searchQuery, skill.name, skill.qualifiedName, skill.description)),
      sortMode,
      usage,
    ),
    [data.skills, searchQuery, sortMode, usage],
  )
  const now = Date.now()
  const listKey = codey ? 'codey' : agentFilter
  const canInstall = addScope === 'user' || (projectWorkspace !== '' && data.projectDir !== null)

  // The primary action lives in the parent Tools tab bar; this counter gives
  // that button a clean way to open the existing install form without a second
  // competing "Add Skill" control in the content area.
  useEffect(() => {
    if (addRequest > 0) {
      setAdding(true)
      setAddInput('')
    }
  }, [addRequest])

  const reload = useCallback(async (agent: AgentFilter | 'codey', workspace: string) => {
    setLoading(true)
    setError(null)
    try {
      setData(unwrap(await window.codey.skills.list(agent, workspace || undefined)))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
    // Usage comes from scanning agent transcripts, which is slower than the
    // skill scan and non-essential: let the list paint, then fill counts in.
    // The token drops a slow scan whose agent is no longer the selected one.
    const token = ++usageToken.current
    try {
      const next = agent === 'codey' ? {} : unwrap(await window.codey.skills.usage(agent))
      if (token === usageToken.current) setUsage(next)
    } catch {
      if (token === usageToken.current) setUsage({})
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
      Promise.all([window.codey.workspaces.list(), window.codey.workspaces.current()])
        .then(([all, current]) => {
          const names = all.ok ? all.data : []
          setWorkspaces(names)
          const active = current.ok ? current.data : ''
          setProjectWorkspace(active && names.includes(active) ? active : names[0] ?? '')
        })
        .catch(() => {})
    }
  }, [])

  useEffect(() => { void reload(listKey, projectWorkspace) }, [listKey, projectWorkspace, reload])

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
      const payload: Parameters<typeof window.codey.skills.install>[0] = {
        agent: codey ? 'codey' : agentFilter,
        scope: addScope,
      }
      if (addScope === 'project') payload.workspace = projectWorkspace
      if (addSource === 'localDir') payload.localDir = addInput.trim()
      else payload.gitUrl = addInput.trim()
      unwrap(await window.codey.skills.install(payload))
      setAddInput('')
      setAdding(false)
      await reload(listKey, projectWorkspace)
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
      await reload(listKey, projectWorkspace)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const handleSetEnabled = async (skill: SkillEntry, enabled: boolean) => {
    if (busyDirs.has(skill.dir)) return
    setBusyDirs(prev => new Set(prev).add(skill.dir))
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
      setBusyDirs(prev => {
        const next = new Set(prev)
        next.delete(skill.dir)
        return next
      })
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
    if (targets.includes(agentFilter)) await reload(agentFilter, projectWorkspace)
    if (failures.length) setCopyState({ label, status: 'error', msg: failures.join('  •  ') })
    else setCopyState({ label, status: 'done' })
  }

  const renderCard = (skill: SkillEntry) => {
    const meta = usageLabel(usageFor(usage, skill), now)
    return (
    <button
      key={skill.dir}
      onClick={() => { setSelected(skill); setCopyState(null); setCopyMenuOpen(false); setError(null) }}
      style={{ ...cardStyle, opacity: skill.enabled ? 1 : 0.55 }}
      title={skill.description || skill.name}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, width: '100%' }}>
        <span style={{
          color: C.fg, fontSize: 13, fontWeight: 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1,
        }}>
          {skill.qualifiedName}
        </span>
        <span
          onClick={e => e.stopPropagation()}
          style={{
            display: 'inline-flex',
            opacity: busyDirs.has(skill.dir) ? 0.5 : 1,
            pointerEvents: busyDirs.has(skill.dir) ? 'none' : undefined,
          }}
          title={skill.enabled ? 'Disable this skill' : 'Enable this skill'}
        >
          <Toggle
            on={skill.enabled}
            onChange={value => void handleSetEnabled(skill, value)}
            label={skill.enabled ? 'Disable this skill' : 'Enable this skill'}
          />
        </span>
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: 0.3,
          padding: '2px 6px', borderRadius: 4, flexShrink: 0,
          background: skill.scope === 'user' ? C.accentDim : C.surface3,
          color: skill.scope === 'user' ? C.accent : C.fg3,
        }}>
          {codey ? (skill.scope === 'user' ? 'Global' : 'Project') : skill.managedBy ? 'Plugin' : skill.scope === 'user' ? 'User' : 'Project'}
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
      {meta && (
        <div style={{ color: C.fg3, fontSize: 10, opacity: 0.85, marginTop: 'auto', paddingTop: 6 }}>{meta}</div>
      )}
    </button>
    )
  }

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
          <div
            style={{
              opacity: busyDirs.has(skill.dir) ? 0.5 : 1,
              pointerEvents: busyDirs.has(skill.dir) ? 'none' : undefined,
            }}
            title={skill.enabled ? 'Disable this skill' : 'Enable this skill'}
          >
            <Toggle
              on={skill.enabled}
              onChange={value => void handleSetEnabled(skill, value)}
              label={skill.enabled ? 'Disable this skill' : 'Enable this skill'}
            />
          </div>
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
            padding: '2px 6px', borderRadius: 4,
            background: skill.scope === 'user' ? C.accentDim : C.surface3,
            color: skill.scope === 'user' ? C.accent : C.fg3,
          }}>
            {codey ? (skill.scope === 'user' ? 'Global' : 'Project') : skill.managedBy ? 'Plugin' : skill.scope === 'user' ? 'User' : 'Project'}
          </span>
          <button onClick={() => setSelected(null)} style={{ ...iconBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Close" aria-label="Close"><UIIcon name="close" size={14} /></button>
        </div>

        {skill.description && (
          <div style={{ color: C.fg2, fontSize: 13, lineHeight: '1.55', marginBottom: 16, whiteSpace: 'pre-wrap' }}>
            {skill.description}
          </div>
        )}

        {skill.managedBy && !skill.enabled && (
          <div style={{ color: C.fg3, fontSize: 11, lineHeight: 1.5, marginBottom: 14 }}>
            Plugin updates may restore this skill.
          </div>
        )}

        <div style={{ color: C.fg3, fontSize: 11, marginBottom: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 2, opacity: 0.7 }}>Location</div>
          <div style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>{skill.dir}</div>
        </div>

        {error && <div style={{ ...styles.errorBanner, marginBottom: 12 }}>{error}</div>}

        {!codey && copyState && (
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
          {!codey && <div ref={copyRef} style={{ position: 'relative', display: 'flex' }}>
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
          </div>}
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
          <div style={styles.agentSwitcher} role="tablist" aria-label="Skill source">
            <button
              role="tab"
              aria-selected={codey}
              onClick={() => setCodey(true)}
              title={`Shared with every coding agent — stored in ${CODEY_GLOBAL_SKILLS_HINT}`}
              style={{ ...styles.agentButton, ...(codey ? styles.agentButtonSelected : undefined) }}
            >
              <UIIcon name="sparkle" size={13} />
              Codey
            </button>
            <span style={styles.switcherDivider} />
            {AGENTS.map(a => {
              const isSelected = !codey && agentFilter === a.key
              const isActive = activeAgent === a.key
              return (
                <button
                  key={a.key}
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => { setCodey(false); setAgentFilter(a.key) }}
                  style={{ ...styles.agentButton, ...(isSelected ? styles.agentButtonSelected : undefined) }}
                >
                  {isActive && <span style={styles.activeDot} title="Default agent" />}
                  {a.label}
                </button>
              )
            })}
          </div>
          <div style={styles.sourceHint}>
            {codey
              ? `Stored in ${CODEY_GLOBAL_SKILLS_HINT} and discovered by every coding agent`
              : `Installed for ${AGENTS.find(a => a.key === agentFilter)?.label} only`}
            {projectWorkspace && ` · project skills from ${projectWorkspace}`}
          </div>
        </div>
        <div style={styles.agentMeta}>
          <div style={styles.smallSwitcher} role="tablist" aria-label="Sort skills">
            {SKILL_SORT_MODES.map(mode => (
              <button
                key={mode.key}
                role="tab"
                aria-selected={sortMode === mode.key}
                onClick={() => setSortMode(mode.key)}
                title={mode.title}
                style={{ ...styles.smallSwitchButton, ...(sortMode === mode.key ? styles.smallSwitchButtonSelected : undefined) }}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <span>{loading ? 'Scanning…' : searchQuery.trim()
            ? `${filteredSkills.length} of ${data.skills.length} skills`
            : `${data.skills.length} skill${data.skills.length === 1 ? '' : 's'}`}</span>
          <button
            onClick={() => void reload(listKey, projectWorkspace)}
            disabled={loading || busyDirs.size > 0}
            style={{ ...styles.iconButton, opacity: loading || busyDirs.size > 0 ? 0.5 : 1 }}
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
              <div style={styles.installSubtitle}>{codey ? 'Share it with every coding agent' : `Add it to ${AGENTS.find(a => a.key === agentFilter)?.label}`}</div>
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
                  const unavailable = s === 'project' && workspaces.length === 0
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
                      title={unavailable ? 'No workspaces yet' : s === 'user' ? 'Available across projects' : 'Only the selected workspace'}
                    >
                      {s === 'user' ? (codey ? 'Global' : 'User') : 'Project'}
                    </button>
                  )
                })}
              </div>
            </div>

            {addScope === 'project' && (
              <div style={styles.optionGroup}>
                <span style={styles.optionLabel}>Workspace</span>
                <WorkspaceSelect
                  id="skill-workspace-select"
                  value={projectWorkspace}
                  options={workspaces}
                  onChange={setProjectWorkspace}
                />
              </div>
            )}

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
              style={{ ...styles.installButton, opacity: installing || !addInput.trim() || !canInstall ? 0.45 : 1 }}
              disabled={installing || !addInput.trim() || !canInstall}
            >
              {installing ? 'Installing…' : <><UIIcon name="add" size={14} />Install skill</>}
            </button>
          </div>
          <div style={styles.destinationHint}>
            Destination: <code style={styles.inlineCode}>{addScope === 'project'
              ? (data.projectDir ?? (codey ? CODEY_PROJECT_SKILLS_HINT : 'the selected workspace'))
              : codey ? CODEY_GLOBAL_SKILLS_HINT : AGENT_SKILL_HINTS[agentFilter]}</code>
            {!canInstall && (
              <span style={{ color: C.red, marginLeft: 8 }}>
                {projectWorkspace
                  ? `"${projectWorkspace}" has no working directory.`
                  : 'Select a workspace first.'}
              </span>
            )}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div style={styles.loadingState}><span style={styles.loadingDot} />Scanning skill directories…</div>
      ) : data.skills.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={{ width: 52, height: 52, margin: '0 auto 12px', borderRadius: 16, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent }}><UIIcon name="sparkle" size={24} /></div>
          <div style={{ fontWeight: 650, color: C.fg, marginBottom: 5 }}>{codey ? 'No Codey skills found' : `No skills found for ${AGENTS.find(a => a.key === agentFilter)?.label}`}</div>
          <div style={{ fontSize: 12, lineHeight: 1.55 }}>
            Add a skill or place one in <code style={styles.inlineCode}>{codey ? CODEY_GLOBAL_SKILLS_HINT : AGENT_SKILL_HINTS[agentFilter]}</code>
          </div>
        </div>
      ) : filteredSkills.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={{ fontWeight: 650, color: C.fg, marginBottom: 5 }}>No matching skills</div>
          <div style={{ fontSize: 12 }}>Try a different name or description keyword.</div>
        </div>
      ) : (
        <div style={styles.skillGrid}>
          {filteredSkills.map(renderCard)}
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
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: 16, marginBottom: 18, flexWrap: 'wrap',
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
  switcherDivider: {
    width: 1, alignSelf: 'stretch', margin: '4px 4px', background: C.border2, flexShrink: 0,
  },
  sourceHint: { color: C.fg3, fontSize: 11, marginTop: 7 },
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
