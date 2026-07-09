// packages/core/src/skill-crystallizer.ts
//
// On-disk layout (under <workspace>/skills/):
//   index.json  — skill manifest: entries with version history, plus the rejected-suggestion list
//   traces.json — rolling window of recent run traces (capped at RECENT_TRACES_MAX)
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { AideRunner, runAide } from './aide';
import { CodingAgent, CoreLogger, ModelConfig } from './types';

// ── Types ──────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
  version: number;
  /** Prior versions of steps, oldest first, capped at HISTORY_MAX. Enables rollback. */
  history: { version: number; steps: string }[];
  useCount: number;
  lastUsedAt: number;
  successSignals: { cleanRuns: number; corrections: number };
  sourceRunIds: string[];
  createdAt: number;
  archived: boolean;
}

export interface RejectedSuggestion {
  name: string;
  description: string;
  rejectedAt: number;
}

export interface SkillIndex {
  version: 1;
  entries: SkillEntry[];
  /** Suggestions the user said "no" to — fed to the distiller so it stops re-proposing them. */
  rejected: RejectedSuggestion[];
}

export interface RunTrace {
  runId: string;
  promptSummary: string;
  /** First ~300 chars of the agent's output. A preview, not a structural analysis. */
  outputPreview: string;
  workerSequence?: string[];
  timestamp: number;
  mode: 'solo' | 'team-sequential' | 'team-parallel' | 'team-auto';
}

export interface DistillDeps {
  agent: CodingAgent;
  model: ModelConfig | undefined;
  /** Plain LLM runner, injected the same way as the Advisor/Aide runners.
   *  Crystallizer prompts embed user text and agent output, so this MUST be
   *  a tool-less call — never a coding-agent run with permissions skipped. */
  runner: AideRunner;
  /** Hard timeout per call in ms. Defaults to the Aide's 30s. */
  timeoutMs?: number;
}

export interface DistillResult {
  name: string;
  description: string;
  whenToUse: string;
  steps: string;
}

export interface SkillMatch {
  skill: SkillEntry;
  /** high → apply directly; borderline → confirm with the LLM gate first. */
  confidence: 'high' | 'borderline';
  score: number;
}

export const RECENT_TRACES_MAX = 20;
export const HISTORY_MAX = 5;
export const REJECTED_MAX = 20;

interface TracesFile {
  version: 1;
  traces: RunTrace[];
}

// ── SkillStore ─────────────────────────────────────────────────────

