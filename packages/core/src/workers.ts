import * as fs from 'fs';
import * as path from 'path';

export interface WorkerPersonality {
  role: string;
  soul: string;
  instructions: string;
}

export interface WorkerConfig {
  codingAgent: 'claude-code' | 'opencode' | 'codex';
  model: string;
  tools: string[];
  /**
   * Optional one-line summary fed to the auto-dispatcher when this worker
   * appears in a team with `dispatch: 'auto'`. When unset, the dispatcher
   * uses the first line of `personality.role` truncated to 120 chars.
   * `personality.soul` and `.instructions` are never sent to the dispatcher.
   */
  dispatchHint?: string;
}

export interface Worker {
  name: string;
  personality: WorkerPersonality;
  config: WorkerConfig;
}

const VALID_CODING_AGENTS: readonly WorkerConfig['codingAgent'][] = ['claude-code', 'opencode', 'codex'];

export class WorkerManager {
  private workersDir: string;
  private workers: Map<string, Worker> = new Map();

  constructor(workersDir: string = './workers') {
    this.workersDir = workersDir;
  }

  async loadWorkers(): Promise<void> {
    this.workers.clear();

    if (!fs.existsSync(this.workersDir)) {
      console.log(`[Workers] Library not found at ${this.workersDir} — no workers loaded`);
      return;
    }

    const entries = fs.readdirSync(this.workersDir, { withFileTypes: true });
    const skipped: string[] = [];
    for (const entry of entries) {
      // Workers are directories with personality.md + config.json. Anything
      // else here (stray .json files from the old flat schema, leftover .DS_Store,
      // backups) is unloadable — surface it so the user can clean up rather
      // than wonder why a worker they "see on disk" doesn't appear in the UI.
      if (!entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          console.warn(`[Workers] Ignoring non-directory entry: ${entry.name}`);
          skipped.push(entry.name);
        }
        continue;
      }
      const name = entry.name;
      const dir = path.join(this.workersDir, name);
      const contents = fs.readdirSync(dir);
      if (contents.length === 0) {
        // An empty <name>/ blocks re-creation under the same name — call it
        // out specifically so the user knows to remove the directory.
        console.warn(`[Workers] Ignoring empty directory: ${name} (delete it to free the name)`);
        skipped.push(name);
        continue;
      }
      const worker = this.loadWorker(name);
      if (worker) this.workers.set(name.toLowerCase(), worker);
      else skipped.push(name);
    }

