import * as fs from 'fs';
import * as path from 'path';

export interface WorkerConfig {
  name: string;
  role: string;
  soul: string;
  relationship: string;
  instructions: string;
}

export interface WorkerJsonConfig {
  codingAgent: 'claude-code' | 'opencode' | 'codex';
  model: string;
  tools: string[];
}

export interface WorkersJson {
  workers: Record<string, WorkerJsonConfig>;
}

export interface WorkerManifest {
  workers: Map<string, WorkerConfig>;
  workerConfigs: Map<string, WorkerJsonConfig>;
  relationships: Map<string, string[]>;
}

export class WorkerManager {
  private manifest: WorkerManifest;
  private workersDir: string;
  private configPath: string;

  constructor(workersDir: string = './workspaces/default') {
    this.workersDir = path.join(workersDir, 'workers');
    this.configPath = path.join(workersDir, 'workspace.json');
    this.manifest = { 
      workers: new Map(), 
      workerConfigs: new Map(),
      relationships: new Map() 
    };
  }

  setWorkspace(workspaceId: string): void {
    this.workersDir = `./workspaces/${workspaceId}/workers`;
    this.configPath = `./workspaces/${workspaceId}/workspace.json`;
    this.manifest = { 
      workers: new Map(), 
      workerConfigs: new Map(),
      relationships: new Map() 
    };
  }

  async loadWorkers(): Promise<void> {
    // Load JSON config first
    if (fs.existsSync(this.configPath)) {
      const configData = fs.readFileSync(this.configPath, 'utf-8');
      const workersJson: WorkersJson = JSON.parse(configData);
      
      for (const [name, config] of Object.entries(workersJson.workers)) {
        this.manifest.workerConfigs.set(name.toLowerCase(), config);
      }
      console.log(`[Workers] Loaded ${Object.keys(workersJson.workers).length} worker configs`);
    }

    // Load markdown files for personality
    if (!fs.existsSync(this.workersDir)) {
      console.log(`[Workers] Workers directory not found: ${this.workersDir}`);
      return;
    }

    const files = fs.readdirSync(this.workersDir).filter(f => f.endsWith('.md'));
    
    for (const file of files) {
      const workerName = file.replace('.md', '');
      const content = fs.readFileSync(path.join(this.workersDir, file), 'utf-8');
      const config = this.parseWorkerMarkdown(workerName, content);
      
      this.manifest.workers.set(workerName.toLowerCase(), config);
      
      if (config.relationship) {
        const related = this.parseRelationships(config.relationship);
        this.manifest.relationships.set(workerName.toLowerCase(), related);
      }
    }

    console.log(`[Workers] Loaded ${this.manifest.workers.size} workers from ${this.workersDir}`);
  }

  private parseWorkerMarkdown(name: string, content: string): WorkerConfig {
    const config: WorkerConfig = {
      name,
      role: '',
      soul: '',
      relationship: '',
      instructions: '',
    };

    const lines = content.split('\n');
    let currentSection = '';
    let sectionContent: string[] = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        this.saveSection(config, currentSection, sectionContent.join('\n'));
        currentSection = line.replace('## ', '').toLowerCase();
        sectionContent = [];
      } else if (line.startsWith('# ')) {
        config.name = line.replace('# Worker: ', '').trim();
      } else {
        sectionContent.push(line);
      }
    }

    this.saveSection(config, currentSection, sectionContent.join('\n'));
    return config;
  }

  private saveSection(config: WorkerConfig, section: string, content: string): void {
    const trimmed = content.trim();
    if (!trimmed) return;

    switch (section) {
      case 'role':
        config.role = trimmed;
        break;
      case 'soul':
        config.soul = trimmed;
        break;
      case 'relationship':
        config.relationship = trimmed;
        break;
      case 'instructions':
        config.instructions = trimmed;
        break;
    }
  }

  private parseRelationships(relationship: string): string[] {
    const matches = relationship.match(/(?:leads|receives|reviews|interacts with)\s+(\w+)/gi);
    if (!matches) return [];
    
    return matches.map(m => {
      const name = m.split(/\s+/).pop()?.toLowerCase() || '';
      return name;
    }).filter(Boolean);
  }

  getWorker(name: string): WorkerConfig | undefined {
    return this.manifest.workers.get(name.toLowerCase());
  }

  getWorkerConfig(name: string): WorkerJsonConfig | undefined {
    return this.manifest.workerConfigs.get(name.toLowerCase());
  }

  getAllWorkers(): WorkerConfig[] {
    return Array.from(this.manifest.workers.values());
  }

  getWorkerNames(): string[] {
    return Array.from(this.manifest.workers.keys());
  }

  getRelatedWorkers(name: string): string[] {
    return this.manifest.relationships.get(name.toLowerCase()) || [];
  }

  buildWorkerPrompt(workerName: string, task: string): string {
    const worker = this.getWorker(workerName.toLowerCase());
    if (!worker) {
      return task;
    }

    const parts = [
      `# Worker: ${worker.name}`,
      `## Role`,
      worker.role,
      `## Personality`,
      worker.soul,
      `## Instructions`,
      worker.instructions,
      `## Task`,
      task,
    ];

    return parts.join('\n\n');
  }

  getWorkerCodingAgent(workerName: string): string {
    const config = this.getWorkerConfig(workerName.toLowerCase());
    return config?.codingAgent || 'claude-code';
  }

  getWorkerModel(workerName: string): string {
    const config = this.getWorkerConfig(workerName.toLowerCase());
    return config?.model || 'claude-sonnet-4-20250514';
  }

  listWorkers(): string {
    const workers = this.getAllWorkers();
    if (workers.length === 0) {
      return 'No workers configured. Add markdown files to the workspace workers/ folder.';
    }

    return workers.map(w => {
      const config = this.getWorkerConfig(w.name);
      const agent = config?.codingAgent || 'claude-code';
      const model = config?.model || 'unknown';
      return `• **${w.name}** - ${w.role} (${agent}/${model})`;
    }).join('\n');
  }
}
