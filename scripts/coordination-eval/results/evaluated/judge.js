"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildJudgePrompt = buildJudgePrompt;
exports.runJudge = runJudge;
const advisor_1 = require("./advisor");
const run_1 = require("./utils/run");
const DEFAULT_TIMEOUT_MS = 30000;
function buildJudgePrompt(input) {
    const lines = [];
    lines.push('# Flow Judge');
    lines.push('## Role');
    lines.push('You route a sequential bot team along a fixed graph. You never write code. ' +
        'Given the bot that just finished, its output, and the list of outgoing edges, ' +
        'choose exactly one edge to follow. Each edge has a natural-language condition; ' +
        'pick the edge whose condition the output best satisfies. If none clearly match, ' +
        'pick the edge marked as the default target.');
    lines.push('## Task');
    lines.push(input.task);
    if (input.blackboardSummary.trim()) {
        lines.push('## Shared notes');
        lines.push(input.blackboardSummary.trim());
    }
    lines.push(`## Bot just finished: ${input.bot}`);
    lines.push('## Bot output');
    lines.push(input.botOutput || '(empty)');
    if (input.question && input.question.trim()) {
        lines.push('## Decision');
        lines.push(`Answer this yes/no question about the latest output, then pick the matching edge: ${input.question.trim()}`);
    }
    lines.push('## Outgoing edges (choose one)');
    for (const e of input.edges) {
        lines.push(`- id="${e.id}" → ${e.targetBot}: ${e.condition ? `if ${e.condition}` : '(default)'}`);
    }
    lines.push('## Output format');
    lines.push('Reply with ONLY a JSON object: {"edge_id":"<one of the ids above>","reason":"<one short sentence>"}');
    return lines.join('\n\n');
}
function fallback(reason) {
    return { edgeId: null, reason: '', fallback: true, fallbackReason: reason };
}
async function runJudge(input, opts) {
    if (input.edges.length === 0)
        return fallback('no outgoing edges');
    if (input.edges.length === 1 && !input.edges[0].condition?.trim() && !input.question?.trim()) {
        return { edgeId: input.edges[0].id, reason: 'Only unconditional route.', fallback: false };
    }
    const prompt = buildJudgePrompt(input);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let response;
    try {
        response = await (0, run_1.runWithTimeout)(timeoutMs, opts.signal, signal => opts.runner({ prompt, agent: opts.agent, model: opts.model, signal }));
    }
    catch (err) {
        return fallback(`runner threw: ${err.message}`);
    }
    if (!response.success)
        return fallback(response.error || 'runner returned non-success');
    const obj = (0, advisor_1.extractJsonObject)(response.output);
    if (!obj || typeof obj.edge_id !== 'string')
        return fallback('could not parse judge JSON');
    const edgeId = obj.edge_id;
    if (!input.edges.some(e => e.id === edgeId))
        return fallback(`judge chose unknown edge "${edgeId}"`);
    return {
        edgeId,
        reason: typeof obj.reason === 'string' ? obj.reason : '',
        fallback: false,
    };
}
//# sourceMappingURL=judge.js.map