    console.log(`[Workers] Loaded ${this.workers.size} workers from ${this.workersDir}` +
      (skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : ''));
  }

  private loadWorker(name: string): Worker | null {
    const dir = path.join(this.workersDir, name);
    const mdPath = path.join(dir, 'personality.md');
    const cfgPath = path.join(dir, 'config.json');

    if (!fs.existsSync(mdPath)) {
      console.error(`[Workers] Skipping ${name}: personality.md missing`);
      return null;
    }
    if (!fs.existsSync(cfgPath)) {
      console.error(`[Workers] Skipping ${name}: config.json missing (required)`);
      return null;
    }

    let config: WorkerConfig;
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
      console.error(`[Workers] Skipping ${name}: config.json invalid JSON (${err})`);
      return null;
    }

    if (!config.codingAgent || !config.model) {
      console.error(`[Workers] Skipping ${name}: config.json missing codingAgent or model`);
      return null;
    }
    if (!VALID_CODING_AGENTS.includes(config.codingAgent)) {
      console.error(`[Workers] Skipping ${name}: codingAgent "${config.codingAgent}" is not one of ${VALID_CODING_AGENTS.join(', ')}`);
      return null;
    }
    if (!Array.isArray(config.tools)) config.tools = [];

    let personality: WorkerPersonality;
    try {
      personality = this.parsePersonality(fs.readFileSync(mdPath, 'utf-8'));
    } catch (err) {
      console.error(`[Workers] Skipping ${name}: failed to read personality.md (${err})`);
      return null;
    }
    return { name, personality, config };
  }

  private parsePersonality(content: string): WorkerPersonality {
    const personality: WorkerPersonality = { role: '', soul: '', instructions: '' };
    const lines = content.split('\n');
    let currentSection = '';
    let buffer: string[] = [];

    const flush = () => {
      const trimmed = buffer.join('\n').trim();
      if (!trimmed) return;
      if (currentSection === 'role') personality.role = trimmed;
      else if (currentSection === 'soul') personality.soul = trimmed;
      else if (currentSection === 'instructions') personality.instructions = trimmed;
    };

    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush();
        currentSection = line.replace(/^##\s+/, '').toLowerCase();
        buffer = [];
      } else if (line.startsWith('# ')) {
        // title line, ignored
      } else {
        buffer.push(line);
      }
    }
    flush();
    return personality;
  }

  getWorker(name: string): Worker | undefined {
    return this.workers.get(name.toLowerCase());
  }

  hasWorker(name: string): boolean {
    return this.workers.has(name.toLowerCase());
  }

  getAllWorkers(): Worker[] {
    return Array.from(this.workers.values());
  }

  getWorkerNames(): string[] {
    return Array.from(this.workers.keys());
  }

  getWorkerCodingAgent(name: string): WorkerConfig['codingAgent'] {
    return this.getWorker(name)?.config.codingAgent || 'claude-code';
  }

  getWorkerModel(name: string): string {
    return this.getWorker(name)?.config.model || '';
  }

  /**
   * Returns the one-line summary the auto-dispatcher should see for this worker.
   * Prefers `config.dispatchHint`; otherwise falls back to the first line of
   * `personality.role` truncated to 120 characters. Empty string if the worker
   * is unknown.
   */
  getDispatchHint(name: string): string {
    const w = this.getWorker(name);
    if (!w) return '';
    if (w.config.dispatchHint && w.config.dispatchHint.trim()) {
      return w.config.dispatchHint.trim();
    }
    const firstLine = (w.personality.role || '').split('\n')[0].trim();
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  buildWorkerPrompt(name: string, task: string): string {
    const worker = this.getWorker(name);
    if (!worker) return task;
    return [
      `# Worker: ${worker.name}`,
      `## Role`,
      worker.personality.role,
      `## Personality`,
      worker.personality.soul,
      `## Instructions`,
      worker.personality.instructions,
      `## Pause for user input`,
      'If you cannot proceed without information from the user, output a single line `[ASK_USER]: <your question>` and stop. Do not guess. Do not continue the work.',
      'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
      `## Task`,
      task,
    ].join('\n\n');
  }

  /**
   * Sequential-mode variant. Includes the full team roster and (optionally) the
   * next worker in the chain so this worker can shape its output to feed into
   * the next step. Sequential mode has no Manager arbitration, so we keep only
   * the `[ASK_USER]:` marker (no forwarding).
   */
  buildSequentialWorkerPrompt(
    name: string,
    task: string,
    roster: Array<{ name: string; hint: string }>,
    nextWorker: { name: string; hint: string } | null,
  ): string {
    const worker = this.getWorker(name);
    if (!worker) return task;
    const rosterLines = roster.length > 0
      ? roster.map(r => `- ${r.name}: ${r.hint || '(no description)'}`).join('\n')
      : '(you are the only worker on this team)';
    const nextSection = nextWorker
      ? `Next up after you: **${nextWorker.name}** — ${nextWorker.hint || '(no description)'}.\nShape your output so it gives them what they need to do their step well: be explicit about decisions, hand off open questions clearly, and avoid burying important context in passing remarks.`
      : 'You are the last worker in this run. Aim for a complete, polished result.';
    return [
      `# Worker: ${worker.name}`,
      `## Role`,
      worker.personality.role,
      `## Personality`,
      worker.personality.soul,
      `## Instructions`,
      worker.personality.instructions,
      `## Teammates (full sequence)`,
      rosterLines,
      `## Handoff`,
      nextSection,
      `## Pause for user input`,
      'If you cannot proceed without information from the user, output a single line `[ASK_USER]: <your question>` and stop. Do not guess.',
      'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
      `## Task`,
      task,
    ].join('\n\n');
  }

  /**
   * Auto-mode variant of buildWorkerPrompt. Injects the team roster (excluding self)
   * so the worker can address questions to a specific teammate via `[ASK: name]: q`,
   * falling back to `[ASK_USER]: q` when no teammate can help.
   *
   * `roster` should contain {name, hint} for every member except the running worker.
   */
  buildTeamWorkerPrompt(
    name: string,
    task: string,
    roster: Array<{ name: string; hint: string; lastDid?: string }>,
  ): string {
    const worker = this.getWorker(name);
    if (!worker) return task;
    const rosterLines = roster.length > 0
      ? roster
          .map(r => {
            const head = `- ${r.name}: ${r.hint || '(no description)'}`;
            return r.lastDid ? `${head}\n  last did: ${r.lastDid}` : head;
          })
          .join('\n')
      : '(you are the only worker on this team)';
    return [
      `# Worker: ${worker.name}`,
      `## Role`,
      worker.personality.role,
      `## Personality`,
      worker.personality.soul,
      `## Instructions`,
      worker.personality.instructions,
      `## Teammates`,
      rosterLines,
      `## When you have a question`,
      [
        'If you need information you do not have:',
        '1. First check the Teammates list. If a teammate plausibly knows the answer, output a single line `[ASK: <teammate>]: <your question>` and stop. The team will route the question to that teammate directly.',
        '2. If no teammate could plausibly answer, output a single line `[ASK_USER]: <your question>` and stop. The manager will decide whether to ask the user or route to a teammate.',
        'When the question is yes/no or a pick-one from a small set (≤ 8) of explicit options, prefer `[ASK_USER:choice]: <question> | <option 1> | <option 2>` so the user can answer with a tap. Use the free-text `[ASK_USER]:` form for open-ended questions.',
        'Use exactly one marker per output. Do not guess. Do not continue the work after emitting a marker.',
      ].join('\n'),
      `## Task`,
      task,
    ].join('\n\n');
  }

  listWorkers(): string {
    const all = this.getAllWorkers();
    if (all.length === 0) return 'No workers configured. Create folders under ./workers/<name>/ with personality.md and config.json.';
    return all.map(w => `• **${w.name}** — ${w.personality.role || '(no role)'} (${w.config.codingAgent}/${w.config.model})`).join('\n');
  }

  async saveWorker(name: string, personality: WorkerPersonality, config: WorkerConfig): Promise<void> {
    const dir = path.join(this.workersDir, name);
    await fs.promises.mkdir(dir, { recursive: true });
    const personalityContent = `# Worker: ${name}\n\n## Role\n${personality.role}\n\n## Soul\n${personality.soul}\n\n## Instructions\n${personality.instructions}\n`;
    await fs.promises.writeFile(path.join(dir, 'personality.md'), personalityContent, 'utf-8');
    await fs.promises.writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    await this.loadWorkers();
  }

  async deleteWorker(name: string): Promise<void> {
    const dir = path.join(this.workersDir, name);
    await fs.promises.rm(dir, { recursive: true, force: true });
    this.workers.delete(name.toLowerCase());
  }
}
