/**
 * Deterministic phrase matching for voice control ("switch to workspace X",
 * "what are my notifications"). Anything that doesn't match a known phrase
 * falls through to normal conversation — misclassifying a command as chat is
 * cheap, misclassifying chat as a command silently drops what the user said.
 */

export type VoiceCommand =
  | { type: 'switch-workspace'; workspace: string }
  | { type: 'list-notifications' }
  | { type: 'list-workspaces' };

interface Pattern {
  regex: RegExp;
  build: (match: RegExpMatchArray) => VoiceCommand;
}

const PATTERNS: Pattern[] = [
  {
    regex: /^(?:switch|change|go)\s+(?:to\s+)?(?:the\s+)?workspace\s+(.+)$/i,
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:what(?:'s| is|s)?\s+my\s+notifications?|(?:list|show|check)\s+(?:my\s+)?notifications?)$/i,
    build: () => ({ type: 'list-notifications' }),
  },
  {
    regex: /^(?:list|show)\s+(?:my\s+)?workspaces$/i,
    build: () => ({ type: 'list-workspaces' }),
  },
  // Chinese variants — matched against a whitespace-stripped utterance since
  // spoken Chinese transcripts carry no word spacing.
  // Suffix-first: 切换到工作区codey / 切换到workspace codey
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?(?:工作区|工作空间)(.+)$/,
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?workspace(.+)$/i,
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  // Name-first: 切换到codey工作区 / 切换到codey workspace
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?(.+?)(?:工作区|工作空间)$/,
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?(.+?)workspace$/i,
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:(?:查看|获取|检查)?(?:我的)?通知(?:有哪些|是什么)?|通知)$/,
    build: () => ({ type: 'list-notifications' }),
  },
  {
    regex: /^(?:列出|显示|查看)(?:我的)?(?:所有)?(?:工作区|工作空间)(?:列表)?$/,
    build: () => ({ type: 'list-workspaces' }),
  },
];

/**
 * Matches a transcribed voice utterance against the known command
 * whitelist. Returns null when nothing matches, meaning the caller should
 * treat the utterance as a normal conversational message.
 */
export function parseVoiceCommand(utterance: string): VoiceCommand | null {
  const trimmed = utterance
    .trim()
    .replace(/[.!?。!?，,]+$/, '')
    .trim();
  if (!trimmed) return null;
  const noSpace = trimmed.replace(/\s+/g, '');
  for (const pattern of PATTERNS) {
    const match = noSpace.match(pattern.regex);
    if (match) return pattern.build(match);
  }
  for (const pattern of PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) return pattern.build(match);
  }
  return null;
}
