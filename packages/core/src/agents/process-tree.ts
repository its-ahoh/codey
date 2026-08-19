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
 * process group. The hard lifecycle boundary remains terminateProcessTree. */
export function withForegroundPolicy(prompt: string): string {
  return `${prompt}\n\n${FOREGROUND_POLICY}`;
}
