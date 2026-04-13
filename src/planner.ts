/**
 * Task Planner
 *
 * A lightweight planning layer that sits between user input and agent dispatch.
 * Uses an LLM call (via raw HTTP to Anthropic API) to decompose complex tasks
 * into subtasks, then executes them sequentially through the CLI agent,
 * reporting progress back to the user at each step.
 *
 * This is agent-agnostic — the planner decides WHAT to do; the agent adapter
 * decides HOW to do it.
 */
import { AgentResponse, CodingAgent, ModelConfig, StatusUpdate } from './types';
import { Logger } from './logger';
import { formatBytes } from './utils/format';

// ── Types ──────────────────────────────────────────────────────────

export interface PlanStep {
  id: number;
  title: string;
  prompt: string;
  /** Whether this step depends on the output of a previous step */
  dependsOn?: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output?: string;
  error?: string;
  duration?: number;
  /** Approximate token usage (in bytes) for this step */
  tokenBytes?: number;
}

export interface TaskPlan {
  originalPrompt: string;
  analysis: string;
  steps: PlanStep[];
  createdAt: number;
  /** Whether the planner decided this task needs decomposition at all */
  needsPlanning: boolean;
}

export interface PlannerConfig {
  /** Anthropic API key for the planning LLM call */
  apiKey?: string;
  /** Model to use for planning (default: claude-sonnet-4-20250514) */
  plannerModel: string;
  /** Max tokens for the planning response */
  maxPlanTokens: number;
  /** Minimum prompt length to consider planning (very short prompts skip planning) */
  minPromptLength: number;
  /** Whether planning is enabled at all */
  enabled: boolean;
}

const DEFAULT_CONFIG: PlannerConfig = {
  plannerModel: 'claude-sonnet-4-20250514',
  maxPlanTokens: 1500,
  minPromptLength: 80,
  enabled: true,
};

// ── Planning prompt ────────────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `You are a task planner for a coding assistant gateway. Your job is to analyze a user's request and decide whether it needs to be broken into subtasks.

IMPORTANT RULES:
1. Most requests do NOT need planning. Simple questions, single-file changes, quick fixes, explanations — these should NOT be decomposed.
2. Only decompose tasks that are genuinely multi-step: "build a REST API with auth, database, and tests", "refactor the payment module and update all callers", etc.
3. Each step must be a self-contained prompt that a coding agent can execute independently.
4. Steps should be ordered so earlier outputs feed into later steps where needed.
5. Keep it to 2-5 steps maximum. If you need more, the task is too vague and should be clarified.

Respond in this EXACT JSON format:
{
  "needs_planning": true/false,
  "analysis": "One sentence explaining your decision",
  "steps": [
    {
      "title": "Short step title",
      "prompt": "Full prompt to send to the coding agent for this step",
      "depends_on": null or step number (1-indexed)
    }
  ]
}

