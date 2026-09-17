import * as fs from 'fs';
import * as path from 'path';
import { AgentFactory } from './agents';
import { CODING_AGENTS } from './types';
import type { CodingAgent, ModelConfig } from './types';
import { WorkerManager } from './workers';
import { stripCodeFences } from './utils/json';

export interface GenerateDeps {
  agentFactory: AgentFactory;
  workerManager: WorkerManager;
  workersDir: string;
  activeAgent: CodingAgent;
  activeModel: ModelConfig;
  workingDir: string;
}

interface GeneratedWorker {
  name: string;
  role: string;
  soul: string;
  instructions: string;
  codingAgent: CodingAgent;
  model: string;
  tools: string[];
}

const SCHEMA_INSTRUCTION = `You are generating a Codey worker definition. Given a user description, return ONE JSON object and nothing else, matching this exact schema:

{
  "name": "lowercase-kebab-case",
  "role": "one or two sentences describing what this worker does",
  "soul": "two to four sentences describing the worker's personality and working style",
  "instructions": "numbered or bulleted steps the worker follows when given a task",
  "codingAgent": "claude-code" | "opencode" | "codex" | "pi",
  "model": "a model id like claude-opus-4-6 or claude-sonnet-4-6",
  "tools": ["array", "of", "tool-tokens"]
}

Rules:
- role, soul, and instructions must be non-empty strings. Write instruction steps inside one string, separated by newline characters; do not return an array or object.
- name must match /^[a-z][a-z0-9-]*$/ and NOT be one of: architect, executor (unless the user explicitly asks to replace one — then confirm by echoing it in name).
- Output ONLY the JSON object. No markdown fences, no prose before or after.
- If the user's description is ambiguous, make reasonable defaults.`;

function tryParse(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(stripCodeFences(raw));
    // Some models express the requested steps as a list instead of a string.
    // Preserve that useful content, but never stringify arbitrary objects.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.instructions) && record.instructions.every(step => typeof step === 'string')) {
        record.instructions = record.instructions.map(step => step.trim()).filter(Boolean).map(step => `- ${step}`).join('\n');
      }
    }
    return value;
  } catch { return null; }
}

function validate(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Response must be a JSON object';
  const g = value as Record<string, unknown>;
  if (typeof g.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(g.name)) return 'name must be a lowercase-kebab-case identifier';
  if (!CODING_AGENTS.includes(g.codingAgent as CodingAgent)) return 'codingAgent is invalid';
  for (const field of ['model', 'role', 'soul', 'instructions']) {
    if (typeof g[field] !== 'string' || !g[field].trim()) return `${field} must be a non-empty string`;
  }
  if (!Array.isArray(g.tools) || !g.tools.every(tool => typeof tool === 'string' && tool.trim())) return 'tools must be an array of non-empty strings';
  return null;
}

function assembleMd(g: GeneratedWorker): string {
  return [
    `# Worker: ${g.name}`,
    '',
    '## Role',
    g.role.trim(),
    '',
    '## Soul',
    g.soul.trim(),
    '',
    '## Instructions',
    g.instructions.trim(),
    '',
  ].join('\n');
}

export async function generateWorker(
  deps: GenerateDeps,
  userPrompt: string,
): Promise<{ ok: true; worker: GeneratedWorker } | { ok: false; status: number; error: string; raw?: string }> {
  if (!userPrompt.trim()) return { ok: false, status: 400, error: 'prompt is required' };

  const composed = `${SCHEMA_INSTRUCTION}\n\nUser description:\n${userPrompt.trim()}`;

  let lastRaw = '';
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await deps.agentFactory.run(deps.activeAgent, {
      prompt: attempt === 0 ? composed : `${composed}\n\nThe previous response failed validation: ${lastError}. Correct it and return ONLY the JSON object. No prose, no code fences.`,
      agent: deps.activeAgent,
      model: deps.activeModel,
      interactive: false,
      skipPermissions: true,
      context: { workingDir: deps.workingDir },
    });

    if (!response.success) return { ok: false, status: 502, error: `Agent failed: ${response.error}` };
    lastRaw = response.output;

    const value = tryParse(response.output);
    const err = validate(value);
    lastError = err ?? '';
    if (!err) {
      const parsed = value as GeneratedWorker;
      // Consult the loaded map rather than just `fs.existsSync` on the
      // directory: an orphaned empty `<name>/` (left behind by an interrupted
      // create or a manual edit) wouldn't load as a worker but would still
      // make the disk path exist, falsely blocking re-creation.
      if (deps.workerManager.hasWorker(parsed.name)) {
        return { ok: false, status: 409, error: `Worker "${parsed.name}" already exists` };
      }
      const dir = path.join(deps.workersDir, parsed.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'personality.md'), assembleMd(parsed));
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        codingAgent: parsed.codingAgent,
        model: parsed.model,
        tools: parsed.tools,
      }, null, 2) + '\n');
      await deps.workerManager.loadWorkers();
      return { ok: true, worker: parsed };
    }
  }

  return { ok: false, status: 500, error: `Could not create Bot after 2 attempts: ${lastError}`, raw: lastRaw };
}
