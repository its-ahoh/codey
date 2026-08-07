/**
 * Deterministic phrase matching for voice control ("switch to workspace X",
 * "what are my notifications"). Anything that doesn't match a known phrase
 * falls through to normal conversation — misclassifying a command as chat is
 * cheap, misclassifying chat as a command silently drops what the user said.
 */

export type VoiceCommand =
  | { type: 'switch-workspace'; workspace: string }
  | { type: 'list-notifications' }
  | { type: 'list-workspaces' }
  /** Re-speak the last reply undigested. See speech-digest.ts: spoken replies
   *  default to a short summary, and this is how the user asks for the detail
   *  back without the agent re-running. */
  | { type: 'more-detail' };

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
  {
    regex: /^(?:(?:tell|say)\s+me\s+more|say\s+more|(?:in\s+)?more\s+detail(?:s)?|elaborate|expand\s+on\s+that)$/i,
    build: () => ({ type: 'more-detail' }),
  },
  // Chinese variants — matched against a whitespace-stripped utterance since
  // spoken Chinese transcripts carry no word spacing.
  // Suffix-first: 切换到工作区codey / 切换到workspace codey // lint-allow-non-english
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?(?:工作区|工作空间)(.+)$/, // lint-allow-non-english
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?workspace(.+)$/i, // lint-allow-non-english
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  // Name-first: 切换到codey工作区 / 切换到codey workspace // lint-allow-non-english
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?(.+?)(?:工作区|工作空间)$/, // lint-allow-non-english
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:切换|切到|跳转|转到)(?:到)?(.+?)workspace$/i, // lint-allow-non-english
    build: (m) => ({ type: 'switch-workspace', workspace: m[1].trim() }),
  },
  {
    regex: /^(?:(?:查看|获取|检查|看看|念)?(?:一下)?(?:我的)?通知(?:有哪些|是什么)?|通知)$/, // lint-allow-non-english
    build: () => ({ type: 'list-notifications' }),
  },
  // 有什么通知 / 有没有新通知 / 有哪些通知吗 // lint-allow-non-english
  {
    regex: /^(?:有什么|有哪些|有没有|有无)(?:新的?)?(?:未读)?通知(?:吗)?$/, // lint-allow-non-english
    build: () => ({ type: 'list-notifications' }),
  },
  {
    regex: /^(?:列出|显示|查看)(?:我的)?(?:所有)?(?:工作区|工作空间)(?:列表)?$/, // lint-allow-non-english
    build: () => ({ type: 'list-workspaces' }),
  },
  // 说详细点 / 再详细一点 / 详细说说 / 更详细一些 // lint-allow-non-english
  {
    regex: /^(?:再|请)?(?:说|讲)?(?:得|的)?(?:更)?详细(?:一?点|一?些)?(?:说说|讲讲)?$/, // lint-allow-non-english
    build: () => ({ type: 'more-detail' }),
  },
  // 展开讲讲 / 多说一点 // lint-allow-non-english
  {
    regex: /^(?:展开(?:讲讲|说说|说一?下)|多说(?:一?点|一?些))$/, // lint-allow-non-english
    build: () => ({ type: 'more-detail' }),
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
    .replace(/[.!?。!?，,]+$/, '') // lint-allow-non-english
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
