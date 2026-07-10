// packages/core/src/aide-automation.ts
import { AideOptions, runAideJson } from './aide';

/** One clarification question surfaced by the authoring interview. */
export interface InterviewQuestion { id: string; question: string; why?: string }
export interface InterviewAnswer { question: string; answer: string }

const QUESTIONS_PROMPT = (goal: string, targetContext: string) => `You are preparing an UNATTENDED automation. It will run on a schedule with nobody available to answer questions, so every ambiguity must be resolved NOW, at authoring time.

Automation goal:
${goal}

Execution target:
${targetContext}

List the questions you would otherwise need answered mid-run: missing specifics, choices, accounts/handles, formats, limits, and edge cases (e.g. "what if there is nothing to report today?"). Ask only what materially changes the run. 3-7 questions.

Respond with ONLY this JSON:
{"questions":[{"id":"q1","question":"...","why":"one-line reason"}]}`;

const FOLLOWUP_PROMPT = (goal: string, question: string, answer: string) => `An automation is being configured. Goal: ${goal}

You asked: ${question}
The user answered: ${answer}

If — and only if — this answer opens exactly one NEW concrete gap that would block an unattended run, ask one short follow-up. Otherwise return null.

Respond with ONLY this JSON:
{"followup":"..." }  or  {"followup":null}`;

const SYNTHESIS_PROMPT = (goal: string, qa: InterviewAnswer[]) => `Fold this automation goal and the clarification answers into a frozen, fully self-contained instruction brief for an UNATTENDED agent run. The brief must stand alone: no references to "the user said" or to this conversation; include concrete values, edge-case handling, and output expectations.

Additionally surface a SMALL set of knobs a user may want to tweak later (account, count, tone, …) as params. In the brief, write each knob as a {{placeholder}} and put its current value in params.

Goal:
${goal}

Clarifications:
${qa.map(x => `Q: ${x.question}\nA: ${x.answer}`).join('\n')}

Respond with ONLY this JSON:
{"brief":"...","params":{"name":"current value"}}`;

export async function generateAutomationQuestions(
  goal: string, targetContext: string, opts: AideOptions,
): Promise<InterviewQuestion[]> {
  const res = await runAideJson<{ questions?: unknown }>(QUESTIONS_PROMPT(goal, targetContext), opts);
  if (!res || !Array.isArray(res.questions)) return [];
  return (res.questions as Array<Record<string, unknown>>)
    .filter(q => typeof q?.question === 'string' && (q.question as string).trim())
    .map((q, i) => ({
      id: typeof q.id === 'string' ? q.id : `q${i + 1}`,
      question: (q.question as string).trim(),
      why: typeof q.why === 'string' ? q.why : undefined,
    }));
}

export async function generateAutomationFollowup(
  goal: string, question: string, answer: string, opts: AideOptions,
): Promise<string | null> {
  const res = await runAideJson<{ followup?: unknown }>(FOLLOWUP_PROMPT(goal, question, answer), opts);
  return res && typeof res.followup === 'string' && res.followup.trim() ? res.followup.trim() : null;
}

export async function synthesizeAutomationBrief(
  goal: string, qa: InterviewAnswer[], opts: AideOptions,
): Promise<{ brief: string; params: Record<string, string> }> {
  const res = await runAideJson<{ brief?: unknown; params?: unknown }>(SYNTHESIS_PROMPT(goal, qa), opts);
  const brief = res && typeof res.brief === 'string' ? res.brief.trim() : '';
  if (!brief) throw new Error('Aide returned no brief');
  const params: Record<string, string> = {};
  if (res!.params && typeof res!.params === 'object') {
    for (const [k, v] of Object.entries(res!.params as Record<string, unknown>)) {
      if (typeof v === 'string') params[k] = v;
    }
  }
  return { brief, params };
}

/**
 * Resolve {{placeholders}} from params; params without a placeholder are
 * appended as a trailing "Parameters:" block so edits always take effect.
 */
export function renderBrief(brief: string, params: Record<string, string>): string {
  const used = new Set<string>();
  const out = brief.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) { used.add(key); return params[key]; }
    return match;
  });
  const leftovers = Object.entries(params).filter(([k]) => !used.has(k));
  if (leftovers.length === 0) return out;
  return `${out}\n\nParameters:\n${leftovers.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}