export class SkillStore {
  private skillsDir: string;
  private indexPath: string;
  private tracesPath: string;
  private index: SkillIndex = { version: 1, entries: [], rejected: [] };
  private runTraces: RunTrace[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private indexDirty = false;
  private tracesDirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Consecutive doPersist failures. Logged once per streak, reset on success. */
  private persistFailStreak = 0;
  private logger?: CoreLogger;
  private static FLUSH_DEBOUNCE_MS = 50;
  /** Retry floor after a failed persist — a broken disk must not hot-loop at 50ms. */
  private static PERSIST_RETRY_MS = 5_000;

  constructor(workspacePath: string, logger?: CoreLogger) {
    this.skillsDir = path.join(workspacePath, 'skills');
    this.indexPath = path.join(this.skillsDir, 'index.json');
    this.tracesPath = path.join(this.skillsDir, 'traces.json');
    this.logger = logger;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    if (fs.existsSync(this.indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as SkillIndex;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
          this.index = {
            version: 1,
            entries: parsed.entries.map(e => ({ ...e, history: e.history ?? [] })),
            rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
          };
        }
      } catch {
        this.index = { version: 1, entries: [], rejected: [] };
      }
    }
    if (fs.existsSync(this.tracesPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.tracesPath, 'utf-8')) as TracesFile;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.traces)) {
          this.runTraces = parsed.traces.slice(0, RECENT_TRACES_MAX);
        }
      } catch { /* start with empty traces */ }
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.enqueuePersist();
    }
    await this.writeChain;
  }

  // ── CRUD ─────────────────────────────────────────────────────

  add(params: {
    name: string;
    description: string;
    whenToUse: string;
    steps: string;
    sourceRunId?: string;
  }): SkillEntry {
    const now = Date.now();
    const existing = this.index.entries.find(e => e.name === params.name);
    if (existing) {
      if (existing.steps !== params.steps) {
        existing.history.push({ version: existing.version, steps: existing.steps });
        if (existing.history.length > HISTORY_MAX) {
          existing.history = existing.history.slice(-HISTORY_MAX);
        }
        existing.version++;
        existing.steps = params.steps;
      }
      existing.description = params.description;
      existing.whenToUse = params.whenToUse;
      if (params.sourceRunId && !existing.sourceRunIds.includes(params.sourceRunId)) {
        existing.sourceRunIds.push(params.sourceRunId);
      }
      this.markIndexDirty();
      return existing;
    }
    const entry: SkillEntry = {
      name: params.name,
      description: params.description,
      whenToUse: params.whenToUse,
      steps: params.steps,
      version: 1,
      history: [],
      useCount: 0,
      lastUsedAt: now,
      successSignals: { cleanRuns: 0, corrections: 0 },
      sourceRunIds: params.sourceRunId ? [params.sourceRunId] : [],
      createdAt: now,
      archived: false,
    };
    this.index.entries.push(entry);
    this.markIndexDirty();
    return entry;
  }

  get(name: string): SkillEntry | undefined {
    return this.index.entries.find(e => e.name === name);
  }

  getAll(): SkillEntry[] { return [...this.index.entries]; }

  getActive(): SkillEntry[] {
    return this.index.entries.filter(e => !e.archived);
  }

  archive(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.archived = true;
    this.markIndexDirty();
    return true;
  }

  restore(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.archived = false;
    this.markIndexDirty();
    return true;
  }

  recordUse(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.useCount++;
    entry.lastUsedAt = Date.now();
    this.markIndexDirty();
    return true;
  }

  recordSuccessSignal(name: string, clean: boolean): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    if (clean) entry.successSignals.cleanRuns++;
    else entry.successSignals.corrections++;
    this.markIndexDirty();
    return true;
  }

  /** Bump version, retaining the outgoing steps in history (capped) for rollback. */
  bumpVersion(name: string, newSteps: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    entry.history.push({ version: entry.version, steps: entry.steps });
    if (entry.history.length > HISTORY_MAX) {
      entry.history = entry.history.slice(-HISTORY_MAX);
    }
    entry.version++;
    entry.steps = newSteps;
    this.markIndexDirty();
    return true;
  }

  /** Restore the most recent prior version of steps. Returns false if no history. */
  rollback(name: string): boolean {
    const entry = this.index.entries.find(e => e.name === name);
    if (!entry) return false;
    const prior = entry.history.pop();
    if (!prior) return false;
    entry.version = prior.version;
    entry.steps = prior.steps;
    this.markIndexDirty();
    return true;
  }

  // ── Rejected suggestions ─────────────────────────────────────

  rejectSuggestion(name: string, description: string): void {
    this.index.rejected.push({ name, description, rejectedAt: Date.now() });
    if (this.index.rejected.length > REJECTED_MAX) {
      this.index.rejected = this.index.rejected.slice(-REJECTED_MAX);
    }
    this.markIndexDirty();
  }

  getRejected(): RejectedSuggestion[] { return [...this.index.rejected]; }

  // ── Traces (persisted) ───────────────────────────────────────

  recordTrace(trace: RunTrace): void {
    this.runTraces.unshift(trace);
    if (this.runTraces.length > RECENT_TRACES_MAX) {
      this.runTraces = this.runTraces.slice(0, RECENT_TRACES_MAX);
    }
    this.markTracesDirty();
  }

  getRecentTraces(limit: number = 10): RunTrace[] {
    return this.runTraces.slice(0, limit);
  }

  // ── GC ───────────────────────────────────────────────────────

  runCollectGarbage(opts: { staleDays: number; weakSkillDays: number }): number {
    const now = Date.now();
    let archived = 0;
    for (const entry of this.index.entries) {
      if (entry.archived) continue;
      if (now - entry.lastUsedAt > opts.staleDays * 86_400_000) {
        entry.archived = true;
        archived++;
        continue;
      }
      if (
        entry.useCount < 2 &&
        now - entry.createdAt > opts.weakSkillDays * 86_400_000 &&
        now - entry.lastUsedAt > opts.weakSkillDays * 86_400_000
      ) {
        entry.archived = true;
        archived++;
      }
    }
    if (archived > 0) this.markIndexDirty();
    return archived;
  }

  // ── Persistence ──────────────────────────────────────────────

  private markIndexDirty(): void {
    this.indexDirty = true;
    this.scheduleFlush();
  }

  private markTracesDirty(): void {
    this.tracesDirty = true;
    this.scheduleFlush();
  }

  private enqueuePersist(): void {
    this.writeChain = this.writeChain.then(() => this.doPersist()).catch(() => {});
  }

  private async doPersist(): Promise<void> {
    if (!this.indexDirty && !this.tracesDirty) return;
    const writeIndex = this.indexDirty;
    const writeTraces = this.tracesDirty;
    this.indexDirty = false;
    this.tracesDirty = false;
    // Serialize synchronously so later mutations in this tick can't tear the snapshot.
    const indexJson = writeIndex ? JSON.stringify(this.index, null, 2) : null;
    const tracesPayload: TracesFile = { version: 1, traces: this.runTraces };
    const tracesJson = writeTraces ? JSON.stringify(tracesPayload, null, 2) : null;
    try {
      await fsp.mkdir(this.skillsDir, { recursive: true });
      if (indexJson !== null) {
        await atomicWrite(this.indexPath, indexJson);
      }
      if (tracesJson !== null) {
        await atomicWrite(this.tracesPath, tracesJson);
      }
      if (this.persistFailStreak > 0) {
        this.logger?.info(`[SkillStore] persist recovered after ${this.persistFailStreak} failed attempt(s)`);
        this.persistFailStreak = 0;
      }
    } catch (err) {
      this.indexDirty = this.indexDirty || writeIndex;
      this.tracesDirty = this.tracesDirty || writeTraces;
      this.persistFailStreak++;
      // Log once per failure streak (not per retry), and back off to a 5s
      // floor instead of the 50ms debounce so a persistent failure doesn't spin.
      if (this.persistFailStreak === 1) {
        this.logger?.warn(`[SkillStore] persist to ${this.skillsDir} failed (will retry every ${SkillStore.PERSIST_RETRY_MS / 1000}s): ${(err as Error).message}`);
      }
      this.scheduleFlush(SkillStore.PERSIST_RETRY_MS);
    }
  }

  private scheduleFlush(delayMs: number = SkillStore.FLUSH_DEBOUNCE_MS): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueuePersist();
    }, delayMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }
}

