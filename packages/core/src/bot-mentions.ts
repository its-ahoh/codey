// "@bot" and "@team" mentions in a chat message.
//
// A message may address bots directly: `@alice fix the tests`, or
// `@alice @bob ship the login page`. It may also name a configured team:
// `@team:release cut 1.2.0`. This module only recognises the tokens; the
// gateway decides what to run. Pure so it can be unit-tested alone.

export interface BotMentions {
  /** Distinct bots in order of first mention, lower-cased. */
  bots: string[];
  /** Distinct teams in order of first mention, lower-cased. */
  teams: string[];
  /**
   * The message with each recognised mention reduced to the bare name, so
   * "@alice writes tests" reads as "alice writes tests" to the bots.
   */
  task: string;
}

// A mention starts at the beginning of the text or after whitespace, so an
// email address never counts. The optional `bot:`/`team:` prefix is the
// namespaced form the Mac composer inserts, mirroring `@skill:x`. Trailing
// punctuation is matched separately so "@alice," still resolves to "alice".
const MENTION_RE = /(^|\s)@(bot:|team:)?([^\s@,:;!?.]+)/g;

/**
 * Find the bots and teams a message addresses. `isBot`/`isTeam` answer
 * whether a name is known; anything they reject is left untouched in the text
 * (it may be a file path or a skill reference). A bare `@name` that is both a
 * bot and a team resolves to the bot — the namespaced form disambiguates.
 */
export function parseBotMentions(
  text: string,
  isBot: (name: string) => boolean,
  isTeam: (name: string) => boolean = () => false,
): BotMentions {
  const bots: string[] = [];
  const teams: string[] = [];
  const seenBot = new Set<string>();
  const seenTeam = new Set<string>();
  const task = text.replace(MENTION_RE, (whole, lead: string, ns: string | undefined, name: string) => {
    const key = name.toLowerCase();
    // The namespace, when present, pins which list the name must resolve in.
    const asTeam = ns === 'team:' ? true : ns === 'bot:' ? false : !isBot(name) && isTeam(name);
    if (asTeam) {
      if (!isTeam(name)) return whole;
      if (!seenTeam.has(key)) { seenTeam.add(key); teams.push(key); }
    } else {
      if (!isBot(name)) return whole;
      if (!seenBot.has(key)) { seenBot.add(key); bots.push(key); }
    }
    return `${lead}${name}`;
  });
  return { bots, teams, task };
}
