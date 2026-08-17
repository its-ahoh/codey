// packages/gateway/src/automations/sandbox.ts
//
// Per-run automation sandboxes: a chat worktree with a generated name and a
// lifetime of exactly one run. The Git work itself lives in chat-worktree.ts
// and the chat binding in chats.ts; this module owns the lifecycle between
// them, injected as SandboxOps so it is testable without a repository.
import { normalizeWorktreeName } from '../chat-worktree';
import type { ChatWorkspace, DisposableWorktreeOutcome } from '../chat-worktree';

/** Longest automation-name fragment kept in a sandbox worktree name. The rest
 *  of the budget goes to the timestamp and run token, which are what make the
 *  name unique and traceable. */
export const SANDBOX_SLUG_MAX = 24;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Local time, because these names are read by a human scanning
 *  `git worktree list` in their own timezone. */
function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Name for one run's throwaway checkout: `auto-<name>-<when>-<run token>`.
 *
 * The run token is what actually guarantees uniqueness — two automations can
 * share a slug and fire in the same second — and it doubles as the link back
 * to the run whose activity log explains what the checkout was for.
 */
export function sandboxWorktreeName(automationName: string, runId: string, at: number): string {
  const slug = automationName.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SANDBOX_SLUG_MAX);
  const token = runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'run';
  // normalizeWorktreeName also rejects a name that survives as empty — an
  // automation titled entirely in non-ASCII still has the stamp and token.
  return normalizeWorktreeName(`auto-${slug ? `${slug}-` : ''}${stamp(at)}-${token}`);
}

/** Sandbox lifecycle lines share the run log with formatRunLogEvent output,
 *  so they use the same `[iso] <kind> <detail>` shape. */
export function sandboxLogLine(at: number, detail: string): string {
  return `[${new Date(at).toISOString()}] sandbox ${detail}`;
}

/** Everything a sandbox needs from the gateway, so the lifecycle can be
 *  exercised without a repository or a live chat. */
export interface SandboxOps {
  /** Whether the workspace can have worktrees at all. */
  isGitWorkspace: () => Promise<boolean>;
  /** Create the checkout, branched from the workspace's current HEAD. */
  provision: (worktreeName: string) => Promise<ChatWorkspace>;
  /** Point the automation's hidden chat at the checkout. */
  bind: (workspace: ChatWorkspace) => void;
  /** The checkout the chat is currently bound to, if any. */
  current: () => ChatWorkspace | undefined;
  discard: (workspace: ChatWorkspace) => Promise<DisposableWorktreeOutcome>;
  /** Forget a checkout that no longer exists. */
  unbind: () => void;
  log: (detail: string) => void;
  now?: () => number;
}

/**
 * Give one run its own checkout. Every run therefore starts from the latest
 * committed state instead of accumulating on whatever branch the previous run
 * happened to leave behind.
 *
 * A workspace that is not a Git repository has no worktrees to give, and
 * there is nothing the user could do about it from the automation editor:
 * that case degrades to the shared checkout and says so in the run log.
 * Anything else — a name collision, a broken repository — fails the run,
 * because there sandboxing was possible and did not happen.
 */
export async function openSandbox(
  ops: SandboxOps, automationName: string, runId: string,
): Promise<ChatWorkspace | undefined> {
  const at = ops.now ? ops.now() : Date.now();
  if (!await ops.isGitWorkspace()) {
    ops.log('skipped — the workspace is not a Git repository; running in the shared checkout');
    return undefined;
  }
  const workspace = await ops.provision(sandboxWorktreeName(automationName, runId, at));
  ops.bind(workspace);
  ops.log(`created ${workspace.worktreePath} at ${workspace.baseCommit.slice(0, 8)}`);
  return workspace;
}

/** Retire the run's checkout. Best-effort: the run has already produced its
 *  output, so a Git failure is reported in the activity log rather than turned
 *  into a failed run. */
export async function closeSandbox(ops: SandboxOps): Promise<void> {
  const workspace = ops.current();
  if (!workspace) return;
  try {
    const outcome = await ops.discard(workspace);
    if (outcome === 'kept') {
      ops.log(`kept ${workspace.worktreePath} — uncommitted changes were left in place`);
      return;
    }
    // Unbind before the next run: a chat pointing at a deleted directory fails
    // every subsequent turn with "Chat workspace is missing".
    ops.unbind();
    ops.log(outcome === 'branch-kept'
      ? `removed ${workspace.worktreePath}; branch "${workspace.name ?? ''}" kept — it has commits`
      : `removed ${workspace.worktreePath} — no changes`);
  } catch (err) {
    ops.log(`could not remove ${workspace.worktreePath}: ${(err as Error).message}`);
  }
}