// ── Helpers ─────────────────────────────────────────────────────

async function atomicWrite(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, target);
}

function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

/** Single-pass template fill. A function replacement is immune to `$`-pattern
 *  expansion in user-derived text, and one pass means substituted content
 *  can't itself be re-substituted. Keys are literals like '%TRACES%' — only
 *  word chars between %, so no regex metacharacters to escape. */
function fillPrompt(template: string, sections: Record<string, string>): string {
  const keys = Object.keys(sections);
  if (keys.length === 0) return template;
  const pattern = new RegExp(keys.join('|'), 'g');
  return template.replace(pattern, m => sections[m]);
}

/** One bounded, tool-less LLM call via the injected runner — the same
 *  convention as the Advisor/Aide (30s abort by default, no permissions
 *  bypass, no working-dir tool access). Crystallizer prompts are small
 *  classification/extraction tasks over user text and agent output, so they
 *  must never run through a tool-capable coding-agent session. Returns the
 *  trimmed output, or null on failure/timeout. */
async function runCrystallizerLLM(deps: DistillDeps, prompt: string): Promise<string | null> {
  try {
    return await runAide(prompt, {
      agent: deps.agent,
      model: deps.model,
      runner: deps.runner,
      timeoutMs: deps.timeoutMs,
    });
  } catch {
    return null;
  }
}

// ── distillCandidate ───────────────────────────────────────────

