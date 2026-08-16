/** Strip a single markdown code fence (optionally ```json) from an LLM
 *  response. Returns the fenced content trimmed, or the input trimmed when
 *  no fence is present. */
export function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}
