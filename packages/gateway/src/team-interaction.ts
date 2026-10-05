import { parseAskUser, type AgentResponse } from '@codey/core';

/** Adapt native agent interactions to the existing team pause/resume protocol.
 * A successful response here means the turn was handled, not the task completed.
 * Permission grants still go through the application's permission controls.
 */
export function teamInteractionResponse(response: AgentResponse): AgentResponse {
  const denials = response.permissionDenials?.filter(d => d.toolName !== 'AskUserQuestion');
  const oneLine = (text: string) => text.replace(/[\r\n|]+/g, ' ').trim();
  if (denials?.length) {
    const tools = [...new Set(denials.map(d => oneLine(d.toolName)))].join(', ');
    const question = `Permission required for: ${tools}. Review the permission controls, then reply to retry or give another instruction.`;
    // Put the permission question first so another marker cannot mask the block.
    return { ...response, success: true, output: `[ASK_USER]: ${question}\n\n${response.output}` };
  }
  if (!response.userQuestion || parseAskUser(response.output)) return response;
  const question = oneLine(response.userQuestion.question);
  if (!question) return response;
  const options = response.userQuestion.options.map(o => oneLine(o.label)).filter(Boolean);
  const marker = options.length >= 2
    ? `[ASK_USER:choice]: ${question} | ${options.join(' | ')}`
    : `[ASK_USER]: ${question}`;
  return { ...response, success: true, output: `${response.output}\n\n${marker}` };
}