const DISTILL_PROMPT = `You analyze coding-agent runs to find recurring work patterns.

Given these recent run traces and existing skills, identify a repeatable sub-process that appears in 2+ runs. If you find one, describe it as a reusable skill. If none, return exactly "NONE".

Recent traces:
%TRACES%

Existing skills (don't duplicate):
%SKILLS%

Previously rejected suggestions (the user said no — do NOT re-propose these or close variants):
%REJECTED%

Return ONE JSON object (no markdown, no prose) or the literal word "NONE":
{
  "name": "kebab-case",
  "description": "one line describing what this skill does",
  "whenToUse": "when the user asks to...",
  "steps": "1. ...\\n2. ...\\n3. ..."
}

Rules:
- name must match /^[a-z][a-z0-9-]*$/ and be 3-30 chars.
- Output ONLY the JSON or "NONE". No markdown fences, no prose.`;

function formatTracesForPrompt(traces: RunTrace[]): string {
  return traces.map(t => {
    const parts = [`- ${t.promptSummary} [${t.mode}]`];
    if (t.workerSequence && t.workerSequence.length > 0) {
      parts.push(`  Steps: ${t.workerSequence.join(' → ')}`);
    }
    return parts.join('\n');
  }).join('\n');
}

function formatSkillsForPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) return '(none)';
  return skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
}

function formatRejectedForPrompt(rejected: RejectedSuggestion[]): string {
  if (rejected.length === 0) return '(none)';
  return rejected.map(r => `- ${r.name}: ${r.description}`).join('\n');
}

function tryParseDistill(raw: string): DistillResult | null {
  const trimmed = raw.trim();
  if (trimmed === 'NONE' || trimmed === '"NONE"') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stripCodeFences(trimmed)); } catch { return null; }
  const p = parsed as Record<string, unknown>;
  if (!p || typeof p !== 'object') return null;
  for (const field of ['name', 'description', 'whenToUse', 'steps'] as const) {
    if (typeof p[field] !== 'string' || !(p[field] as string).trim()) return null;
  }
  return { name: p.name as string, description: p.description as string,
           whenToUse: p.whenToUse as string, steps: p.steps as string };
}

export async function distillCandidate(
  deps: DistillDeps,
  traces: RunTrace[],
  existing: SkillEntry[],
  rejected: RejectedSuggestion[],
  minRecurrence: number,
): Promise<DistillResult | null> {
  if (traces.length < minRecurrence) return null;

  const composed = fillPrompt(DISTILL_PROMPT, {
    '%TRACES%': formatTracesForPrompt(traces),
    '%SKILLS%': formatSkillsForPrompt(existing.filter(s => !s.archived)),
    '%REJECTED%': formatRejectedForPrompt(rejected),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? composed
      : `${composed}\n\nReminder: return ONLY the JSON object or the word "NONE". No markdown.`;
    const output = await runCrystallizerLLM(deps, prompt);
    if (output === null) continue;
    const parsed = tryParseDistill(output);
    if (parsed) {
      if (/^[a-z][a-z0-9-]*$/.test(parsed.name) && parsed.name.length >= 3 && parsed.name.length <= 30) {
        return parsed;
      }
    }
    if (output.trim() === 'NONE') return null;
  }
  return null;
}

export function matchSkill(task: string, skills: SkillEntry[]): SkillMatch | null {
  const active = skills.filter(s => !s.archived);
  if (active.length === 0) return null;
  // Dedupe both token lists so repeated words can't inflate the intersection
  // count past the LLM confirm gate; this also makes the score true Jaccard.
  const taskTokens = [...new Set(tokenizeLax(task))];
  if (taskTokens.length === 0) return null;
  let best: SkillMatch | null = null;
  for (const skill of active) {
    const skillTokens = [...new Set(tokenizeLax(`${skill.description} ${skill.whenToUse}`))];
    if (skillTokens.length === 0) continue;
    const intersection = skillTokens.filter(t => taskTokens.includes(t));
    if (intersection.length < 1) continue;
    const unionSize = new Set([...taskTokens, ...skillTokens]).size;
    const score = intersection.length / unionSize;
    // 'high' (auto-apply without the LLM gate) needs REAL overlap: 3+ shared
    // keywords and a strong Jaccard. Two-token matches are too easy to hit by
    // accident (e.g. "merged PRs" alone), so they stay borderline and must
    // pass the confirmMatch gate before being applied.
    const confidence: SkillMatch['confidence'] =
      intersection.length >= 3 && score >= 0.25 ? 'high' : 'borderline';
    if (!best || score > best.score) {
      best = { skill, confidence, score };
    }
  }
  return best;
}

// Limitation: Latin/alphanumeric keywords only. CJK text produces no tokens,
// so pure-CJK prompts never auto-match (they simply skip the skill fast-path);
// mixed-script prompts still match via their Latin keywords. Bigram
// tokenization for CJK is a possible v2.
function tokenizeLax(text: string): string[] {
  if (!text) return [];
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for',
    'from', 'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or',
    'that', 'the', 'to', 'was', 'were', 'will', 'with', 'you', 'i', 'me',
    'my', 'we', 'our', 'this',
  ]);
  return text.toLowerCase()
    .split(/[^a-z0-9_\-]+/i)
    .filter(t => t.length > 1 && !stopWords.has(t));
}