If needs_planning is false, return empty steps array.`;

// ── Planner ────────────────────────────────────────────────────────

export class TaskPlanner {
  private config: PlannerConfig;
  private logger: Logger;

  constructor(config?: Partial<PlannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = Logger.getInstance();
  }

  updateConfig(config: Partial<PlannerConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Analyze a prompt and create a plan.
   * Returns null if planning is disabled or the task doesn't need decomposition.
   */
  async plan(prompt: string, contextSummary?: string): Promise<TaskPlan | null> {
    if (!this.config.enabled) return null;
    if (prompt.length < this.config.minPromptLength) return null;

    // Quick heuristic check: skip planning for obvious single-step tasks
    if (this.isSimpleTask(prompt)) return null;

    // Need an API key to call the planner LLM
    const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.logger.debug('[planner] No API key available, skipping planning');
      return null;
    }

    try {
      const plan = await this.callPlannerLLM(prompt, contextSummary, apiKey);
      return plan;
    } catch (error) {
      this.logger.error(`[planner] Planning failed: ${error}`);
      return null; // Graceful degradation — just run the task directly
    }
  }

  /**
   * Execute a plan step by step, calling the agent for each step.
   * Returns progress updates via the onProgress callback.
   */
  async executePlan(
    plan: TaskPlan,
    runAgent: (prompt: string) => Promise<AgentResponse>,
    onProgress: (step: PlanStep, stepIndex: number, totalSteps: number) => Promise<void>,
  ): Promise<{ success: boolean; outputs: string[]; plan: TaskPlan }> {
    const outputs: string[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      step.status = 'running';

      await onProgress(step, i, plan.steps.length);

      // Build the step prompt, injecting previous step output if this step depends on one
      let stepPrompt = step.prompt;
      if (step.dependsOn && step.dependsOn > 0 && step.dependsOn <= i) {
        const depOutput = plan.steps[step.dependsOn - 1].output;
        if (depOutput) {
          stepPrompt = `Context from previous step:\n${depOutput.substring(0, 2000)}\n\n${stepPrompt}`;
        }
      }

      const startTime = Date.now();

      try {
        const response = await runAgent(stepPrompt);
        step.duration = Math.round((Date.now() - startTime) / 1000);

        if (response.success) {
          step.status = 'done';
          step.output = response.output;
          outputs.push(response.output);
        } else {
          step.status = 'failed';
          step.error = response.error || 'Agent returned failure';
          outputs.push(`[FAILED] ${step.error}`);

          // Don't skip remaining steps — they might be independent
          // But mark dependent steps as skipped
          for (let j = i + 1; j < plan.steps.length; j++) {
            if (plan.steps[j].dependsOn === i + 1) {
              plan.steps[j].status = 'skipped';
            }
          }
        }
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : 'Unknown error';
        step.duration = Math.round((Date.now() - startTime) / 1000);
        outputs.push(`[ERROR] ${step.error}`);
      }

      await onProgress(step, i, plan.steps.length);
    }

    const allDone = plan.steps.every(s => s.status === 'done' || s.status === 'skipped');
    return { success: allDone, outputs, plan };
  }

  // ── Heuristics ─────────────────────────────────────────────────

  /**
   * Quick check for tasks that obviously don't need planning.
   */
  private isSimpleTask(prompt: string): boolean {
    const lower = prompt.toLowerCase();

    // Questions / explanations
    if (lower.startsWith('what ') || lower.startsWith('how ') ||
        lower.startsWith('why ') || lower.startsWith('explain ') ||
        lower.startsWith('show ') || lower.startsWith('list ')) {
      return true;
    }

    // Single-action verbs without "and" connectors
    const hasMultipleActions = /\band\b.*\band\b/i.test(prompt) ||
      /\bthen\b/i.test(prompt) ||
      /\bfirst\b.*\bthen\b/i.test(prompt) ||
      /\bstep\s*\d/i.test(prompt);

    if (!hasMultipleActions && prompt.length < 200) {
      return true;
    }

    return false;
  }

  // ── LLM call ───────────────────────────────────────────────────

  private async callPlannerLLM(
    prompt: string,
    contextSummary: string | undefined,
    apiKey: string,
  ): Promise<TaskPlan | null> {
    const userMessage = contextSummary
      ? `Project context:\n${contextSummary}\n\nUser request:\n${prompt}`
      : `User request:\n${prompt}`;

    // Use undici (already a dependency) for the HTTP call
    const { request } = require('undici');

    const body = JSON.stringify({
      model: this.config.plannerModel,
      max_tokens: this.config.maxPlanTokens,
      system: PLANNING_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
      ],
    });

    this.logger.debug(`[planner] Calling ${this.config.plannerModel} for task analysis`);

    const response = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    if (response.statusCode !== 200) {
      const errorBody = await response.body.text();
      throw new Error(`Anthropic API returned ${response.statusCode}: ${errorBody}`);
    }

    const data = await response.body.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((c: { type: string }) => c.type === 'text');
    if (!textBlock?.text) {
      throw new Error('No text in planner response');
    }

    // Parse JSON from the response (may be wrapped in markdown code blocks)
    const jsonText = textBlock.text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(jsonText) as {
      needs_planning: boolean;
      analysis: string;
      steps: Array<{
        title: string;
        prompt: string;
        depends_on?: number | null;
      }>;
    };

    if (!parsed.needs_planning || !parsed.steps || parsed.steps.length === 0) {
      this.logger.debug(`[planner] Task does not need planning: ${parsed.analysis}`);
      return {
        originalPrompt: prompt,
        analysis: parsed.analysis,
        steps: [],
        createdAt: Date.now(),
        needsPlanning: false,
      };
    }

    // Convert to our PlanStep format
    const steps: PlanStep[] = parsed.steps.map((s, i) => ({
      id: i + 1,
      title: s.title,
      prompt: s.prompt,
      dependsOn: s.depends_on || undefined,
      status: 'pending' as const,
    }));

    this.logger.info(`[planner] Created plan with ${steps.length} steps: ${parsed.analysis}`);

    return {
      originalPrompt: prompt,
      analysis: parsed.analysis,
      steps,
      createdAt: Date.now(),
      needsPlanning: true,
    };
  }

  // ── Format plan for display ────────────────────────────────────

  static formatPlanSummary(plan: TaskPlan): string {
    const lines: string[] = [
      `Plan: ${plan.analysis}`,
      '',
    ];

    let totalTokenBytes = 0;

    for (const step of plan.steps) {
      const statusIcon = step.status === 'done' ? '\u2705'
        : step.status === 'running' ? '\u23f3'
        : step.status === 'failed' ? '\u274c'
        : step.status === 'skipped' ? '\u23ed\ufe0f'
        : '\u2b55';
      const duration = step.duration ? ` (${step.duration}s)` : '';
      const tokens = step.tokenBytes ? ` [${formatBytes(step.tokenBytes)}]` : '';
      if (step.tokenBytes) totalTokenBytes += step.tokenBytes;
      lines.push(`${statusIcon} Step ${step.id}: ${step.title}${duration}${tokens}`);
    }

    if (totalTokenBytes > 0) {
      lines.push('');
      lines.push(`Total tokens: ${formatBytes(totalTokenBytes)}`);
    }

    return lines.join('\n');
  }

  static formatStepProgress(step: PlanStep, stepIndex: number, totalSteps: number): string {
    if (step.status === 'running') {
      return `\u23f3 Step ${stepIndex + 1}/${totalSteps}: **${step.title}**\nWorking...`;
    }
    if (step.status === 'done') {
      const duration = step.duration ? ` (${step.duration}s)` : '';
      const tokens = step.tokenBytes ? ` [${formatBytes(step.tokenBytes)}]` : '';
      return `\u2705 Step ${stepIndex + 1}/${totalSteps}: **${step.title}**${duration}${tokens}`;
    }
    if (step.status === 'failed') {
      return `\u274c Step ${stepIndex + 1}/${totalSteps}: **${step.title}**\nError: ${step.error}`;
    }
    return `Step ${stepIndex + 1}/${totalSteps}: ${step.title}`;
  }
}
