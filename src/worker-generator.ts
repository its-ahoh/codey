import * as fs from 'fs';
import * as path from 'path';
import { AgentFactory } from './agents';
import { CodingAgent, ModelConfig } from '@codey/core';
import { WorkerManager } from './workers';

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
  codingAgent: 'claude-code' | 'opencode' | 'codex';
  model: string;
  tools: string[];
}

const SCHEMA_INSTRUCTION = `You are generating a Codey worker definition. Given a user description, return ONE JSON object and nothing else, matching this exact schema:

{
  "name": "lowercase-kebab-case",
  "role": "one or two sentences describing what this worker does",
  "soul": "two to four sentences describing the worker's personality and working style",
  "instructions": "numbered or bulleted steps the worker follows when given a task",
  "codingAgent": "claude-code" | "opencode" | "codex",
  "model": "a model id like claude-opus-4-6 or claude-sonnet-4-6",
  "tools": ["array", "of", "tool-tokens"]
}

Rules:
- name must match /^[a-z][a-z0-9-]*$/ and NOT be one of: architect, executor (unless the user explicitly asks to replace one — then confirm by echoing it in name).
- Output ONLY the JSON object. No markdown fences, no prose before or after.
- If the user's description is ambiguous, make reasonable defaults.`;

function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

function tryParse(raw: string): GeneratedWorker | null {
  try { return JSON.parse(stripCodeFences(raw)); } catch { return null; }
}

function validate(g: GeneratedWorker | null): string | null {
  if (!g) return 'Response was not valid JSON';
  if (!/^[a-z][a-z0-9-]*$/.test(g.name || '')) return `name "${g.name}" is not a valid lowercase-kebab-case identifier`;
  if (!['claude-code', 'opencode', 'codex'].includes(g.codingAgent)) return `codingAgent "${g.codingAgent}" is invalid`;
  if (!g.model || typeof g.model !== 'string') return 'model must be a non-empty string';
  if (!Array.isArray(g.tools)) return 'tools must be an array';
  if (!g.role || !g.soul || !g.instructions) return 'role, soul, and instructions are all required';
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await deps.agentFactory.run(deps.activeAgent, {
      prompt: attempt === 0 ? composed : `${composed}\n\nReminder: return ONLY the JSON object. No prose, no code fences.`,
      agent: deps.activeAgent,
      model: deps.activeModel,
      interactive: false,
      context: { workingDir: deps.workingDir },
    });

    if (!response.success) return { ok: false, status: 502, error: `Agent failed: ${response.error}` };
    lastRaw = response.output;

    const parsed = tryParse(response.output);
    const err = validate(parsed);
    if (!err && parsed) {
      if (fs.existsSync(path.join(deps.workersDir, parsed.name))) {
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

  return { ok: false, status: 500, error: 'Agent returned unparseable output after 2 attempts', raw: lastRaw };
}
