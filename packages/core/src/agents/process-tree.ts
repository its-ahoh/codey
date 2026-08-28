import { ChildProcess, SpawnOptions, spawn } from 'child_process';

/**
 * Codey owns every process started for an agent turn. On POSIX, putting the
 * CLI in its own process group lets timeout/abort/dispose terminate tools it
 * spawned as well as the CLI itself. Windows uses taskkill /T for the same
 * process-tree semantics.
 */
export function agentSpawnOptions(): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
  return process.platform === 'win32'
    ? { windowsHide: true }
    : { detached: true };
}

export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  const pid = child.pid;
  if (!pid) return;

  if (signal === 'SIGTERM') {
    const forceTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.unref();
        } catch { /* process tree is already gone */ }
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* process group is already gone */ }
      }
    }, 1_500);
    forceTimer.unref?.();
  }

  if (process.platform === 'win32') {
    try {
      const args = ['/PID', String(pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct-child fallback below.
    }
  } else {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process may have exited before its group was established. A
      // direct kill is still better than leaving it alive.
    }
  }

  try { child.kill(signal); } catch { /* already exited */ }
}

/** Clean up descendants that outlived a normally exited CLI. On POSIX the
 * process-group id remains addressable while any member is still alive. */
export function cleanupProcessTreeAfterClose(child: Pick<ChildProcess, 'pid' | 'kill'>): void {
  if (process.platform === 'win32') return;
  terminateProcessTree(child);
}

const FOREGROUND_POLICY = [
  '<codey-runtime-policy>',
  'Run every command and delegated task in the foreground and wait for it to finish.',
  'Do not detach work with run_in_background/background-task options, shell &, nohup, disown, setsid, tmux, or screen.',
  '</codey-runtime-policy>',
].join('\n');

/** Advisory guard for detach mechanisms that can deliberately escape a
 * process group. The hard lifecycle boundary remains terminateProcessTree.
 *
 * Doubles as the single choke point for the argv size cap (see
 * `capPromptForArgv`): every adapter routes its prompt through here, and the
 * policy block is appended after the cap so it can never be the part elided. */
export function withForegroundPolicy(prompt: string): string {
  const suffix = `\n\n${FOREGROUND_POLICY}`;
  const capped = capPromptForArgv(prompt, maxPromptBytes() - Buffer.byteLength(suffix, 'utf8'));
  return `${capped}${suffix}`;
}

/**
 * Every adapter hands the prompt to the CLI as a command-line argument, so the
 * whole prompt has to fit inside the OS argv limit (`ARG_MAX`, 1 MiB on macOS
 * and Linux, shared with the environment block). Overshooting is not a graceful
 * degradation: `spawn` fails with `E2BIG` and the agent never starts.
 *
 * Callers bound their own prompts (windowed history, transcript pointers), but
 * a single pasted log or a runaway worker hand-off can still blow past the
 * limit. This is the last line of defence, applied at the spawn boundary so no
 * adapter can forget it.
 */
export const DEFAULT_MAX_PROMPT_BYTES = 512_000;

/** Bytes reserved for the elision marker itself. */
const ELISION_RESERVE = 200;

/** Fraction of the surviving budget given to the head; the tail keeps the rest
 *  because the actual request lives at the end of every prompt we build. */
const HEAD_SHARE = 0.35;

export function maxPromptBytes(): number {
  const raw = Number(process.env.CODEY_MAX_PROMPT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROMPT_BYTES;
}

/** Longest prefix of `text` that fits in `maxBytes`, never splitting a
 *  multi-byte UTF-8 sequence. */
function headBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Longest suffix of `text` that fits in `maxBytes`, never splitting a
 *  multi-byte UTF-8 sequence. */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/**
 * Drop the middle of an oversized prompt, keeping a head for the framing and a
 * larger tail for the actual request. Returns `prompt` untouched when it fits.
 */
export function capPromptForArgv(prompt: string, maxBytes = maxPromptBytes()): string {
  const size = Buffer.byteLength(prompt, 'utf8');
  if (size <= maxBytes) return prompt;

  const budget = Math.max(0, maxBytes - ELISION_RESERVE);
  const headBudget = Math.floor(budget * HEAD_SHARE);
  const head = headBytes(prompt, headBudget);
  const tail = tailBytes(prompt, budget - Buffer.byteLength(head, 'utf8'));
  const omitted = size - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');

  return `${head}\n\n[… ${omitted} bytes elided by Codey — the prompt exceeded the ${maxBytes}-byte command-line limit …]\n\n${tail}`;
}
