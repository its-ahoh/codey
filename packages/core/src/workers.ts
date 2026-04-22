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
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const worker = this.loadWorker(name);
      if (worker) this.workers.set(name.toLowerCase(), worker);
    }

    console.log(`[Workers] Loaded ${this.workers.size} workers from ${this.workersDir}`);
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