const MATCH_CONFIRM_PROMPT = `Does the following task match this skill? The skill should only apply when the user is asking for exactly this kind of work.

Skill: %SKILL_NAME%
Description: %SKILL_DESC%
When to use: %SKILL_WHEN%

Task: %TASK%

Return ONLY "YES" or "NO".`;

export async function confirmMatch(
  deps: DistillDeps,
  task: string,
  skill: SkillEntry,
): Promise<boolean> {
  const prompt = fillPrompt(MATCH_CONFIRM_PROMPT, {
    '%SKILL_NAME%': skill.name,
    '%SKILL_DESC%': skill.description,
    '%SKILL_WHEN%': skill.whenToUse,
    '%TASK%': task,
  });
  const output = await runCrystallizerLLM(deps, prompt);
  if (output === null) return false;
  return output.trim().toUpperCase() === 'YES';
}

export function applySkill(task: string, skill: SkillEntry): string {
  const banner = `⚙︎ using skill: ${skill.name} (v${skill.version})\n\nFollow this procedure:\n${skill.steps}\n\n---\nNow execute this task:`;
  return task ? `${banner} ${task}` : `${banner}\n\nProceed with the procedure above.`;
}

const EVOLVE_PROMPT = `A skill was just applied to a coding task. Review whether the skill's steps should be improved based on what actually happened.

Skill: %SKILL_NAME%
Description: %SKILL_DESC%
When to use: %SKILL_WHEN%

Current steps:
%STEPS%

Run context:
- Task: %TASK_SUMMARY%
- Output preview: %OUTPUT_PREVIEW%
- Mode: %MODE%
%WORKER_STEPS%

Does the run suggest a better version of the steps? If yes, return improved steps. If the current steps are fine, say no change. Only propose a change when the run clearly revealed a missing, wrong, or better step — do not rephrase working steps.

Return ONE JSON:
{"improved": true, "steps": "1. ...\\n2. ...\\n3. ..."}
or
{"improved": false}

Output ONLY JSON. No markdown fences, no prose.`;

export async function evolveSkill(
  deps: DistillDeps,
  skill: SkillEntry,
  trace: RunTrace,
): Promise<string | null> {
  let workerPart = '';
  if (trace.workerSequence && trace.workerSequence.length > 0) {
    workerPart = `- Worker sequence: ${trace.workerSequence.join(' → ')}`;
  }
  const composed = fillPrompt(EVOLVE_PROMPT, {
    '%SKILL_NAME%': skill.name,
    '%SKILL_DESC%': skill.description,
    '%SKILL_WHEN%': skill.whenToUse,
    '%STEPS%': skill.steps,
    '%TASK_SUMMARY%': trace.promptSummary,
    '%OUTPUT_PREVIEW%': trace.outputPreview,
    '%MODE%': trace.mode,
    '%WORKER_STEPS%': workerPart,
  });

  const output = await runCrystallizerLLM(deps, composed);
  if (output === null) return null;
  try {
    const parsed = JSON.parse(stripCodeFences(output));
    if (parsed.improved === true && typeof parsed.steps === 'string' && parsed.steps.trim()) {
      return parsed.steps.trim();
    }
  } catch { /* unparseable — no change */ }
  return null;
}
