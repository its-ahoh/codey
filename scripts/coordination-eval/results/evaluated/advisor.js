"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAdvisorPrompt = buildAdvisorPrompt;
exports.extractJsonObject = extractJsonObject;
exports.runAdvisor = runAdvisor;
const advisor_personality_1 = require("./advisor-personality");
const run_1 = require("./utils/run");
const DEFAULT_TIMEOUT_MS = 30000;
function buildAdvisorPrompt(input) {
    const lines = [];
    lines.push('# Advisor');
    lines.push('## Role');
    lines.push(advisor_personality_1.ADVISOR_PERSONALITY.role);
    lines.push('## Instructions');
    lines.push(advisor_personality_1.ADVISOR_PERSONALITY.instructions);
    lines.push('## Task');
    lines.push(input.task);
    lines.push('## Roster');
    for (const m of input.members) {
        lines.push(`- ${m.name}: ${m.hint || '(no description)'}`);
    }
    lines.push('## History');
    if (input.history.length === 0) {
        lines.push('(empty — this is the first turn)');
    }
    else {
        input.history.forEach((h, i) => {
            lines.push(`${i + 1}. ${h.bot}: ${h.summary}`);
        });
    }
    lines.push('## Last Output');
    if (input.lastBot && input.lastOutput) {
        lines.push(`Bot: ${input.lastBot}`);
        lines.push('Output:');
        lines.push(input.lastOutput);
    }
    else {
        lines.push('(none — first turn)');
    }
    if (input.userClarification) {
        const u = input.userClarification;
        lines.push('## User Clarification');
        lines.push(`Bot ${u.bot} asked: ${u.question}`);
        lines.push(`User answered: ${u.answer}`);
    }
    if (input.pendingQuestion) {
        const q = input.pendingQuestion;
        lines.push('## Pending Question');
        lines.push(`Bot ${q.bot} asked: ${q.question}`);
        lines.push('Decide one of: (a) route this to a teammate from the Roster who can answer — set `next` to that teammate and put the question in `instruction`; or (b) escalate to the user — set `escalate_to_user: true` and `done: true` with no `next`. Prefer (a) when a teammate plausibly has the answer.');
    }
    if (input.finalize) {
        lines.push('## Finalize');
        lines.push('FINALIZE=true. Return only done:true with a final_summary; do not pick a next bot.');
    }
    return lines.join('\n\n');
}
/**
 * Extract the first balanced {...} object from a string and JSON.parse it.
 * Tolerates leading/trailing prose, markdown fences, and nested objects.
 */
function extractJsonObject(text) {
    if (!text)
        return null;
    const start = text.indexOf('{');
    if (start < 0)
        return null;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === '\\') {
                escape = true;
                continue;
            }
            if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === '{')
            depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                const slice = text.slice(start, i + 1);
                try {
                    return JSON.parse(slice);
                }
                catch {
                    return null;
                }
            }
        }
    }
    return null;
}
function fallback(reason) {
    return {
        summary_of_last: '',
        next: null,
        instruction: '',
        reason: '',
        done: false,
        fallback: true,
        fallbackReason: reason,
    };
}
async function runAdvisor(input, opts) {
    if (input.members.length === 0) {
        return {
            summary_of_last: '',
            next: null,
            instruction: '',
            reason: '',
            done: true,
            final_summary: '',
            fallback: false,
        };
    }
    const prompt = buildAdvisorPrompt(input);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let response;
    try {
        response = await (0, run_1.runWithTimeout)(timeoutMs, opts.signal, signal => opts.runner({
            prompt,
            agent: opts.agent,
            model: opts.model,
            signal,
        }));
    }
    catch (err) {
        return fallback(`runner threw: ${err.message}`);
    }
    if (!response.success) {
        return fallback(response.error || 'runner returned non-success');
    }
    const obj = extractJsonObject(response.output);
    if (!obj)
        return fallback('no JSON object in advisor output');
    const summary_of_last = typeof obj.summary_of_last === 'string' ? obj.summary_of_last : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    const instruction = typeof obj.instruction === 'string' ? obj.instruction : '';
    const done = obj.done === true;
    const final_summary = typeof obj.final_summary === 'string' ? obj.final_summary : undefined;
    const escalateToUser = obj.escalate_to_user === true;
    let next = null;
    if (obj.next === null || obj.next === undefined) {
        next = null;
    }
    else if (typeof obj.next === 'string' && obj.next.trim().length > 0) {
        next = obj.next.trim();
    }
    else {
        return fallback('next is not a string or null');
    }
    if (next !== null) {
        const known = new Set(input.members.map(m => m.name));
        if (!known.has(next))
            return fallback(`next "${next}" is not in roster`);
    }
    if (input.finalize) {
        return {
            summary_of_last,
            next: null,
            instruction: '',
            reason,
            done: true,
            final_summary: final_summary ?? '',
            fallback: false,
        };
    }
    // When the Advisor is arbitrating a pending question, escalate_to_user is a
    // valid resolution: done=true, no next, and we surface the question to the user.
    if (input.pendingQuestion && escalateToUser) {
        return {
            summary_of_last,
            next: null,
            instruction: '',
            reason,
            done: true,
            final_summary,
            fallback: false,
            escalateToUser: true,
        };
    }
    if (!done && next === null) {
        return fallback('next is null but done is false');
    }
    if (done && next !== null) {
        // Treat done:true as authoritative; ignore next.
        return {
            summary_of_last,
            next: null,
            instruction: '',
            reason,
            done: true,
            final_summary: final_summary ?? '',
            fallback: false,
        };
    }
    return {
        summary_of_last,
        next,
        instruction: next !== null ? instruction : '',
        reason,
        done,
        final_summary,
        fallback: false,
    };
}
//# sourceMappingURL=advisor.js.map