// "@worker" mentions in a chat message.
//
// A message may address workers directly: `@alice fix the tests`, or
// `@alice @bob ship the login page`. This module only recognises the tokens;
// the gateway decides what to run. Pure so it can be unit-tested alone.

export interface WorkerMentions {
  /** Distinct workers in order of first mention, lower-cased. */
  workers: string[];
  /**
   * The message with each recognised mention reduced to the bare name, so
   * "@alice writes tests" reads as "alice writes tests" to the workers.
   */
  task: string;
}

// A mention starts at the beginning of the text or after whitespace, so an
// email address never counts. The optional `worker:` prefix is the namespaced
// form the Mac composer inserts, mirroring `@skill:x`. Trailing punctuation is
// matched separately so "@alice," still resolves to "alice".
const MENTION_RE = /(^|\s)@(worker:)?([^\s@,:;!?.]+)/g;

/**
 * Find the workers a message addresses. `isWorker` answers whether a name is a
 * known worker; anything it rejects is left untouched in the text (it may be a
 * file path or a skill reference).
 */
export function parseWorkerMentions(text: string, isWorker: (name: string) => boolean): WorkerMentions {
  const workers: string[] = [];
  const seen = new Set<string>();
  const task = text.replace(MENTION_RE, (whole, lead: string, _ns: string | undefined, name: string) => {
    if (!isWorker(name)) return whole;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      workers.push(key);
    }
    return `${lead}${name}`;
  });
  return { workers, task };
}
