// packages/gateway/src/automations/run-log.ts
//
// Formats ChatStreamEvents into the per-run activity-log lines persisted at
// automation-runs/<automationId>/<runId>.log. Token-level events (stream,
// thinking) return null — one token per event, redundant with the run's
// persisted final output.
import type { ChatStreamEvent } from '../chat-runner';

/** Per-event payload cap (tool input JSON, tool output, messages). */
export const EVENT_PAYLOAD_CAP = 2_000;

function cap(s: string): string {
  if (s.length <= EVENT_PAYLOAD_CAP) return s;
  return `${s.slice(0, EVENT_PAYLOAD_CAP)}… [truncated]`;
}

/** Multi-line payloads collapse to one log line each. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ');
}

export function formatRunLogEvent(e: ChatStreamEvent, now: number): string | null {
  const t = new Date(now).toISOString();
  switch (e.type) {
    case 'tool_start': {
      const input = e.input ? ` ${cap(oneLine(JSON.stringify(e.input)))}` : '';
      return `[${t}] tool_start ${e.tool ?? '?'}${input}`;
    }
    case 'tool_end': {
      const output = e.output ? ` → ${cap(oneLine(e.output))}` : '';
      return `[${t}] tool_end ${e.tool ?? '?'}${output}`;
    }
    case 'team_start':
      return `[${t}] team_start ${e.teamName} (${e.mode})`;
    case 'worker_start': {
      const agent = e.agent ? ` [${e.agent}${e.model ? `/${e.model}` : ''}]` : '';
      const reason = e.reason ? ` — ${cap(oneLine(e.reason))}` : '';
      return `[${t}] worker_start #${e.step} ${e.worker}${agent}${reason}`;
    }
    case 'worker_end': {
      const duration = e.durationSec != null ? ` (${e.durationSec}s)` : '';
      const tokens = e.tokens != null ? ` ${e.tokens} tokens` : '';
      return `[${t}] worker_end #${e.step} ${e.status}${duration}${tokens}`;
    }
    case 'info':
      return `[${t}] info ${cap(oneLine(e.message))}`;
    case 'error':
      return `[${t}] error ${cap(oneLine(e.message))}`;
    case 'permission_denials':
      return `[${t}] permission_denied ${e.denials.map(d => d.toolName).join(', ')}`;
    case 'queued':
      return `[${t}] queued position=${e.position}`;
    case 'stopped':
      return `[${t}] stopped`;
    case 'done': {
      const parts = [
        e.agent ? `agent=${e.agent}` : '',
        e.model ? `model=${e.model}` : '',
        e.tokens != null ? `tokens=${e.tokens}` : '',
        e.durationSec != null ? `duration=${e.durationSec}s` : '',
      ].filter(Boolean).join(' ');
      return `[${t}] done${parts ? ` ${parts}` : ''}`;
    }
    default:
      return null; // stream, thinking
  }
}
